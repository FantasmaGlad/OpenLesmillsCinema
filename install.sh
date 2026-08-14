#!/usr/bin/env bash
#
# install.sh — installateur tout-en-un d'Bobine
# Cible par défaut : Debian 13 (trixie) sur Dell Wyse 5070, Intel Gemini Lake.
#
# Usage rapide :
#   git clone <repo> Bobine && cd Bobine
#   sudo ./install.sh                 # installation complète (kiosk + backend)
#   sudo ./install.sh --help          # toutes les options
#
# Idempotent : le relancer après un 'git pull' met à jour les dépendances,
# reconstruit le frontend et redémarre les services proprement.
#
set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_VERSION="2.0"

# ============================================================================
# 0. Affichage : couleurs, symboles, aide, arguments
#    (tout ce bloc doit fonctionner sans root, pour que --help reste utilisable)
# ============================================================================

if [[ -t 1 ]] && [[ "${NO_COLOR:-}" != "1" ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
    BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
    RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
    BLUE=$(tput setaf 4); CYAN=$(tput setaf 6)
else
    BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""
fi

ICON_OK="${GREEN}✓${RESET}"
ICON_FAIL="${RED}✗${RESET}"
ICON_WARN="${YELLOW}⚠${RESET}"
ICON_SKIP="${DIM}⤫${RESET}"
ICON_INFO="${BLUE}→${RESET}"

banner() {
    printf '\n%s%s  Bobine%s %s· installateur v%s%s\n' "$BOLD" "$CYAN" "$RESET" "$DIM" "$SCRIPT_VERSION" "$RESET"
    printf '%s  Debian 13 (trixie) · Dell Wyse 5070 · FastAPI + Next.js%s\n' "$DIM" "$RESET"
}

usage() {
    cat <<EOF
${BOLD}${SCRIPT_NAME}${RESET} — installateur tout-en-un d'Bobine (v${SCRIPT_VERSION})

${BOLD}USAGE${RESET}
  sudo ./${SCRIPT_NAME} [options]

${BOLD}OPTIONS${RESET}
  -h, --help          Affiche cette aide et quitte
  -y, --yes           Ne demande aucune confirmation (mode non-interactif)
      --dry-run       N'applique aucun changement : affiche ce qui serait fait
      --no-kiosk      Installation "serveur" : backend seul, sans Chromium/X11/audio
                        (pour un poste de dev ou un serveur distinct de l'écran câblé)
      --skip-packages Ne touche pas aux paquets apt (suppose les dépendances système déjà en place)
      --skip-build    Ne reconstruit pas le frontend (suppose frontend/out déjà à jour)
      --check         Diagnostic de l'installation existante, sans rien modifier
      --uninstall     Arrête, désactive et retire tout ce que ce script a installé
      --purge         Avec --uninstall : retire aussi venv/, node_modules/, frontend/out/ et la config
      --purge-data    Avec --uninstall --purge : retire EN PLUS les médias importés (destructif, confirmation requise)
  -v, --verbose       Affiche la sortie complète des commandes normalement silencieuses

${BOLD}EXEMPLES${RESET}
  sudo ./${SCRIPT_NAME}                       Installation complète (Wyse/kiosk)
  sudo ./${SCRIPT_NAME} --no-kiosk            Backend seul, sur un serveur ou un poste de dev
  sudo ./${SCRIPT_NAME} --skip-packages       Réinstalle après un 'git pull' sans retoucher apt
  sudo ./${SCRIPT_NAME} --dry-run             Prévisualise toutes les actions sans rien changer
  sudo ./${SCRIPT_NAME} --check               Vérifie l'état des services et affiche un résumé
  sudo ./${SCRIPT_NAME} --uninstall --purge   Désinstalle complètement (conserve les médias importés)

Journal complet de chaque exécution : /var/log/bobine/install-*.log
EOF
}

DRY_RUN=false
ASSUME_YES=false
NO_KIOSK=false
SKIP_PACKAGES=false
SKIP_BUILD=false
DO_CHECK=false
DO_UNINSTALL=false
DO_PURGE=false
DO_PURGE_DATA=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -y|--yes) ASSUME_YES=true ;;
        --dry-run) DRY_RUN=true ;;
        --no-kiosk) NO_KIOSK=true ;;
        --skip-packages) SKIP_PACKAGES=true ;;
        --skip-build) SKIP_BUILD=true ;;
        --check) DO_CHECK=true ;;
        --uninstall) DO_UNINSTALL=true ;;
        --purge) DO_PURGE=true ;;
        --purge-data) DO_PURGE_DATA=true ;;
        -v|--verbose) VERBOSE=true ;;
        *) echo "Option inconnue : $1" >&2; echo; usage; exit 1 ;;
    esac
    shift
done

log()  { printf '\n%s%s▸%s %s\n' "$BOLD" "$CYAN" "$RESET" "$*"; }
ok()   { printf '  %s %s\n' "$ICON_OK" "$*"; }
warn() { printf '  %s %s%s%s\n' "$ICON_WARN" "$YELLOW" "$*" "$RESET" >&2; }
err()  { printf '  %s %s%s%s\n' "$ICON_FAIL" "$RED" "$*" "$RESET" >&2; }

confirm() {
    $ASSUME_YES && return 0
    local reply
    read -r -p "$(printf '%s%s%s [o/N] ' "$YELLOW" "$1" "$RESET")" reply </dev/tty || return 1
    [[ "$reply" =~ ^[oOyY]$ ]]
}

# Exécute une commande "atomique" en respectant --dry-run (ne l'affiche qu'en
# le préfixant, sans l'exécuter, plutôt que de dupliquer chaque action système
# derrière un if/else répété à chaque appel).
run() {
    if $DRY_RUN; then
        printf '  %s[dry-run]%s %s\n' "$DIM" "$RESET" "$*"
    else
        "$@"
    fi
}

# Écrit (ou tronque) un fichier depuis un heredoc, en respectant --dry-run.
write_file() {
    if $DRY_RUN; then
        printf '  %s[dry-run]%s écrirait %s\n' "$DIM" "$RESET" "$1"
        cat >/dev/null
    else
        cat >"$1"
    fi
}

# Idem en ajout (deuxième moitié d'un fichier généré en deux temps, ex.
# kiosk-xinitrc : en-tête interpolée puis corps littéral).
append_file() {
    if $DRY_RUN; then
        cat >/dev/null
    else
        cat >>"$1"
    fi
}

STEP_TOTAL=13
STEP_CUR=0
STEP_START_TS=0
CURRENT_STEP_TITLE=""

