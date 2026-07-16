import re
import subprocess
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Reconnaît un numéro de piste en tête de nom de fichier : "01 - Titre.mp3",
# "1. Titre.mp3", "Track 05 Titre.mp3", "05_Titre.mp3" (réf. F10.1 : "ordre
# des pistes déduit du nom de fichier").
_LEADING_NUMBER_RE = re.compile(r"(?:^|track\s*)0*(\d{1,3})(?!\d)", re.IGNORECASE)


def extract_audio_duration(file_path: str) -> float | None:
    """Durée d'une piste MP3 via ffprobe (réf. F10.2)."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        file_path,
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        duration = data.get("format", {}).get("duration")
        return float(duration) if duration is not None else None
    except Exception as e:
        logger.error(f"ffprobe a échoué pour la piste audio {file_path}: {e}")
        return None


def parse_track_number_and_title(filename: str) -> tuple[int | None, str]:
    """
    Déduit un numéro de piste et un titre lisible à partir d'un nom de
    fichier MP3 (réf. F10.1). Le numéro n'est qu'une aide au tri initial :
    la position réelle (`AudioTrack.position`) reste réordonnable depuis
    l'interface indépendamment de ce numéro.
    """
    stem = Path(filename).stem
    match = _LEADING_NUMBER_RE.match(stem)
    number = int(match.group(1)) if match else None

    title = stem
    if match:
        title = stem[match.end():]
    title = re.sub(r"^[\s\-_.]+", "", title).strip()
    title = title.replace("_", " ").strip()
    if not title:
        title = stem.replace("_", " ").strip()

    return number, title
