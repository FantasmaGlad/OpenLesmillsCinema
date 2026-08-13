"""Utilitaires du module Radio (réf. docs/cahier-des-charges-radio.md §5.3).

Extraction des métadonnées et de la pochette embarquée d'un fichier musical, et
transcodage vers un format lisible par le navigateur pour les formats exotiques.
Tout repose sur ffprobe/ffmpeg (déjà présents) + Pillow (déjà dépendance) : aucun
paquet Python supplémentaire.
"""
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Formats lus nativement par Chromium (le kiosk /radio) : servis tels quels.
WEB_PLAYABLE_EXTENSIONS = {
    ".mp3", ".m4a", ".aac", ".mp4", ".ogg", ".oga", ".opus", ".webm", ".flac", ".wav",
}
# Décision A2 « tous les formats audio » : whitelist large à l'import. Les formats
# hors WEB_PLAYABLE_EXTENSIONS sont transcodés en AAC/.m4a à l'import.
AUDIO_EXTENSIONS = WEB_PLAYABLE_EXTENSIONS | {
    ".wma", ".aiff", ".aif", ".aifc", ".ape", ".alac", ".wv", ".mka", ".m4b", ".ac3",
}

AUDIO_CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


def content_type_for(file_path: str) -> str:
    return AUDIO_CONTENT_TYPES.get(Path(file_path).suffix.lower(), "application/octet-stream")


def clean_filename_label(file_path: str) -> str:
    """Dérive un libellé lisible depuis un nom de fichier (underscores en
    espaces) — utilisé en repli quand aucun tag ID3 de titre n'est présent,
    et pour dériver automatiquement la description d'un rappel importé en
    lot (réf. correctif "import groupé de rappels sans ressaisir chaque
    description à la main")."""
    stem = Path(file_path).stem.replace("_", " ").strip()
    return stem or Path(file_path).stem


def needs_transcode(file_path: str) -> bool:
    return Path(file_path).suffix.lower() not in WEB_PLAYABLE_EXTENSIONS


def _first_tag(tags: dict, *keys: str) -> str | None:
    """Lecture insensible à la casse (les clés de tags varient selon le
    conteneur : `album_artist` vs `ALBUMARTIST`, `track` vs `tracknumber`…)."""
    lowered = {k.lower(): v for k, v in tags.items()}
    for key in keys:
        val = lowered.get(key.lower())
        if val is not None and str(val).strip() != "":
            return str(val).strip()
    return None


def _leading_int(value: str | None) -> int | None:
    """« 3/12 » -> 3, « 05 » -> 5, sinon None."""
    if not value:
        return None
    m = re.match(r"\s*0*(\d{1,4})", value)
    return int(m.group(1)) if m else None


def _year_from(value: str | None) -> int | None:
    if not value:
        return None
    m = re.search(r"(\d{4})", value)
    return int(m.group(1)) if m else None


def extract_radio_metadata(file_path: str) -> dict:
    """Métadonnées d'un morceau via ffprobe (tags de conteneur + du 1er flux
    audio fusionnés). Le titre retombe sur le nom de fichier nettoyé si absent."""
    meta: dict = {
        "title": None, "artist": None, "album": None, "album_artist": None,
        "track_number": None, "disc_number": None, "year": None, "genre": None,
        "duration_seconds": None,
    }
    cmd = ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", file_path]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        info = json.loads(res.stdout)
    except Exception as e:
        logger.error(f"ffprobe a échoué pour le morceau radio {file_path}: {e}")
        info = {}

    fmt = info.get("format", {}) or {}
    tags = dict(fmt.get("tags", {}) or {})
    # Fusionne les tags du premier flux audio (certains conteneurs les y logent).
    for stream in info.get("streams", []) or []:
        if stream.get("codec_type") == "audio":
            for k, v in (stream.get("tags", {}) or {}).items():
                tags.setdefault(k, v)
            break

    meta["title"] = _first_tag(tags, "title")
    meta["artist"] = _first_tag(tags, "artist", "author", "performer")
    meta["album"] = _first_tag(tags, "album")
    meta["album_artist"] = _first_tag(tags, "album_artist", "albumartist", "band")
    meta["track_number"] = _leading_int(_first_tag(tags, "track", "tracknumber"))
    meta["disc_number"] = _leading_int(_first_tag(tags, "disc", "discnumber", "disk"))
    meta["year"] = _year_from(_first_tag(tags, "date", "year", "originalyear", "creation_time"))
    meta["genre"] = _first_tag(tags, "genre")

    duration = fmt.get("duration")
    try:
        meta["duration_seconds"] = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        meta["duration_seconds"] = None

    if not meta["title"]:
        meta["title"] = clean_filename_label(file_path)

    return meta