step() {
    STEP_CUR=$((STEP_CUR + 1))
    STEP_START_TS=$SECONDS
    CURRENT_STEP_TITLE="$*"
    printf '\n%s┃%s %s[%d/%d]%s %s%s%s\n' "$CYAN" "$RESET" "$DIM" "$STEP_CUR" "$STEP_TOTAL" "$RESET" "$BOLD" "$*" "$RESET"
}
step_done() { printf '  %s (%ss)\n' "$ICON_OK" "$((SECONDS - STEP_START_TS))"; }
step_skip() { printf '  %s ignoré — %s\n' "$ICON_SKIP" "$*"; }

on_error() {
    local rc=$?
    echo
    err "Échec à l'étape [${STEP_CUR}/${STEP_TOTAL}] ${CURRENT_STEP_TITLE} (code ${rc})."
    [[ -n "${LOG_FILE:-}" ]] && err "Journal complet : ${LOG_FILE}"
    exit "$rc"
}
trap on_error ERR

# ============================================================================
# 1. Vérifications préalables
# ============================================================================

if [[ $EUID -ne 0 ]]; then
    banner
    echo
    err "Ce script doit être lancé avec sudo : sudo ./${SCRIPT_NAME} (ou --help)"
    exit 1
fi

if [[ -z "${SUDO_USER:-}" || "${SUDO_USER}" == "root" ]]; then
    banner
    echo
    err "Lance ce script via 'sudo ./${SCRIPT_NAME}' depuis ton compte utilisateur normal,"
    err "pas en étant déjà connecté en root (SUDO_USER introuvable ou égal à root)."
    exit 1
fi

TARGET_USER="${SUDO_USER}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${REPO_DIR}/backend"
FRONTEND_DIR="${REPO_DIR}/frontend"
VENV_DIR="${BACKEND_DIR}/.venv"
CONFIG_DIR="/etc/bobine"
CONFIG_FILE="${CONFIG_DIR}/config.toml"
SERVICE_PORT=8000
KIOSK_URL="http://127.0.0.1:${SERVICE_PORT}/kiosk"
UNITS=(bobine-backend bobine-kiosk bobine-audio-guard bobine-redirect bobine-watchdog)

LOG_DIR="/var/log/bobine"
mkdir -p "${LOG_DIR}" 2>/dev/null || LOG_DIR="/tmp"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1

# ---- Dispatch : désinstallation ----
if $DO_UNINSTALL; then
    banner
    log "Désinstallation d'Bobine"
    echo "  Dépôt   : ${REPO_DIR}"
    echo "  Journal : ${LOG_FILE}"

    confirm "Arrêter et retirer tous les services Bobine ?" || { echo "Annulé."; exit 0; }

    for unit in "${UNITS[@]}"; do
        if systemctl list-unit-files "${unit}.service" &>/dev/null; then
            run systemctl disable --now "${unit}.service" 2>/dev/null || true
            run rm -f "/etc/systemd/system/${unit}.service"
            ok "${unit}.service retiré"
        else
            step_skip "${unit}.service non installé"
        fi
    done
    # Le chien de garde est piloté par un TIMER (l'unité .service ci-dessus est
    # déclenchée par lui) : retirer aussi le timer.
    run systemctl disable --now bobine-watchdog.timer 2>/dev/null || true
    run rm -f /etc/systemd/system/bobine-watchdog.timer
    run systemctl daemon-reload

    run rm -f /etc/sudoers.d/bobine
    run rm -f /etc/modprobe.d/bobine-audio.conf
    run rm -f /etc/wireplumber/wireplumber.conf.d/51-fix-jack-autoport.conf
    run rm -f /etc/systemd/system/powertop.service.d/10-audio-nopowersave.conf
    run rm -f /usr/local/bin/bobine
    run rm -f /usr/local/sbin/bobine-uninstall
    if command -v nft >/dev/null 2>&1; then
        run nft delete table ip olmc_redirect 2>/dev/null || true
    fi
    ok "Intégrations système (sudoers, audio, redirection, commande CLI) retirées."

    if $DO_PURGE; then
        warn "Suppression de la configuration, de l'environnement Python et du build frontend."
        run rm -rf "${CONFIG_DIR}"
        run rm -rf "${VENV_DIR}"
        run rm -rf "${FRONTEND_DIR}/out" "${FRONTEND_DIR}/node_modules"
        ok "Configuration, venv et build frontend retirés."

        if $DO_PURGE_DATA; then
            if confirm "${RED}Supprimer aussi les médias importés (${REPO_DIR}/data et l'ancien ${REPO_DIR}/backend/data) ? IRRÉVERSIBLE.${RESET}"; then
                run rm -rf "${REPO_DIR}/data"
                # Ancien emplacement historique (réf. §10.1 cahier des charges
                # Radio) : audio/fonds/logs pouvaient y résider avant unification
                # — sans cette ligne ils survivaient à un --purge-data (orphelins).
                run rm -rf "${REPO_DIR}/backend/data"
                warn "Médias importés supprimés (nouvel et ancien emplacement)."
            else
                echo "  Médias conservés (${REPO_DIR}/data)."
            fi
        fi
    else
        echo "  ${ICON_INFO} Configuration (${CONFIG_DIR}), venv et données conservées — relance avec --purge pour les retirer aussi."
    fi

    log "Désinstallation terminée."
    exit 0
fi

