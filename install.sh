#!/usr/bin/env bash
#
# install.sh — Installation automatique d'OpenLesmillsCinema sur Debian 13
# (cible : Dell Wyse 5070, Intel Gemini Lake). Réf. plan de construction, Lot 14.
#
# Usage :
#   git clone <repo> OpenLesmillsCinema
#   cd OpenLesmillsCinema
#   sudo ./install.sh
#
# Ce script est idempotent : le relancer après un `git pull` met à jour les
# dépendances, reconstruit le frontend et redémarre les services proprement.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Préambule : contexte, utilisateur cible, chemins
# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
    echo "Ce script doit être lancé avec sudo : sudo ./install.sh" >&2
    exit 1
fi

if [[ -z "${SUDO_USER:-}" || "${SUDO_USER}" == "root" ]]; then
    echo "Erreur : lance ce script via 'sudo ./install.sh' depuis ton compte utilisateur normal," >&2
    echo "pas en étant déjà connecté en root (SUDO_USER introuvable ou égal à root)." >&2
    exit 1
fi

TARGET_USER="${SUDO_USER}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${REPO_DIR}/backend"
FRONTEND_DIR="${REPO_DIR}/frontend"
VENV_DIR="${BACKEND_DIR}/.venv"
CONFIG_DIR="/etc/openlesmillscinema"
CONFIG_FILE="${CONFIG_DIR}/config.toml"
SERVICE_PORT=8000
KIOSK_URL="http://127.0.0.1:${SERVICE_PORT}/kiosk"

