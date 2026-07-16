import os
import time
import uuid
import shutil
import logging
from pathlib import Path

from app.config import settings
from app.database import SessionLocal
from app.models import Video, ImportSource
from app.utils.video_utils import (
    extract_metadata,
    check_compatibility,
    generate_thumbnail,
    normalize_video,
)

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".mp4", ".m4v", ".mkv", ".avi", ".mov"}


def wait_for_file_to_copy(file_path: str, stable_secs: int = 3, timeout: int = 300) -> bool:
    """
    Attend que la taille du fichier se stabilise (indiquant que la copie/l'upload est terminé).
    """
    last_size = -1
    stable_since = 0
    start_time = time.time()

    while time.time() - start_time < timeout:
        if not os.path.exists(file_path):
            time.sleep(0.5)
            continue

        try:
            current_size = os.path.getsize(file_path)
        except OSError:
            time.sleep(0.5)
            continue

        if current_size == last_size and current_size > 0:
            stable_since += 1
            if stable_since >= stable_secs:
                return True
        else:
            last_size = current_size
            stable_since = 0

        time.sleep(1)

    return False


def import_video(src_path: str, original_filename: str, source: ImportSource) -> Video:
    """
    Gère le flux complet d'importation d'une vidéo :
    1. Attente de la stabilisation du fichier.
    2. Extraction des métadonnées et vérification des DRM.
    3. Déplacement/Normalisation du fichier dans le répertoire média final.
    4. Génération de la miniature.
    5. Insertion en base de données.
    """
    path_obj = Path(src_path)

    # 1. Attendre la stabilisation du fichier (si c'est un fichier local / watcher)
    if source == ImportSource.watched_folder:
        if not wait_for_file_to_copy(src_path):
            raise TimeoutError(f"Le fichier {original_filename} ne s'est pas stabilisé dans le temps imparti.")

    # 2. Extraction des métadonnées
    meta = extract_metadata(src_path)

    if meta["is_drm"]:
        # Suppression du fichier source en cas de DRM pour éviter des boucles infinies ou encombrements
        if path_obj.exists():
            try:
                os.remove(src_path)
            except Exception as e:
                logger.error(f"Impossible de supprimer le fichier DRM {src_path}: {e}")
        raise ValueError(
            f"Le fichier {original_filename} est protégé par DRM et ne peut pas être lu."
        )

    # Vérification de la compatibilité
    compat = check_compatibility(meta, src_path)

    file_id = uuid.uuid4().hex
    clean_name = "".join(c for c in original_filename if c.isalnum() or c in (".", "_", "-")).strip()

    # Définition des dossiers
    Path(settings.media_dir).mkdir(parents=True, exist_ok=True)
    Path(settings.thumbnails_dir).mkdir(parents=True, exist_ok=True)

    dest_path = None
    thumbnail_path = None

    try:
        if compat["needs_normalization"]:
            # Déplacement vers un fichier temporaire pour normalisation
            temp_filename = f"temp_{file_id}_{clean_name}"
            temp_dest_path = Path(settings.media_dir) / temp_filename
            
            logger.info(f"Déplacement de {src_path} vers {temp_dest_path} pour normalisation")
            shutil.move(src_path, temp_dest_path)

            # Le fichier normalisé sera toujours un MP4
            final_filename = f"video_{file_id}_{Path(clean_name).stem}.mp4"
            final_dest_path = Path(settings.media_dir) / final_filename

            logger.info(f"Normalisation de {temp_dest_path} vers {final_dest_path} via actions: {compat['actions']}")
            try:
                normalize_video(str(temp_dest_path), str(final_dest_path), compat["actions"])
                dest_path = final_dest_path
                # Extraire à nouveau les métadonnées sur le fichier normalisé final
                meta = extract_metadata(str(dest_path))
            finally:
                if temp_dest_path.exists():
                    os.remove(temp_dest_path)
        else:
            # Fichier compatible : déplacement direct vers le dossier de destination
            dest_filename = f"video_{file_id}_{clean_name}"
            dest_path = Path(settings.media_dir) / dest_filename
            logger.info(f"Déplacement direct de {src_path} vers {dest_path}")
            shutil.move(src_path, dest_path)

        # 3. Génération de la miniature
        try:
            thumbnail_path = generate_thumbnail(
                str(dest_path), settings.thumbnails_dir, meta["duration_seconds"]
            )
        except Exception as te:
            logger.error(f"Échec de la génération de miniature pour {dest_path}: {te}")
            thumbnail_path = None

        # 4. Enregistrement en base de données
        db = SessionLocal()
        try:
            # Génération d'un titre propre à partir du nom du fichier
            title = Path(original_filename).stem.replace("_", " ").replace("-", " ")
            
            # Parsing simple du programme et de la release (RPM, Sprint, The Trip)
            program = None
            release = None
            title_upper = title.upper()
            
            if "RPM" in title_upper:
                program = "RPM"
            elif "SPRINT" in title_upper:
                program = "Sprint"
            elif "TRIP" in title_upper or "THE TRIP" in title_upper:
                program = "The Trip"
            
            # Extraction d'un nombre pour la release
            import re
            match = re.search(r'\b\d{1,3}\b', title)
            if match:
                release = match.group(0)

            video = Video(
                file_path=str(dest_path),
                title=title,
                program=program,
                release=release,
                duration_seconds=meta["duration_seconds"],
                width=meta["width"],
                height=meta["height"],
                codec=meta["codec"],
                thumbnail_path=thumbnail_path,
                source=source
            )
            db.add(video)
            db.commit()
            db.refresh(video)
            logger.info(f"Vidéo indexée avec succès dans la base : {video.title} (ID: {video.id})")
            return video
        except Exception as dbe:
            db.rollback()
            logger.error(f"Erreur DB lors de l'enregistrement de {original_filename}: {dbe}")
            # Nettoyer les fichiers créés
            if dest_path and dest_path.exists():
                os.remove(dest_path)
            if thumbnail_path and Path(thumbnail_path).exists():
                os.remove(thumbnail_path)
            raise dbe
        finally:
            db.close()

    except Exception as e:
        logger.error(f"Erreur lors de l'importation de {original_filename}: {e}")
        # S'assurer que le fichier source est nettoyé s'il s'agissait du watcher
        if source == ImportSource.watched_folder and path_obj.exists():
            try:
                os.remove(src_path)
            except Exception:
                pass
        raise e