# ---- Dispatch : diagnostic seul ----
BOX_WIDTH=70
box_line() {
    local text="$1" pad
    pad=$((BOX_WIDTH - 4 - ${#text}))
    (( pad < 0 )) && pad=0
    printf '%s│%s %s%*s%s│%s\n' "$DIM" "$RESET" "$text" "$pad" "" "$DIM" "$RESET"
}
box_rule() { printf '%s%s%s%s\n' "$DIM" "$1" "$(printf '─%.0s' $(seq 1 $((BOX_WIDTH - 2))))" "$2$RESET"; }
box_top()    { box_rule "┌" "┐"; }
box_mid()    { box_rule "├" "┤"; }
box_bottom() { box_rule "└" "┘"; }

do_check() {
    banner
    log "Diagnostic de l'installation"

    local port="${SERVICE_PORT}"
    if [[ -f "${CONFIG_FILE}" ]]; then
        port=$(grep -E '^port' "${CONFIG_FILE}" 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/' || echo "${SERVICE_PORT}")
        [[ -z "$port" ]] && port="${SERVICE_PORT}"
    fi

    echo
    box_top
    box_line "  Bobine — diagnostic"
    box_mid
    for unit in "${UNITS[@]}"; do
        if systemctl list-unit-files "${unit}.service" &>/dev/null; then
            if systemctl is-active --quiet "${unit}.service"; then
                box_line "  ✓ ${unit}  actif"
            else
                box_line "  ✗ ${unit}  $(systemctl is-active "${unit}.service" 2>/dev/null || echo inconnu)"
            fi
        else
            box_line "  ⤫ ${unit}  non installé"
        fi
    done
    box_mid
    if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
        box_line "  ✓ API backend répond (port ${port})"
    else
        box_line "  ✗ API backend injoignable (port ${port})"
    fi
    if [[ -d "${FRONTEND_DIR}/out" ]]; then
        box_line "  ✓ build frontend présent ($(date -r "${FRONTEND_DIR}/out" '+%d/%m %H:%M' 2>/dev/null || echo date-inconnue))"
    else
        box_line "  ✗ build frontend absent"
    fi
    [[ -d "${VENV_DIR}" ]] && box_line "  ✓ environnement Python présent" || box_line "  ✗ environnement Python absent"
    if git -C "${REPO_DIR}" rev-parse --short HEAD &>/dev/null; then
        local rev dirty extra=""
        rev=$(git -C "${REPO_DIR}" rev-parse --short HEAD)
        dirty=$(git -C "${REPO_DIR}" status --porcelain 2>/dev/null | wc -l)
        [[ "$dirty" -gt 0 ]] && extra="  (+${dirty} fichiers modifiés)"
        box_line "  → révision ${rev}${extra}"
    fi
    box_bottom
    echo
    exit 0
}
$DO_CHECK && do_check

# ============================================================================
# Installation
# ============================================================================

banner
echo
echo "  Dépôt        : ${REPO_DIR}"
echo "  Utilisateur  : ${TARGET_USER}"
echo "  Journal      : ${LOG_FILE}"
FLAGS_ACTIVE=""
$DRY_RUN && FLAGS_ACTIVE+="dry-run "
$NO_KIOSK && FLAGS_ACTIVE+="no-kiosk "
$SKIP_PACKAGES && FLAGS_ACTIVE+="skip-packages "
$SKIP_BUILD && FLAGS_ACTIVE+="skip-build "
$ASSUME_YES && FLAGS_ACTIVE+="non-interactif "
[[ -n "$FLAGS_ACTIVE" ]] && echo "  Options      : ${YELLOW}${FLAGS_ACTIVE}${RESET}"

if systemctl list-unit-files bobine-backend.service &>/dev/null; then
    echo "  Mode         : mise à jour d'une installation existante"
else
    echo "  Mode         : nouvelle installation"
fi

if [[ -r /etc/os-release ]]; then
    . /etc/os-release
    if [[ "${VERSION_CODENAME:-}" != "trixie" ]]; then
        warn "Ce script est prévu pour Debian 13 (trixie). Système détecté : ${PRETTY_NAME:-inconnu}. On continue quand même."
    fi
fi

AVAIL_KB=$(df --output=avail -k "${REPO_DIR}" 2>/dev/null | tail -1 | tr -d ' ')
if [[ -n "${AVAIL_KB:-}" ]] && (( AVAIL_KB < 2 * 1024 * 1024 )); then
    warn "Moins de 2 Go disponibles sur $(df --output=target "${REPO_DIR}" | tail -1 | tr -d ' ') — l'import de vidéos réclame nettement plus d'espace."
fi

# ---------------------------------------------------------------------------
step "Paquets système (apt)"
# ---------------------------------------------------------------------------
if $SKIP_PACKAGES; then
    step_skip "--skip-packages"
else
    export DEBIAN_FRONTEND=noninteractive
    run apt-get update -qq

    run apt-get install -y --no-install-recommends \
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
        gnupg \
        redis-server \
        avahi-daemon \
        nftables

    # Redis sert de bus d'état partagé entre les 4 workers uvicorn : synchronisation
    # du PlaybackManager et diffusion WebSocket inter-workers. Empreinte mémoire
    # négligeable (~5 Mo au repos) sur le Wyse 5070.
    run systemctl enable --now redis-server
    ok "redis-server actif"

    # Pilote VAAPI Intel (décodage matériel H.264/HEVC). La variante non-free
    # couvre plus de profils (HEVC Main10) ; repli sur la variante libre si le
    # dépôt non-free n'est pas activé sur la machine.
    if $DRY_RUN; then
        echo "  ${DIM}[dry-run]${RESET} installerait le pilote VAAPI (non-free, repli libre si indisponible)"
    else
        if ! apt-get install -y --no-install-recommends intel-media-va-driver-non-free 2>/dev/null; then
            warn "intel-media-va-driver-non-free indisponible (dépôt 'non-free' non activé ?)."
            warn "Installation de la variante libre à la place — le support HEVC 10 bits peut être limité."
            warn "Pour le pilote complet : active 'non-free' dans /etc/apt/sources.list puis relance ce script."
            apt-get install -y --no-install-recommends intel-media-va-driver || true
        else
            ok "Pilote VAAPI Intel (non-free) installé"
        fi
    fi

    # Node.js (build du frontend Next.js en export statique) : la version des
    # dépôts Debian est souvent trop ancienne, on installe donc une LTS actuelle
    # via NodeSource si besoin.
    if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//;s/\..*//')" -lt 20 ]]; then
        if $DRY_RUN; then
            echo "  ${DIM}[dry-run]${RESET} installerait Node.js 22.x LTS (NodeSource)"
        else
            log "Installation de Node.js 22.x LTS (NodeSource)"
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
            apt-get install -y nodejs
        fi
    else
        ok "Node.js déjà présent : $(node -v)"
    fi
    step_done
fi

# ---------------------------------------------------------------------------
step "Accès GPU (groupes render/video) & Xwrapper"
# ---------------------------------------------------------------------------
if $NO_KIOSK; then
    step_skip "--no-kiosk"
else
    run usermod -aG render,video "${TARGET_USER}"
    ok "${TARGET_USER} ajouté aux groupes render/video"

    # Autorise Xorg à démarrer depuis une session systemd (pas une console
    # physique classique) : nécessaire car le kiosk est lancé par un service,
    # pas un login interactif standard.
    if $DRY_RUN; then
        echo "  ${DIM}[dry-run]${RESET} configurerait /etc/X11/Xwrapper.config (allowed_users=anybody)"
    else
        if [[ -f /etc/X11/Xwrapper.config ]]; then
            if grep -q '^allowed_users=' /etc/X11/Xwrapper.config; then
                sed -i 's/^allowed_users=.*/allowed_users=anybody/' /etc/X11/Xwrapper.config
            else
                echo 'allowed_users=anybody' >> /etc/X11/Xwrapper.config
            fi
        else
            printf 'allowed_users=anybody\nneeds_root_rights=yes\n' > /etc/X11/Xwrapper.config
        fi
        ok "Xwrapper.config configuré"
    fi
    step_done
fi

# ---------------------------------------------------------------------------
step "Environnement Python & dépendances backend"
# ---------------------------------------------------------------------------
if [[ ! -d "${VENV_DIR}" ]]; then
    run sudo -u "${TARGET_USER}" python3 -m venv "${VENV_DIR}"
    ok "venv créé : ${VENV_DIR}"
else
    ok "venv déjà présent : ${VENV_DIR}"
fi
PIP_QUIET="-q"; $VERBOSE && PIP_QUIET=""
run sudo -u "${TARGET_USER}" "${VENV_DIR}/bin/pip" install --upgrade pip ${PIP_QUIET}
run sudo -u "${TARGET_USER}" "${VENV_DIR}/bin/pip" install -r "${BACKEND_DIR}/requirements.txt" ${PIP_QUIET}
step_done

# ---------------------------------------------------------------------------
step "Build du frontend Next.js"
# ---------------------------------------------------------------------------
if $SKIP_BUILD; then
    step_skip "--skip-build"
    if [[ ! -d "${FRONTEND_DIR}/out" ]]; then
        err "frontend/out introuvable et --skip-build demandé : le backend n'aura rien à servir."
        exit 1
    fi
else
    run sudo -u "${TARGET_USER}" bash -c "cd '${FRONTEND_DIR}' && npm install --no-audit --no-fund && npm run build"
    if [[ ! -d "${FRONTEND_DIR}/out" ]] && ! $DRY_RUN; then
        err "le build frontend n'a pas produit de dossier out/. Abandon."
        exit 1
    fi
    ok "build produit dans ${FRONTEND_DIR}/out"
    step_done
fi

# ---------------------------------------------------------------------------
step "Configuration de production"
# ---------------------------------------------------------------------------
log "Écriture de ${CONFIG_FILE}"
run mkdir -p "${CONFIG_DIR}"
# Tous les dossiers média sous un unique arbre ${REPO_DIR}/data (réf. §10.1 du
# cahier des charges Radio) : avant ce correctif, seuls videos/watched/
# thumbnails étaient créés/déclarés, et audio/fonds/logs retombaient sur les
# défauts relatifs à backend/ → données éclatées sur deux arbres.
run mkdir -p \
    "${REPO_DIR}/data/videos" "${REPO_DIR}/data/watched" "${REPO_DIR}/data/thumbnails" \
    "${REPO_DIR}/data/backgrounds" "${REPO_DIR}/data/backgrounds_watched" \
    "${REPO_DIR}/data/audio" "${REPO_DIR}/data/audio_watched" \
    "${REPO_DIR}/data/radio" "${REPO_DIR}/data/radio_covers" \
    "${REPO_DIR}/data/radio_announcements" "${REPO_DIR}/data/radio_watched" \
    "${REPO_DIR}/data/logs"
run chown -R "${TARGET_USER}:${TARGET_USER}" "${REPO_DIR}/data"

write_file "${CONFIG_FILE}" <<EOF
# Configuration de production Bobine — générée par install.sh le $(date -Idate).
# Modifiable à la main ; relance 'sudo systemctl restart bobine-backend'
# après toute modification pour l'appliquer.

[database]
database_url = "sqlite:///${REPO_DIR}/data/database.db"

[media]
media_dir = "${REPO_DIR}/data/videos"
watch_dir = "${REPO_DIR}/data/watched"
thumbnails_dir = "${REPO_DIR}/data/thumbnails"
backgrounds_dir = "${REPO_DIR}/data/backgrounds"
backgrounds_watch_dir = "${REPO_DIR}/data/backgrounds_watched"
audio_dir = "${REPO_DIR}/data/audio"
audio_watch_dir = "${REPO_DIR}/data/audio_watched"
# Module Radio (réf. docs/cahier-des-charges-radio.md) : sous-système musical
# indépendant, dossiers séparés des cours audio coach.
radio_dir = "${REPO_DIR}/data/radio"
radio_covers_dir = "${REPO_DIR}/data/radio_covers"
radio_announcements_dir = "${REPO_DIR}/data/radio_announcements"
radio_watch_dir = "${REPO_DIR}/data/radio_watched"

[logs]
logs_dir = "${REPO_DIR}/data/logs"

[server]
host = "0.0.0.0"
port = ${SERVICE_PORT}

[playback]
wait_time_between_courses = 10
volume_default = 100
EOF
ok "configuration écrite"

# Convergence des installations antérieures (réf. §10.1 du cahier des charges
# Radio) : jusqu'ici audio/fonds/logs pouvaient résider sous backend/data. On
# le signale et on oriente vers le script de migration dédié (opt-in, sauvegarde
# la base avant toute réécriture, à lancer backend arrêté) plutôt que de
# relocaliser automatiquement des données de production en plein install.
if [[ -d "${REPO_DIR}/backend/data" ]]; then
    warn "Données héritées détectées dans ${REPO_DIR}/backend/data (ancien emplacement)."
    warn "Pour les unifier sous ${REPO_DIR}/data, arrête le backend puis lance :"
    warn "  ${VENV_DIR}/bin/python ${REPO_DIR}/scripts/migrate_unify_data_dirs.py --dry-run"
    warn "puis à nouveau sans --dry-run une fois le plan vérifié."
fi
step_done

# ---------------------------------------------------------------------------
step "Script de contrôle CLI 'bobine'"
# ---------------------------------------------------------------------------
write_file /usr/local/bin/bobine <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SERVICES=(bobine-backend.service bobine-kiosk.service)

case "${1:-}" in
    start)   sudo systemctl start "${SERVICES[@]}" ;;
    stop)    sudo systemctl stop "${SERVICES[@]}" ;;
    restart) sudo systemctl restart "${SERVICES[@]}" ;;
    status)  systemctl status "${SERVICES[@]}" --no-pager ;;
    logs)    journalctl -u bobine-backend -u bobine-kiosk -f ;;
    *)
        echo "Usage: bobine {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
