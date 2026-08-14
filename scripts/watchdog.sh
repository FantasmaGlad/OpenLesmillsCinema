#!/usr/bin/env bash
#
# watchdog.sh — Chien de garde de santé de Bobine.
#
# Exécuté périodiquement par `bobine-watchdog.timer` (en root) : il consomme le
# point de contrôle `/api/health` du backend et redémarre tout composant mort.
# Complète `Restart=always` de systemd, qui ne couvre QUE la mort du *processus*
# — pas les défaillances *logiques* (backend vivant mais Redis injoignable ou
# base verrouillée, ou Chromium gelé alors que l'unité kiosk reste "active").
#
#   1. Backend + Redis : si /api/health ne répond pas 200, on s'assure que Redis
#      tourne puis on redémarre le backend.
#   2. Kiosque Chromium : si le service kiosk est activé mais qu'aucun processus
#      Chromium n'est présent (crash/gel de X), on redémarre bobine-kiosk.
#
# Idempotent et silencieux quand tout va bien ; chaque action est journalisée
# (journal systemd via `logger`, tag "bobine-watchdog").
set -u

HEALTH_URL="http://127.0.0.1:8000/api/health"

log() { logger -t bobine-watchdog "$*" 2>/dev/null || true; }

# 1) Backend + Redis ---------------------------------------------------------
code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "${HEALTH_URL}" 2>/dev/null || echo 000)"
if [ "${code}" != "200" ]; then
    log "sante backend degradee (http=${code}) : verification de Redis puis redemarrage du backend"
    systemctl is-active --quiet redis-server || systemctl restart redis-server
    systemctl restart bobine-backend.service
fi

# 2) Kiosque Chromium --------------------------------------------------------
# Seulement si le service kiosk est censé tourner (pas en mode --no-kiosk).
if systemctl is-enabled --quiet bobine-kiosk.service 2>/dev/null; then
    if ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then
        log "aucun processus Chromium kiosque detecte : redemarrage de bobine-kiosk"
        systemctl restart bobine-kiosk.service
    fi
fi