def extract_embedded_cover(file_path: str, covers_dir: str, file_id: str) -> str | None:
    """Extrait la pochette embarquée (APIC / cover art) vers un JPEG redimensionné
    dans `covers_dir`. Renvoie le chemin ou None si le fichier n'en contient pas.

    `-vframes 1` décode la première image (pochette) et la ré-encode : robuste
    quel que soit le format embarqué (JPEG ou PNG). Un fichier sans pochette fait
    échouer ffmpeg (code retour != 0 ou sortie vide) -> None."""
    Path(covers_dir).mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.close()
    try:
        cmd = ["ffmpeg", "-y", "-i", file_path, "-an", "-vframes", "1", tmp.name]
        res = subprocess.run(cmd, capture_output=True)
        if res.returncode != 0 or not os.path.exists(tmp.name) or os.path.getsize(tmp.name) == 0:
            return None
        from PIL import Image
        dest = Path(covers_dir) / f"cover_{file_id}.jpg"
        with Image.open(tmp.name) as img:
            img = img.convert("RGB")
            img.thumbnail((600, 600))
            img.save(dest, "JPEG", quality=85)
        return str(dest)
    except Exception as e:
        logger.warning(f"Extraction de pochette échouée pour {file_path}: {e}")
        return None
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass


def save_cover_image(src_image_path: str, covers_dir: str, file_id: str) -> str:
    """Enregistre une pochette fournie manuellement (upload) : redimensionnée et
    normalisée en JPEG, comme les pochettes extraites (réf. D3 override manuel)."""
    Path(covers_dir).mkdir(parents=True, exist_ok=True)
    from PIL import Image
    dest = Path(covers_dir) / f"cover_{file_id}.jpg"
    with Image.open(src_image_path) as img:
        img = img.convert("RGB")
        img.thumbnail((600, 600))
        img.save(dest, "JPEG", quality=85)
    return str(dest)


def transcode_to_web(src_path: str, dest_path: str) -> None:
    """Transcode un format non lu par le navigateur (ex. .wma) en AAC/.m4a
    (réf. A2). Lève en cas d'échec ffmpeg."""
    cmd = ["ffmpeg", "-y", "-i", src_path, "-vn", "-c:a", "aac", "-b:a", "256k", dest_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Transcodage échoué pour {src_path}: {res.stderr[-500:]}")


def _measure_loudnorm(src_path: str, target_lufs: float) -> dict | None:
    """1ʳᵉ passe `loudnorm` (analyse seule, sortie nulle) : mesure le loudness
    réel de la source et renvoie le bloc JSON (input_i/tp/lra/thresh +
    target_offset) à réinjecter en 2ᵉ passe. Renvoie None si l'analyse échoue
    ou si le JSON est introuvable (on retombe alors sur une passe simple)."""
    cmd = [
        "ffmpeg", "-y", "-i", src_path, "-vn",
        "-af", f"loudnorm=I={target_lufs}:TP=-1.0:LRA=11:print_format=json",
        "-f", "null", "-",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        return None
    # ffmpeg imprime le bloc JSON en fin de stderr : on prend le dernier objet.
    matches = re.findall(r"\{[^{}]*\}", res.stderr, re.DOTALL)
    if not matches:
        return None
    try:
        return json.loads(matches[-1])
    except json.JSONDecodeError:
        return None


def normalize_announcement_loudness(src_path: str, dest_path: str, target_lufs: float = -10.0) -> None:
    """Normalise le loudness d'un rappel (filtre EBU R128 `loudnorm`) au niveau
    d'une musique commerciale, puis ré-encode en AAC/.m4a.

    Réf. correctif user « la voix des rappels est très faible vs la musique ;
    elle doit être au minimum aussi forte » : une voix brute a un loudness
    (LUFS) bien plus faible qu'une musique masterisée, et les pistes musicales
    ne sont PAS normalisées à l'import (souvent -9 à -11 LUFS). On aligne donc
    la voix sur ce niveau commercial (cible -10 LUFS ≈ la plupart des masters),
    pour qu'elle passe au-dessus de la musique.

    On procède en DEUX passes : une passe simple de `loudnorm` sous-évalue le
    gain sur une voix courte/silencieuse (le filtre « apprend » encore le
    niveau sur les premières secondes) — d'où l'ancien rappel resté trop bas
    même à -14 LUFS. La 1ʳᵉ passe mesure la source, la 2ᵉ applique la
    correction exacte. TP=-1.0 dBTP garde une marge anti-saturation."""
    measured = _measure_loudnorm(src_path, target_lufs)
    if measured is not None:
        af = (
            f"loudnorm=I={target_lufs}:TP=-1.0:LRA=11"
            f":measured_I={measured['input_i']}"
            f":measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}"
            f":measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}"
        )
    else:
        # Repli : passe simple (moins précise, mais garde un import fonctionnel
        # si l'analyse a échoué).
        af = f"loudnorm=I={target_lufs}:TP=-1.0:LRA=11"
    cmd = [
        "ffmpeg", "-y", "-i", src_path, "-vn",
        "-af", af,
        "-c:a", "aac", "-b:a", "192k", dest_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Normalisation loudness échouée pour {src_path}: {res.stderr[-500:]}")
