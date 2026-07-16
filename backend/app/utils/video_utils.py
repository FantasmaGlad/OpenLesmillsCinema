import subprocess
import json
import logging
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)


def get_video_info(file_path: str) -> dict:
    """
    Exécute ffprobe pour extraire les informations de flux et de format de la vidéo au format JSON.
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-show_streams",
        "-print_format", "json",
        file_path
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(res.stdout)
    except subprocess.CalledProcessError as e:
        logger.error(f"ffprobe failed for {file_path}: {e.stderr}")
        raise ValueError(f"Impossible de lire le fichier vidéo avec ffprobe : {e.stderr}")
    except Exception as e:
        logger.error(f"Error running ffprobe for {file_path}: {e}")
        raise ValueError(f"Erreur lors de la lecture des métadonnées : {str(e)}")


def extract_metadata(file_path: str) -> dict:
    """
    Extrait les métadonnées pertinentes (durée, résolution, codecs, DRM) du fichier vidéo.
    """
    info = get_video_info(file_path)
    streams = info.get("streams", [])
    fmt = info.get("format", {})

    duration = None
    if "duration" in fmt:
        try:
            duration = float(fmt["duration"])
        except ValueError:
            pass

    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    width = None
    height = None
    v_codec = None
    if v_stream:
        width = v_stream.get("width")
        height = v_stream.get("height")
        v_codec = v_stream.get("codec_name")
        if duration is None and "duration" in v_stream:
            try:
                duration = float(v_stream["duration"])
            except ValueError:
                pass

    a_codec = None
    if a_stream:
        a_codec = a_stream.get("codec_name")

    # Détection des DRM (FairPlay / Encrypted streams)
    is_drm = False
    for s in streams:
        c_name = str(s.get("codec_name", "")).lower()
        c_tag = str(s.get("codec_tag_string", "")).lower()
        # "encv" et "enca" indiquent des flux chiffrés standard dans les conteneurs MP4/ISO
        if c_name in ("encv", "enca") or c_tag in ("encv", "enca"):
            is_drm = True
            break

    # Vérification des tags pour détecter des mentions de DRM ou chiffrement
    if not is_drm:
        for s in streams:
            for k, v in s.get("tags", {}).items():
                if "encryption" in k.lower() or "drm" in k.lower():
                    is_drm = True
                    break
            if is_drm:
                break

    return {
        "duration_seconds": duration,
        "width": width,
        "height": height,
        "codec": v_codec,
        "audio_codec": a_codec,
        "is_drm": is_drm
    }


def check_compatibility(metadata: dict, file_path: str) -> dict:
    """
    Vérifie la compatibilité de la vidéo par rapport aux règles de lecture directe du navigateur.
    Retourne si le fichier est directement lisible ou s'il nécessite une normalisation.
    """
    if metadata["is_drm"]:
        return {
            "is_compatible": False,
            "needs_normalization": False,
            "actions": [],
            "error": "Le fichier vidéo est protégé par DRM (FairPlay, etc.) et ne peut pas être lu."
        }

    ext = Path(file_path).suffix.lower()
    is_mp4_container = ext in (".mp4", ".m4v")
    is_aac_audio = metadata["audio_codec"] == "aac"

    needs_audio_recode = metadata["audio_codec"] is not None and not is_aac_audio
    needs_container_recode = not is_mp4_container

    actions = []
    if needs_audio_recode:
        actions.append("recode_audio")
    if needs_container_recode:
        actions.append("recode_container")

    is_compatible = is_mp4_container and is_aac_audio

    return {
        "is_compatible": is_compatible,
        "needs_normalization": len(actions) > 0,
        "actions": actions,
        "error": None
    }


def generate_thumbnail(video_path: str, thumbnail_dir: str, duration: float | None) -> str:
    """
    Génère une miniature à 10% du début de la vidéo à l'aide de ffmpeg.
    """
    # Calcul de l'offset temporel (10% de la durée, minimum 1.0s, défaut 5.0s)
    offset = 5.0
    if duration:
        offset = max(1.0, duration * 0.1)

    # Si la vidéo est trop courte, on réduit l'offset initial
    if duration and offset >= duration:
        offset = duration * 0.1

    thumb_filename = f"thumb_{uuid.uuid4().hex}.jpg"
    thumb_path = Path(thumbnail_dir) / thumb_filename

    # S'assurer que le dossier de destination existe
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg",
        "-ss", str(offset),
        "-i", video_path,
        "-vframes", "1",
        "-q:v", "4",  # Qualité (1-31, 1 est le meilleur, 4 est très propre)
        "-strict", "-2",  # Allow unofficial limited-range YUV for mjpeg encoder (needed for FFmpeg 8.0+)
        "-update", "1",   # Prevent single-frame warning/error on output file name
        "-y",
        str(thumb_path)
    ]

    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        if thumb_path.exists() and thumb_path.stat().st_size > 0:
            return str(thumb_path)
    except subprocess.CalledProcessError as e:
        logger.error(f"ffmpeg thumbnail generation failed: {e.stderr}")

    # Premier fallback : offset à 0.1s
    if offset != 0.1:
        new_offset = 0.1
        if duration and new_offset >= duration:
            new_offset = 0.0
        cmd[2] = str(new_offset)
        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            if thumb_path.exists() and thumb_path.stat().st_size > 0:
                return str(thumb_path)
        except subprocess.CalledProcessError as e2:
            logger.error(f"ffmpeg thumbnail fallback failed: {e2.stderr}")

    # Deuxième fallback : début absolu (0.0s)
    cmd[2] = "0.0"
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        if thumb_path.exists() and thumb_path.stat().st_size > 0:
            return str(thumb_path)
    except subprocess.CalledProcessError as e3:
        logger.error(f"ffmpeg thumbnail second fallback failed: {e3.stderr}")

    raise ValueError("Impossible de générer la miniature avec ffmpeg : le fichier de sortie est vide ou inexistant.")


def normalize_video(input_path: str, output_path: str, actions: list) -> str:
    """
    Normalise le conteneur ou la piste audio d'une vidéo de manière non destructive (Stream Copy).
    - MKV -> MP4 : Stream copy de la vidéo.
    - AC-3 -> AAC : Réencodage audio en AAC, Stream copy de la vidéo.
    """
    # S'assurer que le dossier de sortie existe
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    cmd = ["ffmpeg", "-i", input_path]

    # Copie du flux vidéo (pas de réencodage vidéo lourd)
    cmd.extend(["-c:v", "copy"])

    if "recode_audio" in actions:
        cmd.extend(["-c:a", "aac"])
    else:
        cmd.extend(["-c:a", "copy"])

    cmd.extend(["-y", output_path])

    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return output_path
    except subprocess.CalledProcessError as e:
        logger.error(f"ffmpeg normalization failed: {e.stderr}")
        raise ValueError(f"Échec de la normalisation de la vidéo avec ffmpeg : {e.stderr}")