EOF
run chmod +x /usr/local/bin/bobine
ok "commande 'bobine' installée"

# ---------------------------------------------------------------------------
step "Désinstalleur détaché (bouton « Désinstaller » de l'UI)"
# ---------------------------------------------------------------------------
# Enveloppe lancée en root (règle sudoers dédiée ci-dessous) par le backend
# quand l'utilisateur confirme la désinstallation depuis Paramètres. systemd-run
# détache l'opération dans une unité transitoire : sans cela, l'arrêt du service
# backend (déclenché par --uninstall) tuerait le script lui-même, qui tourne
# dans le même cgroup. La désinstallation elle-même reste celle, déjà testée,
# de --uninstall --purge --purge-data (services + config + app + données, sans
# toucher aux paquets apt partagés).
write_file /usr/local/sbin/bobine-uninstall <<EOF
#!/usr/bin/env bash
exec systemd-run --collect --unit=olmc-uninstall --description="Bobine uninstall" ${REPO_DIR}/install.sh --uninstall --purge --purge-data -y
EOF
run chmod +x /usr/local/sbin/bobine-uninstall
ok "désinstalleur '/usr/local/sbin/bobine-uninstall' installé"
step_done

# ---------------------------------------------------------------------------
step "Service systemd — backend FastAPI"
# ---------------------------------------------------------------------------
write_file /etc/systemd/system/bobine-backend.service <<EOF
[Unit]
Description=Bobine - Backend FastAPI
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
WorkingDirectory=${BACKEND_DIR}
ExecStart=${VENV_DIR}/bin/uvicorn app.main:app --host 0.0.0.0 --port ${SERVICE_PORT} --workers 4
Restart=always
RestartSec=2
# Reprise après coupure électrique : démarrage automatique au boot via
# [Install] ci-dessous + Restart=always pour toute panne en cours de vie.

