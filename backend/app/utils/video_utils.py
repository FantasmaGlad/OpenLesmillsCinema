import os
import subprocess
import json
import logging
import uuid
from pathlib import Path

import redis as redis_sync

from app.config import settings

logger = logging.getLogger(__name__)


# Délai maximum accordé à chaque appel ffprobe/ffmpeg (réf. retour
# utilisateur "l'importation des fonds animés bloque et ne termine jamais") :
# ces appels tournent sur l'exécuteur mono-thread PARTAGÉ par tous les imports
# de l'application (app.utils.executors.ffmpeg_executor) — un seul fichier
# problématique (corrompu, flux exotique sur lequel ffmpeg reste bloqué en
# lecture) y bloquerait alors indéfiniment TOUS les imports suivants, upload
# comme dossier surveillé, sans jamais remonter d'erreur ni libérer le
# thread. Un timeout transforme ce blocage silencieux en échec explicite.
FFPROBE_TIMEOUT_SECONDS = 30
FFMPEG_THUMBNAIL_TIMEOUT_SECONDS = 30
# Plus généreux que les deux ci-dessus (réf. constat en production : un
# réencodage réel de vidéo musicale complète de plusieurs minutes, soumise
# comme fond animé, a mis plus de 15 min à se terminer en logiciel pur sur le
# CPU modeste du Wyse 5070) : laisse la place à un réencodage légitimement
# long tout en bornant le pire cas (fichier corrompu/pathologique).
FFMPEG_NORMALIZE_TIMEOUT_SECONDS = 1800

# Verrou ffmpeg PARTAGÉ PAR LES 4 WORKERS UVICORN (réf. retour utilisateur
# "l'importation des fonds animés bloque et ne termine jamais") :
# `ffmpeg_executor` (app.utils.executors, thread unique) ne sérialise les
# imports ffmpeg qu'AU SEIN d'un seul worker — un ThreadPoolExecutor est un
# objet Python en mémoire, jamais partagé entre les 4 PROCESSUS uvicorn
# séparés. Constaté en production : deux imports de fonds animés reçus par
# deux workers différents ont chacun lancé leur propre ffmpeg, tournant
# SIMULTANÉMENT à ~200% CPU chacun sur les 2-4 coeurs du Wyse 5070 — un
# réencodage qui aurait pris quelques minutes seul s'étirait ainsi bien
# au-delà, exactement le symptôme "ne termine jamais". Ce verrou Redis (déjà
# utilisé ailleurs dans l'app pour la coordination inter-workers) garantit
# qu'un seul ffmpeg de réencodage/remux tourne réellement à la fois, quel que
# soit le worker qui a reçu la requête — les autres patientent leur tour.
FFMPEG_GLOBAL_LOCK_NAME = "lock:ffmpeg_global"

_ffmpeg_lock_client: "redis_sync.Redis | None" = None


def _get_ffmpeg_lock_client() -> "redis_sync.Redis":
    global _ffmpeg_lock_client
    if _ffmpeg_lock_client is None:
        _ffmpeg_lock_client = redis_sync.Redis.from_url(settings.redis_url, decode_responses=True)
    return _ffmpeg_lock_client


def _global_ffmpeg_lock():
    """
    `timeout` : expiration automatique si le porteur crashe sans relâcher le
    verrou — plus long que FFMPEG_NORMALIZE_TIMEOUT_SECONDS pour ne jamais
    expirer avant que le sous-processus ffmpeg n'ait lui-même été tué par son
    propre timeout. `blocking_timeout` : abandon si la file d'attente est
    déjà trop longue, plutôt que de patienter indéfiniment derrière plusieurs
    autres imports.
    """
    return _get_ffmpeg_lock_client().lock(
        FFMPEG_GLOBAL_LOCK_NAME,
        timeout=FFMPEG_NORMALIZE_TIMEOUT_SECONDS + 120,
        blocking_timeout=FFMPEG_NORMALIZE_TIMEOUT_SECONDS * 3,
    )


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
        res = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=FFPROBE_TIMEOUT_SECONDS)
        return json.loads(res.stdout)
    except subprocess.TimeoutExpired:
        logger.error(f"ffprobe : délai dépassé ({FFPROBE_TIMEOUT_SECONDS}s) pour {file_path}")
        raise ValueError(f"L'analyse du fichier vidéo a dépassé {FFPROBE_TIMEOUT_SECONDS}s (ffprobe)")
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


