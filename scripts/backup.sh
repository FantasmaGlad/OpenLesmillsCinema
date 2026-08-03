#!/usr/bin/env bash
#
# backup.sh — Sauvegarde complète d'OpenLesmillsCinema (réf. NF7, tâche 15.6).
#
# Usage :
#   ./scripts/backup.sh [dossier_de_destination]
#
# Sauvegarde, dans une seule archive .tar.gz horodatée :
#   - la base SQLite (database.db)
#   - le fichier de configuration actif (config.toml, dépôt ou /etc)
#   - tous les dossiers de médias (vidéos, fonds animés, cours audio, miniatures,
#     assets du canvas)
#
# Le strict minimum exigé par NF7 est "base SQLite + config + dossier vidéos" ;
# ce script sauvegarde aussi les autres médias par prudence (coût négligeable,
# évite d'avoir à ré-importer manuellement fonds animés/cours audio après une
# restauration).
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${REPO_DIR}/backend"
DEST_DIR="${1:-${REPO_DIR}/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

PYTHON_BIN="${BACKEND_DIR}/.venv/bin/python"
if [[ ! -x "${PYTHON_BIN}" ]]; then
    PYTHON_BIN="python3"
fi

log "Lecture des chemins depuis la configuration active"
# Source de vérité unique (évite de dupliquer/parser config.toml en bash) :
# app.config.settings résout déjà la priorité /etc vs dépôt, les chemins
# relatifs, etc. (réf. F7.4).
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
CONFIG_FILE="/etc/openlesmillscinema/config.toml"
[[ -f "${CONFIG_FILE}" ]] || CONFIG_FILE="${BACKEND_DIR}/config.toml"

mkdir -p "${DEST_DIR}" "${WORK_DIR}/backup"

log "Copie de la base SQLite (${DB_PATH})"
if [[ -f "${DB_PATH}" ]]; then
    # sqlite3 .backup plutôt qu'un simple cp : cohérent même si le backend
    # tourne (mode WAL, écritures concurrentes possibles).
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "${DB_PATH}" ".backup '${WORK_DIR}/backup/database.db'"
    else
        cp "${DB_PATH}" "${WORK_DIR}/backup/database.db"
    fi
else
    echo "Attention : base SQLite introuvable (${DB_PATH}), ignorée." >&2
fi

log "Copie de la configuration (${CONFIG_FILE})"
[[ -f "${CONFIG_FILE}" ]] && cp "${CONFIG_FILE}" "${WORK_DIR}/backup/config.toml"

for key in media_dir backgrounds_dir audio_dir thumbnails_dir canvas_assets_dir; do
    dir="$(echo "${PATHS_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"${key}\"])")"
    if [[ -d "${dir}" ]]; then
        log "Copie de ${key} (${dir})"
        mkdir -p "${WORK_DIR}/backup/${key}"
        cp -a "${dir}/." "${WORK_DIR}/backup/${key}/" 2>/dev/null || true
    fi
done

ARCHIVE="${DEST_DIR}/openlesmillscinema-backup-${TIMESTAMP}.tar.gz"
log "Création de l'archive : ${ARCHIVE}"
tar -czf "${ARCHIVE}" -C "${WORK_DIR}/backup" .

echo
echo "Sauvegarde terminée : ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"
echo "Restauration : ./scripts/restore.sh ${ARCHIVE}"