[Install]
WantedBy=multi-user.target
EOF
ok "bobine-backend.service écrit"
step_done

# ---------------------------------------------------------------------------
step "Kiosk Chromium (écran cinéma câblé)"
# ---------------------------------------------------------------------------
if $NO_KIOSK; then
    step_skip "--no-kiosk"
else
    log "Configuration du kiosk Chromium (X11 dédié, sans display manager)"

    CHROMIUM_BIN="/usr/lib/chromium/chromium"
    if [[ ! -x "${CHROMIUM_BIN}" ]]; then
        warn "${CHROMIUM_BIN} introuvable, utilisation de /usr/bin/chromium à la place."
        warn "Le wrapper Debian charge plasma-browser-integration : à désinstaller si le kiosk se bloque en environnement non-Plasma."
        CHROMIUM_BIN="/usr/bin/chromium"
    fi

    # En-tête généré (valeurs résolues à l'installation), suivi du corps statique.
    write_file "${CONFIG_DIR}/kiosk-xinitrc" <<EOF
#!/bin/sh
# Généré par install.sh — lancé par Xorg au démarrage de la session kiosk.
CHROMIUM_BIN="${CHROMIUM_BIN}"
KIOSK_URL="${KIOSK_URL}"
EOF
    append_file "${CONFIG_DIR}/kiosk-xinitrc" <<'EOF'

# Pas de mise en veille ni d'écran noir sur l'écran cinéma.
xset s off
xset -dpms
xset s noblank

# Masque le curseur de souris (pas d'interaction locale attendue).
if command -v unclutter >/dev/null 2>&1; then
    unclutter -idle 0.1 -root &
fi

# --- Configuration de l'affichage (correctif "écran réduit au lancement") ---
# Deux causes observées sur le Wyse : (1) une sortie fantôme configurée par
# Xorg à côté de la vraie (bureau étendu 3840x1080 dont l'écran ne montre
# qu'une moitié), (2) aucun window manager ne tourne dans cette session, donc
# la demande de plein écran de Chromium (--kiosk) n'est honorée par personne
# et la fenêtre reste à sa taille par défaut. On force donc ici LA sortie
# réellement connectée à son mode préféré en 0x0, on éteint toutes les
# autres, puis on passe à Chromium une géométrie explicite.
# L'EDID d'un projecteur peut mettre quelques secondes à être lisible au
# démarrage à froid : on réessaie avant de se rabattre sur l'état courant.
OUTPUT=""
for _ in $(seq 1 15); do
    OUTPUT=$(xrandr --query | awk '/ connected/{print $1; exit}')
    [ -n "${OUTPUT}" ] && break
    sleep 1
done
if [ -n "${OUTPUT}" ]; then
    xrandr --output "${OUTPUT}" --primary --auto --pos 0x0
    for OTHER in $(xrandr --query | awk '/connected/{print $1}'); do
        [ "${OTHER}" = "${OUTPUT}" ] || xrandr --output "${OTHER}" --off
    done
fi

# Géométrie réelle de l'écran après configuration (repli 1920x1080 si illisible).
SCREEN_SIZE=$(xrandr --query | awk -F'[ ,]+' '/current/{print $8"x"$10; exit}')
case "${SCREEN_SIZE}" in
    [0-9]*x[0-9]*) ;;
    *) SCREEN_SIZE="1920x1080" ;;