# Codecs vidéo dont la robustesse a été validée sur le Wyse 5070 (Lot 0).
# Restreint à H.264 pour l'instant (réf. audit plan-corrections-bugs, point
# 6) : HEVC/VP9 ont été validés en lecture continue mais pas spécifiquement
# en boucle (un fond animé redémarre le décodeur toutes les quelques
# secondes, sollicitation plus dure qu'une lecture linéaire) — à élargir
# seulement après un vrai test de boucle sur le matériel cible.
COMPATIBLE_VIDEO_CODECS = {"h264"}

# Codecs supplémentaires validés pour une vidéo de COURS (lue une seule fois,
# en continu — jamais en boucle) : plus permissive que la liste stricte
# ci-dessus, réservée aux fonds animés. Réf. correctif "un cours mal encodé
# peut être importé sans avertissement puis échouer à la lecture" — avant ce
# correctif, `strict_video_codec=False` ne rétrécissait pas cette liste, il
# sautait la vérification du codec vidéo EN ENTIER (n'importe quel codec,
# même jamais testé sur ce matériel — AV1, MPEG-2, VC-1...— passait pour
# "compatible"). Un cours dans un codec hors de cette liste déclenche
# maintenant un réencodage à l'import, comme pour un fond animé non conforme,
# plutôt que d'être importé tel quel sans avertissement.
COMPATIBLE_COURSE_VIDEO_CODECS = COMPATIBLE_VIDEO_CODECS | {"hevc", "vp9"}


def is_faststart_mp4(file_path: str) -> bool:
    """
    Vrai si l'atome 'moov' (index des échantillons) précède l'atome 'mdat'
    (données) dans le fichier — condition requise pour qu'un navigateur
    puisse décoder la moindre image avant d'avoir reçu la quasi-totalité du
    fichier (réf. correctif "critique kiosk/réseau — reste figé sur la
    première frame"). ffmpeg écrit 'moov' APRÈS 'mdat' par défaut (à la toute
    fin du fichier) sauf option explicite `-movflags +faststart` : invisible
    en boucle localhost (l'écran câblé récupère la fin du fichier quasi
    instantanément via Range), mais un lecteur sur une vraie liaison LAN/WiFi
    doit alors télécharger presque tout le fichier — souvent plusieurs
    centaines de Mo pour un cours — avant de pouvoir peindre une seule image.

    Ne lit que les en-têtes de boîtes top-level (8 ou 16 octets chacune),
    jamais leur contenu : coût constant quelle que soit la taille du fichier.
    """
    try:
        with open(file_path, "rb") as f:
            file_size = os.fstat(f.fileno()).st_size
            pos = 0
            while pos < file_size:
                header = f.read(8)
                if len(header) < 8:
                    break
                size = int.from_bytes(header[0:4], "big")
                box_type = header[4:8].decode("ascii", errors="ignore")
                if box_type == "moov":
                    return True
                if box_type == "mdat":
                    return False
                if size == 1:
                    # Boîte 64 bits : la taille réelle suit l'en-tête normal.
                    ext = f.read(8)
                    if len(ext) < 8:
                        break
                    size = int.from_bytes(ext, "big")
                elif size == 0:
                    # Dernière boîte du fichier, s'étend jusqu'à la fin.
                    break
                if size < 8:
                    break
                pos += size
                f.seek(pos)
    except OSError as e:
        logger.warning(f"Impossible de vérifier l'ordre des atomes MP4 de {file_path} : {e}")
    return False


