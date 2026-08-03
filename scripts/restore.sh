#!/usr/bin/env bash
#
# restore.sh — Restauration d'une sauvegarde OpenLesmillsCinema (réf. NF7, tâche 15.6).
#
# Usage :
#   sudo openlesmillscinema stop        # arrêter le service avant de toucher aux fichiers
#   ./scripts/restore.sh <archive.tar.gz>
#   sudo openlesmillscinema start
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${REPO_DIR}/backend"
ARCHIVE="${1:?Usage: restore.sh <archive.tar.gz>}"

log()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m!! $*\033[0m" >&2; }

[[ -f "${ARCHIVE}" ]] || { echo "Archive introuvable : ${ARCHIVE}" >&2; exit 1; }

if systemctl is-active --quiet openlesmillscinema-backend 2>/dev/null; then
    warn "openlesmillscinema-backend semble actif — arrête le service avant de restaurer"
    warn "(risque d'écraser la base pendant qu'un processus l'a ouverte) : 'openlesmillscinema stop'"
    read -rp "Continuer quand même ? [y/N] " confirm
    [[ "${confirm}" == "y" || "${confirm}" == "Y" ]] || exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

log "Extraction de l'archive"
tar -xzf "${ARCHIVE}" -C "${WORK_DIR}"

PYTHON_BIN="${BACKEND_DIR}/.venv/bin/python"
[[ -x "${PYTHON_BIN}" ]] || PYTHON_BIN="python3"

PATHS_JSON="$(cd "${BACKEND_DIR}" && "${PYTHON_BIN}" -c '
import json
from app.config import settings
db_path = settings.database_url.replace("sqlite:///", "")
print(json.dumps({
    "database": db_path,
    "media_dir": settings.media_dir,
    "backgrounds_dir": settings.backgrounds_dir,
    "audio_dir": settings.audio_dir,
    "thumbnails_dir": settings.thumbnails_dir,
    "canvas_assets_dir": settings.canvas_assets_dir,
}))
')"

DB_PATH="$(echo "${PATHS_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["database"])')"

if [[ -f "${WORK_DIR}/database.db" ]]; then
    log "Restauration de la base SQLite vers ${DB_PATH}"
    mkdir -p "$(dirname "${DB_PATH}")"
    [[ -f "${DB_PATH}" ]] && cp "${DB_PATH}" "${DB_PATH}.avant-restauration.$(date +%s)"
    cp "${WORK_DIR}/database.db" "${DB_PATH}"
else
    warn "Pas de database.db dans l'archive, base non touchée."
fi

if [[ -f "${WORK_DIR}/config.toml" ]]; then
    CONFIG_DEST="/etc/openlesmillscinema/config.toml"
    if [[ -w "$(dirname "${CONFIG_DEST}")" || -w "${CONFIG_DEST}" ]] 2>/dev/null; then
        log "Restauration de la configuration vers ${CONFIG_DEST}"
        mkdir -p "$(dirname "${CONFIG_DEST}")"
        cp "${WORK_DIR}/config.toml" "${CONFIG_DEST}"
    else
        warn "Pas d'accès en écriture à ${CONFIG_DEST} — copie config.toml manuellement (ou relance avec sudo)."
    fi
fi

for key in media_dir backgrounds_dir audio_dir thumbnails_dir canvas_assets_dir; do
    src="${WORK_DIR}/${key}"
    [[ -d "${src}" ]] || continue
    dest="$(echo "${PATHS_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"${key}\"])")"
    log "Restauration de ${key} vers ${dest}"
    mkdir -p "${dest}"
    cp -a "${src}/." "${dest}/"
done

echo
echo "Restauration terminée. Relance le service : 'openlesmillscinema start'"
echo "Une copie de sécurité de l'ancienne base (si présente) a été laissée à côté : ${DB_PATH}.avant-restauration.*"