esac
SCREEN_W=${SCREEN_SIZE%x*}
SCREEN_H=${SCREEN_SIZE#*x}

# Attend que le backend réponde avant de lancer Chromium : sinon la page
# d'erreur "connexion refusée" reste affichée jusqu'à intervention manuelle.
for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "${KIOSK_URL%/kiosk}/api/health" && break
    sleep 1
done

# Sécurité audio (réf. diagnostic prises jack qui hurlent) : WirePlumber/ACP
# réinitialise certains registres bruts du codec (dont 'Auto-Mute Mode') à
# leur valeur par défaut ('Disabled') à chaque activation de profil, ce qui
# annule silencieusement 'alsactl store' au boot suivant — reconstaté ici
# après plusieurs redémarrages. On le réapplique donc à chaque lancement du
# kiosk (après l'attente ci-dessus, WirePlumber a largement eu le temps de
# démarrer) plutôt que de compter sur la persistance ALSA seule.
# Démute explicite : bobine-audio-guard.service coupe
# Master/Speaker par défaut hors session kiosk, c'est ici qu'on les rouvre
# une fois prêt.
amixer -c0 sset 'Auto-Mute Mode' 'Line Out+Speaker' >/dev/null 2>&1 || true
# Volume explicite plutôt qu'un simple "unmute" (le cycle mute/unmute pouvait
# laisser le volume matériel à 0% tout en étant démuté — son coupé de façon
# non-évidente). 100% (0dB, niveau ligne de référence) sur TOUS les chemins
# de sortie : le Wyse alimente une table de mixage, c'est ELLE qui atténue —
# un niveau source réduit obligeait à pousser le gain de la table au maximum,
# ce qui est pire (bruit de fond amplifié, aucune marge). Le réglage de
# volume "utilisateur" reste disponible via les boutons de l'interface
# (volume logiciel appliqué au flux par le kiosk), indépendant de ces
# niveaux matériels de référence.
amixer -c0 sset 'Master' 100% unmute >/dev/null 2>&1 || true
amixer -c0 sset 'Speaker' 100% unmute >/dev/null 2>&1 || true
# Chemin casque/ligne (prise avant, "sortie extérieur") : géré séparément du
# haut-parleur — l'auto-port bascule dessus quand CETTE prise est branchée.
amixer -c0 sset 'Headphone+LO' 100% >/dev/null 2>&1 || true
amixer -c0 sset 'Headphone' unmute >/dev/null 2>&1 || true
# Volume logiciel PipeWire aussi à 100% : c'est le canal que pilotent les
# boutons de volume de l'interface — un plafond logiciel bas ici aurait le
# même défaut que le plafond matériel corrigé ci-dessus.
pactl set-sink-volume @DEFAULT_SINK@ 100% >/dev/null 2>&1 || true
# Chemin micro fermé (réf. "bruit strident continu même pendant la lecture") :
# la prise avant est une prise combo casque/micro (TRRS) — le codec y
# détectait un "Headset Mic" fantôme et polarisait le contact micro avec
# Capture ET Headset Mic Boost à fond (+60dB cumulés). Un câble stéréo TRS
# classique branché là court-circuite ce contact polarisé vers la masse
# audio -> bruit électrique continu injecté dans l'ampli. Aucun micro n'est
# utilisé sur ce déploiement : gains à zéro, capture coupée, et source
# d'entrée déplacée sur le micro ARRIÈRE (rien d'y branché) pour éloigner la
# polarisation du jack avant utilisé en sortie.
amixer -c0 sset 'Capture' 0% nocap >/dev/null 2>&1 || true
amixer -c0 sset 'Capture',1 0% nocap >/dev/null 2>&1 || true
amixer -c0 sset 'Headset Mic Boost' 0 >/dev/null 2>&1 || true
amixer -c0 sset 'Rear Mic Boost' 0 >/dev/null 2>&1 || true
amixer -c0 cset name='Input Source' 'Rear Mic' >/dev/null 2>&1 || true
amixer -c0 cset name='Input Source',index=1 'Rear Mic' >/dev/null 2>&1 || true

# Profil Chromium dédié et jetable, purgé à chaque lancement du kiosk :
# supprime toutes les données temporaires de chargement (cache d'une ancienne
# version du frontend après mise à jour, état de session "crashed", service
# workers). Tout est resservi par le backend local, la purge est sans coût.
KIOSK_PROFILE="/var/tmp/bobine-kiosk-profile"
rm -rf "${KIOSK_PROFILE}"

# Flags VAAPI validés à l'installation — à re-vérifier après install via
# chrome://gpu et 'intel_gpu_top' (cf. rappel affiché en fin de script).
exec ${CHROMIUM_BIN} \
    --kiosk "${KIOSK_URL}" \
    --user-data-dir="${KIOSK_PROFILE}" \
    --window-position=0,0 \
    --window-size=${SCREEN_W},${SCREEN_H} \
    --no-first-run \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --enable-features=AcceleratedVideoDecodeLinuxGL \
    --use-gl=egl \
    --start-fullscreen \
    --check-for-update-interval=31536000
EOF
    run chmod +x "${CONFIG_DIR}/kiosk-xinitrc"

    write_file /etc/systemd/system/bobine-kiosk.service <<EOF
[Unit]
Description=Bobine - Kiosk Chromium (écran cinéma)
After=bobine-backend.service
Requires=bobine-backend.service
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
    ok "bobine-kiosk.service + kiosk-xinitrc écrits"
    step_done
fi

# ---------------------------------------------------------------------------
step "Audio (auto-port, anti-sifflement, garde-fou hors session)"
# ---------------------------------------------------------------------------
if $NO_KIOSK; then
    step_skip "--no-kiosk"
else
    # WirePlumber désactive api.acp.auto-port/auto-profile par défaut pour
    # toutes les cartes ALSA, ce qui fige la sortie active sur le port choisi
    # au démarrage quel que soit le jack réellement branché (cause du bug
    # "une seule prise fonctionne" + bruits stridents sur sortie DAC non
    # pilotée). On restaure ici la commutation automatique de prise jack.
    run mkdir -p /etc/wireplumber/wireplumber.conf.d
    write_file /etc/wireplumber/wireplumber.conf.d/51-fix-jack-autoport.conf <<'EOF'
monitor.alsa.rules = [
  {
    matches = [
      { device.name = "~alsa_card.pci.*" }
    ]
    actions = {
      update-props = {
        api.acp.auto-port = true
        api.acp.auto-profile = true
      }
    }
  }
]
EOF
    ok "commutation automatique de prise jack restaurée"

    # Mise en veille du codec HDA désactivée (anti-sifflement) : avec
    # power_save=1 (défaut Debian), le codec Realtek se coupe après ~1s
    # d'inactivité et se rallume à la demande — chaque cycle laisse la sortie
    # analogique flotter puis produit un pop, source classique de sifflement
    # continu sur un ampli externe. Constaté sur ce Wyse : 8x plus de temps
    # éteint qu'allumé en usage kiosk normal. Coût : ~0,5W de plus, sans objet
    # sur une machine branchée secteur en continu.
    write_file /etc/modprobe.d/bobine-audio.conf <<'EOF'
options snd-hda-intel power_save=0 power_save_controller=N
EOF
    # Application immédiate sans attendre le prochain reboot.
    if ! $DRY_RUN; then
        echo 0 > /sys/module/snd_hda_intel/parameters/power_save 2>/dev/null || true
        echo on > /sys/bus/pci/devices/0000:00:0e.0/power/control 2>/dev/null || true
    fi
    ok "mise en veille du codec audio désactivée"

    # Si un powertop.service ("powertop --auto-tune") existe sur la machine,
    # il RÉACTIVE power_save=1 à chaque boot APRÈS le chargement du module,
    # annulant silencieusement le réglage modprobe ci-dessus. Drop-in qui
    # restaure le réglage anti-bruit juste après son passage, sans toucher à
    # ses autres optimisations.
    if [[ -f /etc/systemd/system/powertop.service ]]; then
        run mkdir -p /etc/systemd/system/powertop.service.d
        write_file /etc/systemd/system/powertop.service.d/10-audio-nopowersave.conf <<'EOF'
[Service]
ExecStartPost=/bin/sh -c 'echo 0 > /sys/module/snd_hda_intel/parameters/power_save'
ExecStartPost=/bin/sh -c 'echo on > /sys/bus/pci/devices/0000:00:0e.0/power/control'
EOF
        ok "garde-fou powertop installé"
    fi

    # Coupe le son hors session kiosk : ni le correctif Auto-Mute Mode
    # ci-dessus (appliqué seulement dans kiosk-xinitrc, tard dans le boot,
    # une fois le backend joignable) ni 'alsactl store' seul ne couvrent la
    # fenêtre AVANT que le kiosk démarre ni celle APRÈS son arrêt
    # (redémarrage/extinction) — exactement la fenêtre où une sortie DAC non
    # pilotée peut hurler. Ce service coupe Master + Speaker au tout début du
    # boot (bien avant le kiosk) et les recoupe explicitement à l'arrêt ;
    # kiosk-xinitrc les rouvre une fois réellement prêt à jouer du son.
    write_file /etc/systemd/system/bobine-audio-guard.service <<'EOF'
[Unit]
Description=Bobine - Coupe le son hors session kiosk
Before=bobine-kiosk.service
StartLimitIntervalSec=30
StartLimitBurst=20

[Service]
Type=oneshot
RemainAfterExit=yes
# La carte ALSA (module noyau snd_hda_intel, énumération PCI) n'est pas
# forcément prête au moment où ce service démarre malgré WantedBy=multi-user
# — constaté : "amixer: Invalid card number '0'" au premier boot après
# installation. Pas de dépendance systemd fiable à 100% sur la disponibilité
# d'une carte son précise (systemd-udev-settle est déconseillé/plus lent) :
# on retente donc simplement toutes les secondes plutôt que de dépendre d'un
# ordonnancement exact, la carte apparaît toujours en quelques secondes.
Restart=on-failure
RestartSec=1
ExecStart=/usr/bin/amixer -c0 -q sset Master mute
ExecStart=/usr/bin/amixer -c0 -q sset Speaker mute
ExecStart=/usr/bin/amixer -c0 -q sset Headphone mute
ExecStop=/usr/bin/amixer -c0 -q sset Master mute
ExecStop=/usr/bin/amixer -c0 -q sset Speaker mute
ExecStop=/usr/bin/amixer -c0 -q sset Headphone mute

[Install]
WantedBy=multi-user.target
EOF
    ok "garde-fou audio (silence hors session kiosk) écrit"
    step_done
fi

# ---------------------------------------------------------------------------
step "Autorisation sudo restreinte (bouton de réinitialisation)"
# ---------------------------------------------------------------------------
log "Autorisation sudo restreinte pour le redémarrage des services depuis l'UI"
if $NO_KIOSK; then
    SUDOERS_UNITS="/usr/bin/systemctl restart bobine-backend.service"
else
    SUDOERS_UNITS="/usr/bin/systemctl restart bobine-backend.service, /usr/bin/systemctl restart bobine-kiosk.service"
fi
# Enveloppe de désinstallation (bouton « Désinstaller » de l'UI) : commande
# unique, sans argument, qui détache le --uninstall via systemd-run.
SUDOERS_UNITS="${SUDOERS_UNITS}, /usr/local/sbin/bobine-uninstall"
write_file /etc/sudoers.d/bobine <<EOF
# Autorise UNIQUEMENT ces commandes précises, sans mot de passe :
#   - le redémarrage des unités (bouton de réinitialisation des paramètres) ;
#   - l'enveloppe de désinstallation /usr/local/sbin/bobine-uninstall
#     (bouton « Désinstaller », remise à zéro complète).
# Ne JAMAIS élargir à d'autres commandes ni remplacer par NOPASSWD: ALL.
${TARGET_USER} ALL=(root) NOPASSWD: ${SUDOERS_UNITS}
EOF
if ! $DRY_RUN; then
    chmod 0440 /etc/sudoers.d/bobine
    if ! visudo -c -f /etc/sudoers.d/bobine >/dev/null 2>&1; then
        warn "Fichier sudoers généré invalide, suppression (le bouton de reset ne fonctionnera pas)"
        rm -f /etc/sudoers.d/bobine
    else
        ok "règle sudoers validée par visudo"
    fi
fi
step_done

# ---------------------------------------------------------------------------
step "Synchronisation NTP"
# ---------------------------------------------------------------------------
# Défense en profondeur derrière le correctif applicatif (/api/time + offset
# côté kiosk) : sans NTP, l'horloge RTC du Wyse peut dériver indépendamment
# de toute correction logicielle côté navigateur.
if command -v timedatectl >/dev/null 2>&1; then
    run timedatectl set-ntp true
    ok "systemd-timesyncd activé"
else
    warn "timedatectl introuvable — vérifier manuellement la synchronisation NTP du système"
fi
step_done

# ---------------------------------------------------------------------------
step "URL locale (mDNS) & redirection du port 80"
# ---------------------------------------------------------------------------
# - avahi (mDNS) publie "bobine.local" sur le LAN sans toucher au
#   hostname de la machine ;
# - une règle nftables redirige le port 80 entrant vers le port applicatif,
#   pour une URL sans numéro de port depuis téléphone/PC. L'URL historique
#   http://<IP>:8000 reste fonctionnelle.
log "Publication du nom mDNS 'bobine.local' (avahi)"
if $DRY_RUN; then
    echo "  ${DIM}[dry-run]${RESET} configurerait avahi-daemon.conf (host-name, IPv6 désactivé)"
else
    AVAHI_CONF="/etc/avahi/avahi-daemon.conf"
    if grep -qE '^#?host-name=' "${AVAHI_CONF}"; then
        sed -i 's/^#\?host-name=.*/host-name=bobine/' "${AVAHI_CONF}"
    else
        sed -i '/^\[server\]/a host-name=bobine' "${AVAHI_CONF}"
    fi
    # IPv6 désactivé côté avahi : le paquet Debian publie par défaut
    # use-ipv6=yes, donc une adresse AAAA globale en plus de l'IPv4 — mais
    # rien dans la pile (redirection nftables port 80, bind uvicorn
    # "0.0.0.0") ne gère l'IPv6 de bout en bout. Un client qui préfère IPv6
    # (comportement courant des navigateurs) se connecte alors à un port
    # fermé -> refus immédiat, alors que l'IPv4 fonctionne. Plus simple de ne
    # publier que l'IPv4 que d'ajouter un vrai support IPv6 pour un usage LAN.
    if grep -qE '^#?use-ipv6=' "${AVAHI_CONF}"; then
        sed -i 's/^#\?use-ipv6=.*/use-ipv6=no/' "${AVAHI_CONF}"
    else
        sed -i '/^\[server\]/a use-ipv6=no' "${AVAHI_CONF}"
    fi
fi
# Le service peut être masqué sur une installation Debian durcie : démasqué
# explicitement (unité + socket) avant activation. Échec toléré : le mDNS est
# un confort, l'accès par http://<IP>:8000 reste toujours valable.
run systemctl unmask avahi-daemon.service avahi-daemon.socket >/dev/null 2>&1 || true
run systemctl enable avahi-daemon >/dev/null 2>&1 || true
if ! $DRY_RUN && ! systemctl restart avahi-daemon; then
    warn "Impossible de démarrer avahi-daemon : l'URL bobine.local ne sera pas publiée."
    warn "L'accès par adresse IP (http://<IP-du-Wyse>:8000) reste fonctionnel."
else
    ok "avahi-daemon actif"
fi

log "Redirection du port 80 vers ${SERVICE_PORT} (nftables)"
write_file "${CONFIG_DIR}/redirect.nft" <<EOF
# Généré par install.sh — accès sans numéro de port (http://bobine.local).
# Le triplet create/delete/create rend le rechargement idempotent.
table ip olmc_redirect
delete table ip olmc_redirect
table ip olmc_redirect {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        tcp dport 80 redirect to :${SERVICE_PORT}
    }
}
EOF
write_file /etc/systemd/system/bobine-redirect.service <<EOF
[Unit]
Description=Bobine - Redirection port 80 vers ${SERVICE_PORT}
After=network-pre.target nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${CONFIG_DIR}/redirect.nft
ExecStop=/usr/sbin/nft delete table ip olmc_redirect