def check_compatibility(metadata: dict, file_path: str, strict_video_codec: bool = False) -> dict:
    """
    Vérifie la compatibilité de la vidéo par rapport aux règles de lecture directe du navigateur.
    Retourne si le fichier est directement lisible ou s'il nécessite une normalisation.

    `strict_video_codec` (réf. audit plan-corrections-bugs, point 6) : à
    activer uniquement pour les fonds animés, qui bouclent indéfiniment et
    sollicitent donc le décodeur matériel bien plus durement (redémarrage à
    chaque tour) qu'une vidéo de cours lue une seule fois en continu. Pour un
    cours (False), la liste blanche reste appliquée mais élargie à HEVC/VP9
    (COMPATIBLE_COURSE_VIDEO_CODECS) plutôt que d'être ignorée : un codec
    jamais validé sur ce matériel déclenche quand même un réencodage.
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
    is_audio_compatible = metadata["audio_codec"] is None or metadata["audio_codec"] == "aac"
    # Un flux vidéo absent (audio seul) n'a rien à réencoder ; sinon le codec
    # doit être dans la liste blanche correspondante (stricte pour un fond
    # animé, élargie HEVC/VP9 pour un cours — jamais totalement ignorée).
    allowed_video_codecs = COMPATIBLE_VIDEO_CODECS if strict_video_codec else COMPATIBLE_COURSE_VIDEO_CODECS
    is_video_codec_compatible = metadata["codec"] is None or metadata["codec"] in allowed_video_codecs

    needs_audio_recode = metadata["audio_codec"] is not None and metadata["audio_codec"] != "aac"
    needs_container_recode = not is_mp4_container
    needs_video_recode = not is_video_codec_compatible
    # Réf. correctif "critique kiosk/réseau — reste figé sur la première
    # frame" : un conteneur/codec par ailleurs déjà compatible peut quand même
    # avoir son atome moov en fin de fichier (export non "web optimisé") — un
    # défaut invisible en local mais bloquant sur le réseau. Seul un
    # conteneur MP4 est concerné (un remux container->mp4 ci-dessous produit
    # déjà du faststart via normalize_video).
    needs_faststart_remux = (
        is_mp4_container and metadata.get("codec") is not None and not is_faststart_mp4(file_path)
    )

    actions = []
    if needs_video_recode:
        actions.append("recode_video")
    if needs_audio_recode:
        actions.append("recode_audio")
    if needs_container_recode:
        actions.append("recode_container")
    if needs_faststart_remux and not needs_container_recode:
        actions.append("remux_faststart")

    is_compatible = is_mp4_container and is_audio_compatible and is_video_codec_compatible

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
        subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=FFMPEG_THUMBNAIL_TIMEOUT_SECONDS)
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
            subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=FFMPEG_THUMBNAIL_TIMEOUT_SECONDS)
            if thumb_path.exists() and thumb_path.stat().st_size > 0:
                return str(thumb_path)
        except subprocess.CalledProcessError as e2:
            logger.error(f"ffmpeg thumbnail fallback failed: {e2.stderr}")

    # Deuxième fallback : début absolu (0.0s)
    cmd[2] = "0.0"
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=FFMPEG_THUMBNAIL_TIMEOUT_SECONDS)
        if thumb_path.exists() and thumb_path.stat().st_size > 0:
            return str(thumb_path)
    except subprocess.CalledProcessError as e3:
        logger.error(f"ffmpeg thumbnail second fallback failed: {e3.stderr}")

    raise ValueError("Impossible de générer la miniature avec ffmpeg : le fichier de sortie est vide ou inexistant.")


def normalize_video(input_path: str, output_path: str, actions: list, source_metadata: dict | None = None) -> str:
    """
    Normalise le conteneur ou la piste audio d'une vidéo de manière non destructive (Stream Copy).
    - MKV -> MP4 : Stream copy de la vidéo.
    - AC-3 -> AAC : Réencodage audio en AAC, Stream copy de la vidéo.

    `source_metadata` (réf. correctif "appel ffprobe redondant alourdit
    inutilement chaque normalisation") : tous les appelants ont déjà extrait
    les métadonnées de CE MÊME fichier (souvent juste déplacé, jamais encore
    modifié) pour décider des `actions` à passer ici — les leur faire
    transmettre évite de relancer ffprobe une seconde fois sur un contenu
    identique. Reste optionnel (repli sur un appel ffprobe local) pour ne pas
    casser un futur appelant qui ne les aurait pas sous la main.
    """
    # S'assurer que le dossier de sortie existe
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    cmd = ["ffmpeg", "-i", input_path]

    if "recode_video" in actions:
        # Réencodage réel vers H.264 (réf. audit plan-corrections-bugs, point
        # 6) : codec source hors liste blanche (HEVC/VP9/autre). Un simple
        # remux par copie de flux ne suffit pas ici, contrairement au cas
        # container-only — c'est justement ce qui manquait avant ce fix.
        # "veryfast"/CRF modéré : suffisant pour un fond animé court, le coût
        # CPU reste ponctuel (à l'import, pas à la lecture).
        cmd.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"])
    else:
        # Copie du flux vidéo (pas de réencodage vidéo lourd)
        cmd.extend(["-c:v", "copy"])

    # Vérifier s'il y a une piste audio dans le fichier d'entrée
    meta = source_metadata if source_metadata is not None else extract_metadata(input_path)
    has_audio = meta.get("audio_codec") is not None

    if not has_audio:
        cmd.append("-an")
    elif "recode_audio" in actions:
        cmd.extend(["-c:a", "aac"])
    else:
        cmd.extend(["-c:a", "copy"])

    # +faststart (réf. correctif "critique kiosk/réseau — reste figé sur la
    # première frame") : place systématiquement l'atome moov en tête du
    # fichier de sortie, quelle que soit la raison de cette normalisation
    # (recodage réel ou simple remux déclenché par `remux_faststart`) — sans
    # coût perceptible (ffmpeg réordonne juste les boîtes déjà écrites).
    cmd.extend(["-movflags", "+faststart"])
    cmd.extend(["-y", output_path])

    # Verrou global (réf. constat en production ci-dessus) : attend son tour
    # si un autre worker a déjà un ffmpeg de normalisation en cours, plutôt
    # que de se lancer en parallèle et de se disputer le CPU avec lui.
    lock = _global_ffmpeg_lock()
    try:
        if not lock.acquire(blocking=True):
            raise ValueError(
                "Trop d'imports vidéo en attente de traitement — réessayez dans quelques minutes."
            )
    except redis_sync.exceptions.RedisError as e:
        # Redis injoignable : on laisse passer plutôt que de bloquer tout
        # import (même compromis que les verrous de tick ailleurs dans
        # l'app) — le risque de contention CPU redevient alors possible mais
        # mieux vaut ça qu'un import qui échoue systématiquement.
        logger.warning(f"Verrou ffmpeg Redis indisponible, normalisation sans verrou : {e}")
        lock = None

    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=FFMPEG_NORMALIZE_TIMEOUT_SECONDS)
        return output_path
    except subprocess.TimeoutExpired:
        logger.error(f"ffmpeg : délai dépassé ({FFMPEG_NORMALIZE_TIMEOUT_SECONDS}s) en normalisant {input_path}")
        raise ValueError(
            f"La normalisation de la vidéo a dépassé {FFMPEG_NORMALIZE_TIMEOUT_SECONDS // 60} min (ffmpeg) — "
            "fichier probablement trop volumineux ou corrompu."
        )
    except subprocess.CalledProcessError as e:
        logger.error(f"ffmpeg normalization failed: {e.stderr}")
        raise ValueError(f"Échec de la normalisation de la vidéo avec ffmpeg : {e.stderr}")
    finally:
        if lock is not None:
            try:
                lock.release()
            except Exception as e:
                # Verrou déjà expiré (timeout Redis dépassé) ou Redis
                # devenu injoignable entre-temps : sans conséquence, il
                # s'auto-expirera de toute façon via son propre `timeout`.
                logger.warning(f"Impossible de relâcher le verrou ffmpeg proprement : {e}")