log()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m!! $*\033[0m" >&2; }

log "Installation d'OpenLesmillsCinema"
echo "  Dépôt        : ${REPO_DIR}"
echo "  Utilisateur  : ${TARGET_USER}"

if [[ -r /etc/os-release ]]; then
    . /etc/os-release
    if [[ "${VERSION_CODENAME:-}" != "trixie" ]]; then
        warn "Ce script est prévu pour Debian 13 (trixie). Système détecté : ${PRETTY_NAME:-inconnu}. On continue quand même."
    fi
fi

# ---------------------------------------------------------------------------
# 1. Dépendances système (réf. Lot 0 §0.4-0.5, NF5)
# ---------------------------------------------------------------------------

log "Installation des paquets système (apt)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    chromium \
    xinit \
    xserver-xorg \
    x11-xserver-utils \
    unclutter \
    vainfo \
    curl \
    ca-certificates \
    gnupg

# Pilote VAAPI Intel (décodage matériel H.264/HEVC, réf. Lot 0 §3.3/NF2).
# La variante non-free couvre plus de profils (HEVC Main10) ; on retombe sur
# la variante libre si le dépôt non-free n'est pas activé sur la machine.
if ! apt-get install -y --no-install-recommends intel-media-va-driver-non-free 2>/dev/null; then
    warn "intel-media-va-driver-non-free indisponible (dépôt 'non-free' non activé ?)."
    warn "Installation de la variante libre à la place — le support HEVC 10 bits peut être limité."
    warn "Pour le pilote complet : active 'non-free' dans /etc/apt/sources.list puis relance ce script."
    apt-get install -y --no-install-recommends intel-media-va-driver || true
fi

# Node.js (build du frontend Next.js en export statique, réf. §4.1) : la
# version des dépôts Debian est souvent trop ancienne pour Next.js récent,
# on installe donc une LTS actuelle via NodeSource si besoin.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//;s/\..*//')" -lt 20 ]]; then
    log "Installation de Node.js 22.x LTS (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
else
    log "Node.js déjà présent : $(node -v)"
fi

# ---------------------------------------------------------------------------
# 2. Groupes système pour l'accès GPU (réf. Lot 0, piège #2)
# ---------------------------------------------------------------------------

log "Ajout de ${TARGET_USER} aux groupes render/video (accès /dev/dri)"
usermod -aG render,video "${TARGET_USER}"

# Autorise Xorg à démarrer depuis une session systemd (pas une console physique
# classique) : nécessaire car le kiosk est lancé par un service, pas un login
# interactif standard.
if [[ -f /etc/X11/Xwrapper.config ]]; then
    if grep -q '^allowed_users=' /etc/X11/Xwrapper.config; then
        sed -i 's/^allowed_users=.*/allowed_users=anybody/' /etc/X11/Xwrapper.config
    else
        echo 'allowed_users=anybody' >> /etc/X11/Xwrapper.config
    fi
else
    printf 'allowed_users=anybody\nneeds_root_rights=yes\n' > /etc/X11/Xwrapper.config
fi

# ---------------------------------------------------------------------------
# 3. Backend Python (réf. Lot 1 §1.2-1.4)
# ---------------------------------------------------------------------------

log "Environnement virtuel Python + dépendances backend"
if [[ ! -d "${VENV_DIR}" ]]; then
    sudo -u "${TARGET_USER}" python3 -m venv "${VENV_DIR}"
fi
sudo -u "${TARGET_USER}" "${VENV_DIR}/bin/pip" install --upgrade pip -q
sudo -u "${TARGET_USER}" "${VENV_DIR}/bin/pip" install -r "${BACKEND_DIR}/requirements.txt" -q

# ---------------------------------------------------------------------------
# 4. Frontend Next.js — build statique (réf. §4.1)
# ---------------------------------------------------------------------------

log "Build du frontend (npm install && npm run build)"
sudo -u "${TARGET_USER}" bash -c "cd '${FRONTEND_DIR}' && npm install --no-audit --no-fund && npm run build"

if [[ ! -d "${FRONTEND_DIR}/out" ]]; then
    echo "Erreur : le build frontend n'a pas produit de dossier out/. Abandon." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 5. Configuration centralisée de production (réf. F7.4)
# ---------------------------------------------------------------------------

log "Écriture de la configuration de production : ${CONFIG_FILE}"
mkdir -p "${CONFIG_DIR}"
mkdir -p "${REPO_DIR}/data/videos" "${REPO_DIR}/data/watched" "${REPO_DIR}/data/thumbnails"
chown -R "${TARGET_USER}:${TARGET_USER}" "${REPO_DIR}/data"

cat > "${CONFIG_FILE}" <<EOF
# Configuration de production OpenLesmillsCinema — générée par install.sh le $(date -Idate).
# Modifiable à la main ; relance 'sudo systemctl restart openlesmillscinema-backend'
# après toute modification pour l'appliquer.

[database]
database_url = "sqlite:///${REPO_DIR}/data/database.db"

[media]
media_dir = "${REPO_DIR}/data/videos"
watch_dir = "${REPO_DIR}/data/watched"
thumbnails_dir = "${REPO_DIR}/data/thumbnails"

[server]
host = "0.0.0.0"
port = ${SERVICE_PORT}

[playback]
wait_time_between_courses = 10
countdown_seconds = 5
volume_default = 100
EOF

# ---------------------------------------------------------------------------
# 6. Script de contrôle unique (réf. tâche 14.1)
# ---------------------------------------------------------------------------

log "Installation du script de contrôle 'openlesmillscinema'"
cat > /usr/local/bin/openlesmillscinema <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SERVICES=(openlesmillscinema-backend.service openlesmillscinema-kiosk.service)

case "${1:-}" in
    start)   sudo systemctl start "${SERVICES[@]}" ;;
    stop)    sudo systemctl stop "${SERVICES[@]}" ;;
    restart) sudo systemctl restart "${SERVICES[@]}" ;;
    status)  systemctl status "${SERVICES[@]}" --no-pager ;;
    logs)    journalctl -u openlesmillscinema-backend -u openlesmillscinema-kiosk -f ;;
    *)
        echo "Usage: openlesmillscinema {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
EOF
chmod +x /usr/local/bin/openlesmillscinema

# ---------------------------------------------------------------------------
# 7. Unité systemd — backend (réf. tâche 14.2/14.3, F7.2)
# ---------------------------------------------------------------------------