[Install]
WantedBy=multi-user.target
EOF
ok "redirection du port 80 configurée"
step_done

# ---------------------------------------------------------------------------
step "Chien de garde de santé (watchdog)"
# ---------------------------------------------------------------------------
# Redémarrage AUTOMATIQUE d'un composant mort en consommant /api/health (Redis,
# base SQLite, kiosque Chromium). Complète `Restart=always` de systemd, qui ne
# couvre que la mort du *processus*, pas les défaillances *logiques* (backend
# vivant mais Redis injoignable, Chromium gelé…). Piloté par un TIMER systemd
# (pas de process résident). Distinct du garde AUDIO (`bobine-audio-guard`, un
# oneshot qui coupe le son hors session kiosk) : rôles séparés.
run chmod +x "${REPO_DIR}/scripts/watchdog.sh"
write_file /etc/systemd/system/bobine-watchdog.service <<EOF
[Unit]
Description=Bobine - Chien de garde santé (redémarre un composant mort)
After=bobine-backend.service

[Service]
Type=oneshot
ExecStart=${REPO_DIR}/scripts/watchdog.sh
EOF
write_file /etc/systemd/system/bobine-watchdog.timer <<'EOF'
[Unit]
Description=Bobine - Declenche le chien de garde sante periodiquement

[Timer]
# Laisse le systeme finir de booter avant la premiere passe (evite de lutter
# contre le demarrage normal des services), puis une passe toutes les 30 s.
OnBootSec=90s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
ok "chien de garde santé (watchdog) écrit"
step_done

# ---------------------------------------------------------------------------
step "Activation des services & vérification de santé"
# ---------------------------------------------------------------------------
run systemctl daemon-reload
if ! $NO_KIOSK; then
    run systemctl enable --now bobine-audio-guard.service
fi
run systemctl enable --now bobine-backend.service
# Chien de garde : actif dans tous les modes (surveille au moins le backend).
run systemctl enable --now bobine-watchdog.timer
if ! $NO_KIOSK; then
    run systemctl enable --now bobine-kiosk.service
fi
run systemctl enable bobine-redirect.service >/dev/null 2>&1 || true
if ! $DRY_RUN && ! systemctl restart bobine-redirect.service; then
    warn "Redirection port 80 -> ${SERVICE_PORT} indisponible (nftables) : utiliser http://bobine.local:${SERVICE_PORT}."
fi

if ! $DRY_RUN; then
    log "Attente de la disponibilité de l'API backend"
    HEALTHY=false
    for _ in $(seq 1 20); do
        if curl -fsS -o /dev/null -m 2 "http://127.0.0.1:${SERVICE_PORT}/api/health" 2>/dev/null; then
            HEALTHY=true
            break
        fi
        sleep 1
    done
    if $HEALTHY; then
        ok "API backend en ligne sur le port ${SERVICE_PORT}"
    else
        warn "L'API backend ne répond pas encore après 20s — vérifie : journalctl -u bobine-backend -n 50"
    fi
fi
step_done

# ---------------------------------------------------------------------------
# Résumé final
# ---------------------------------------------------------------------------
echo
box_top
box_line "  Bobine — installation terminée"
box_mid
box_line "  Admin      http://bobine.local"
box_line "             http://127.0.0.1:${SERVICE_PORT}  (et http://<IP>:${SERVICE_PORT})"
if ! $NO_KIOSK; then
    box_line "  Kiosk      ${KIOSK_URL}"
fi
box_line "  Config     ${CONFIG_FILE}"
box_line "  Journal    ${LOG_FILE}"
box_line "  Contrôle   bobine {start|stop|restart|status|logs}"
box_line "  Diagnostic sudo ./${SCRIPT_NAME} --check"
box_bottom
echo

if ! $DRY_RUN; then
    systemctl --no-pager --lines=0 status bobine-backend.service $($NO_KIOSK || echo bobine-kiosk.service) 2>/dev/null || true
fi

if ! $NO_KIOSK; then
    echo
    warn "L'appartenance aux groupes render/video ne s'applique qu'aux nouvelles sessions :"
    warn "un redémarrage complet de la machine est recommandé avant la première recette."
    warn "Après redémarrage, revérifie le décodage matériel :"
    warn "  vainfo   (doit lister les profils H.264/HEVC avec le pilote iHD)"
    warn "  chrome://gpu dans le kiosk, et 'intel_gpu_top' pendant une lecture"
fi