log "Installation de l'unité systemd openlesmillscinema-backend.service"
cat > /etc/systemd/system/openlesmillscinema-backend.service <<EOF
[Unit]
Description=OpenLesmillsCinema - Backend FastAPI
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
WorkingDirectory=${BACKEND_DIR}
ExecStart=${VENV_DIR}/bin/uvicorn app.main:app --host 0.0.0.0 --port ${SERVICE_PORT}
Restart=always
RestartSec=2
# Reprise après coupure électrique (réf. F7.3) : démarrage automatique au boot
# via [Install] ci-dessous + Restart=always pour toute panne en cours de vie.

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 8. Unité systemd — kiosk Chromium (réf. tâche 14.4, Lot 0 §3.3)
# ---------------------------------------------------------------------------

log "Configuration du kiosk Chromium (X11 dédié, sans display manager)"

CHROMIUM_BIN="/usr/lib/chromium/chromium"
if [[ ! -x "${CHROMIUM_BIN}" ]]; then
    warn "${CHROMIUM_BIN} introuvable, utilisation de /usr/bin/chromium à la place."
    warn "Attention (réf. Lot 0) : le wrapper Debian charge plasma-browser-integration,"
    warn "à désinstaller si le kiosk se bloque en environnement non-Plasma."
    CHROMIUM_BIN="/usr/bin/chromium"
fi

cat > "${CONFIG_DIR}/kiosk-xinitrc" <<EOF
#!/bin/sh
# Généré par install.sh — lancé par Xorg au démarrage de la session kiosk.

# Pas de mise en veille ni d'écran noir sur l'écran cinéma.
xset s off
xset -dpms
xset s noblank

# Masque le curseur de souris (pas d'interaction locale attendue).
if command -v unclutter >/dev/null 2>&1; then
    unclutter -idle 0.1 -root &
fi

# Flags VAAPI validés au Lot 0 (§3.3) — à re-vérifier après install via
# chrome://gpu et 'intel_gpu_top' (cf. rappel affiché en fin de script).
exec ${CHROMIUM_BIN} \\
    --kiosk "${KIOSK_URL}" \\
    --no-first-run \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-session-crashed-bubble \\
    --disable-pinch \\
    --overscroll-history-navigation=0 \\
    --autoplay-policy=no-user-gesture-required \\
    --enable-features=AcceleratedVideoDecodeLinuxGL \\
    --use-gl=egl \\
    --start-fullscreen \\
    --check-for-update-interval=31536000
EOF
chmod +x "${CONFIG_DIR}/kiosk-xinitrc"

cat > /etc/systemd/system/openlesmillscinema-kiosk.service <<EOF
[Unit]
Description=OpenLesmillsCinema - Kiosk Chromium (écran cinéma)
After=openlesmillscinema-backend.service
Requires=openlesmillscinema-backend.service
Conflicts=getty@tty1.service

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
UtmpMode=user
Restart=always
RestartSec=2
ExecStart=/usr/bin/xinit ${CONFIG_DIR}/kiosk-xinitrc -- :0 vt1 -nolisten tcp

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 9. Activation des services
# ---------------------------------------------------------------------------

log "Activation et démarrage des services"
systemctl daemon-reload
systemctl enable --now openlesmillscinema-backend.service
systemctl enable --now openlesmillscinema-kiosk.service

# ---------------------------------------------------------------------------
# 10. Résumé
# ---------------------------------------------------------------------------

sleep 2
log "Installation terminée"
echo "  Interface d'administration : http://127.0.0.1:${SERVICE_PORT}  (et http://<IP-du-Wyse>:${SERVICE_PORT} depuis le LAN)"
echo "  Écran cinéma (kiosk)        : ${KIOSK_URL}"
echo "  Config de production        : ${CONFIG_FILE}"
echo "  Contrôle des services       : openlesmillscinema {start|stop|restart|status|logs}"
echo
systemctl --no-pager status openlesmillscinema-backend.service openlesmillscinema-kiosk.service || true
echo
warn "L'appartenance aux groupes render/video ne s'applique qu'aux nouvelles sessions :"
warn "un redémarrage complet de la machine est recommandé avant la première recette."
warn "Après redémarrage, revérifie le décodage matériel comme au Lot 0 :"
warn "  vainfo   (doit lister les profils H.264/HEVC avec le pilote iHD)"
warn "  chrome://gpu dans le kiosk, et 'intel_gpu_top' pendant une lecture"
