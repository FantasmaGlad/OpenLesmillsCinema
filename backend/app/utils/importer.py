import os
import time
import uuid
import shutil
import logging
from pathlib import Path

from app.config import settings
from app.database import SessionLocal
from app.models import Background, Video, ImportSource
from app.utils.activity_log import log_activity
from app.utils.video_utils import (
    extract_metadata,
    check_compatibility,
    generate_thumbnail,
    normalize_video,
)
from app.utils.import_jobs import update_job

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".mp4", ".m4v", ".mkv", ".avi", ".mov"}
# Fonds animés (Lot 7) : mêmes conteneurs que les cours, plus WebM (nativement
# lisible par Chromium, format courant pour des boucles d'ambiance courtes).
# Images fixes (réf. mission "fond figé ou animé" du mode coach) : un fond
# n'a plus besoin d'être une boucle vidéo — png/jpg/webp couvrent l'essentiel
# des visuels de marque déjà utilisés ailleurs dans l'appli (logo, etc.).
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
BACKGROUND_SUPPORTED_EXTENSIONS = SUPPORTED_EXTENSIONS | {".webm"} | IMAGE_EXTENSIONS


def is_image_background(file_path: str) -> bool:
    """Détecte un fond image fixe par extension (réf. mission "fond figé ou
    animé") — pas de colonne dédiée en base, la distinction ne sert qu'à
    orienter le pipeline d'import et le rendu (image vs boucle vidéo)."""
    return Path(file_path).suffix.lower() in IMAGE_EXTENSIONS


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


def import_video(src_path: str, original_filename: str, source: ImportSource, job_id: str | None = None) -> Video:
    """
    Gère le flux complet d'importation d'une vidéo :
    1. Attente de la stabilisation du fichier.
    2. Extraction des métadonnées et vérification des DRM.
    3. Déplacement/Normalisation du fichier dans le répertoire média final.
    4. Génération de la miniature.
    5. Insertion en base de données.

    `job_id` (réf. mission "queue en direct des importations") : identifiant
    optionnel d'une tâche déjà enregistrée via `app.utils.import_jobs`, mis à
    jour à chaque étape pour que l'UI d'admin affiche une progression réelle
    plutôt qu'un indicateur "en cours" muet. `None` (défaut) laisse la
    fonction utilisable telle quelle sans file à suivre (tests, appels
    existants).
    """
    path_obj = Path(src_path)

    # 1. Attendre la stabilisation du fichier (si c'est un fichier local / watcher)
    if source == ImportSource.watched_folder:
        if not wait_for_file_to_copy(src_path):
            raise TimeoutError(f"Le fichier {original_filename} ne s'est pas stabilisé dans le temps imparti.")

    # 2. Extraction des métadonnées
    update_job(job_id, stage="probing")
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
            update_job(job_id, stage="normalizing")
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
                normalize_video(str(temp_dest_path), str(final_dest_path), compat["actions"], source_metadata=meta)
                dest_path = final_dest_path
                # Extraire à nouveau les métadonnées sur le fichier normalisé final
                meta = extract_metadata(str(dest_path))
            finally:
                if temp_dest_path.exists():
                    os.remove(temp_dest_path)
        else:
            update_job(job_id, stage="copying")
            # Fichier compatible : déplacement direct vers le dossier de destination
            dest_filename = f"video_{file_id}_{clean_name}"
            dest_path = Path(settings.media_dir) / dest_filename
            logger.info(f"Déplacement direct de {src_path} vers {dest_path}")
            shutil.move(src_path, dest_path)

        # 3. Génération de la miniature
        update_job(job_id, stage="thumbnail")
        try:
            thumbnail_path = generate_thumbnail(
                str(dest_path), settings.thumbnails_dir, meta["duration_seconds"]
            )
        except Exception as te:
            logger.error(f"Échec de la génération de miniature pour {dest_path}: {te}")
            thumbnail_path = None

        # 4. Enregistrement en base de données
        update_job(job_id, stage="saving")
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
            # log_activity() fait son propre commit sur la même session, ce
            # qui réexpire les attributs déjà chargés de `video` (comportement
            # par défaut de SQLAlchemy) — un second refresh() est nécessaire
            # après, pendant que la session est encore ouverte, sinon le
            # premier accès à un attribut par l'appelant (après la fermeture
            # de la session) lève DetachedInstanceError.
            log_activity(
                db, "video_imported",
                f"{video.title} ({'téléversement' if source == ImportSource.upload else 'dossier surveillé'})",
            )
            db.refresh(video)
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


def _import_background_image(src_path: str, original_filename: str, job_id: str | None = None) -> Background:
    """Fond fixe (réf. mission "fond figé ou animé") : pipeline dédié, sans
    ffmpeg — une image n'a ni codec à valider ni normalisation à envisager,
    seule sa décodabilité compte (via Pillow)."""
    from PIL import Image, UnidentifiedImageError

    update_job(job_id, stage="probing")
    Path(settings.backgrounds_dir).mkdir(parents=True, exist_ok=True)
    Path(settings.thumbnails_dir).mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(src_path) as img:
            img.verify()
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError(f"Le fichier {original_filename} n'est pas une image valide : {e}")

    file_id = uuid.uuid4().hex
    ext = Path(original_filename).suffix.lower()
    dest_path = Path(settings.backgrounds_dir) / f"bg_{file_id}{ext}"
    shutil.move(src_path, dest_path)

    update_job(job_id, stage="thumbnail")
    thumbnail_path = None
    try:
        with Image.open(dest_path) as img:
            img = img.convert("RGB")
            img.thumbnail((640, 360))
            thumb_dest = Path(settings.thumbnails_dir) / f"thumb_{file_id}.jpg"
            img.save(thumb_dest, "JPEG", quality=85)
            thumbnail_path = str(thumb_dest)
    except Exception as te:
        logger.error(f"Échec de la génération de miniature pour {dest_path}: {te}")

    update_job(job_id, stage="saving")
    db = SessionLocal()
    try:
        title = Path(original_filename).stem.replace("_", " ").replace("-", " ")
        background = Background(
            file_path=str(dest_path),
            title=title,
            duration_seconds=None,
            thumbnail_path=thumbnail_path,
        )
        db.add(background)
        db.commit()
        db.refresh(background)
        logger.info(f"Fond animé (image) indexé avec succès : {background.title} (ID: {background.id})")
        log_activity(db, "background_imported", background.title)
        db.refresh(background)
        return background
    except Exception as dbe:
        db.rollback()
        logger.error(f"Erreur DB lors de l'enregistrement du fond {original_filename}: {dbe}")
        if dest_path.exists():
            os.remove(dest_path)
        if thumbnail_path and Path(thumbnail_path).exists():
            os.remove(thumbnail_path)
        raise dbe
    finally:
        db.close()


def import_background(
    src_path: str, original_filename: str, source: ImportSource, job_id: str | None = None
) -> Background:
    """
    Importe un fond animé (Lot 7, réf. F9.1) : même pipeline que import_video
    (stabilisation, métadonnées, normalisation si nécessaire, miniature) mais
    dans le dossier dédié `settings.backgrounds_dir`, sans parsing programme/
    release (non pertinent pour une boucle d'ambiance) et sans piste audio
    (les fonds animés sont toujours joués sans son, réf. F9.2).

    `job_id` : voir `import_video` — même mécanique de suivi de progression.
    """
    path_obj = Path(src_path)

    if source == ImportSource.watched_folder:
        if not wait_for_file_to_copy(src_path):
            raise TimeoutError(f"Le fichier {original_filename} ne s'est pas stabilisé dans le temps imparti.")

    if path_obj.suffix.lower() in IMAGE_EXTENSIONS:
        return _import_background_image(src_path, original_filename, job_id=job_id)

    update_job(job_id, stage="probing")
    meta = extract_metadata(src_path)

    if meta["is_drm"]:
        if path_obj.exists():
            try:
                os.remove(src_path)
            except Exception as e:
                logger.error(f"Impossible de supprimer le fichier DRM {src_path}: {e}")
        raise ValueError(
            f"Le fichier {original_filename} est protégé par DRM et ne peut pas être lu."
        )

    # strict_video_codec=True (réf. audit plan-corrections-bugs, point 6) :
    # un fond animé boucle indéfiniment, contrairement à un cours lu une
    # seule fois — seul H.264 est accepté tel quel ici.
    compat = check_compatibility(meta, src_path, strict_video_codec=True)

    file_id = uuid.uuid4().hex
    clean_name = "".join(c for c in original_filename if c.isalnum() or c in (".", "_", "-")).strip()

    Path(settings.backgrounds_dir).mkdir(parents=True, exist_ok=True)
    Path(settings.thumbnails_dir).mkdir(parents=True, exist_ok=True)

    dest_path = None
    thumbnail_path = None

    try:
        # Réutilise pleinement `compat["actions"]` (réf. audit
        # plan-corrections-bugs, point 6) — auparavant cette fonction gatait
        # la normalisation sur la seule extension du fichier (`suffix !=
        # ".mp4"`) et forçait toujours `["recode_container"]` en ignorant le
        # codec vidéo réel : un .mp4 avec un codec vidéo non validé passait
        # sans aucune vérification, et un conteneur non-mp4 (webm compris)
        # ne recevait jamais de réencodage vidéo même quand le codec source
        # posait problème pour une lecture en boucle. Un fond animé étant
        # justement destiné à boucler indéfiniment, on le traite au moins
        # aussi strictement qu'un cours (pas d'exemption webm : un WebM
        # "nativement lisible" par Chromium en lecture simple n'a jamais été
        # testé spécifiquement en boucle sur le Wyse).
        if compat["needs_normalization"]:
            update_job(job_id, stage="normalizing")
            temp_filename = f"temp_{file_id}_{clean_name}"
            temp_dest_path = Path(settings.backgrounds_dir) / temp_filename
            shutil.move(src_path, temp_dest_path)

            final_filename = f"bg_{file_id}_{Path(clean_name).stem}.mp4"
            final_dest_path = Path(settings.backgrounds_dir) / final_filename

            try:
                normalize_video(str(temp_dest_path), str(final_dest_path), compat["actions"], source_metadata=meta)
                dest_path = final_dest_path
                meta = extract_metadata(str(dest_path))
            finally:
                if temp_dest_path.exists():
                    os.remove(temp_dest_path)
        else:
            update_job(job_id, stage="copying")
            dest_filename = f"bg_{file_id}_{clean_name}"
            dest_path = Path(settings.backgrounds_dir) / dest_filename
            shutil.move(src_path, dest_path)

        update_job(job_id, stage="thumbnail")
        try:
            thumbnail_path = generate_thumbnail(
                str(dest_path), settings.thumbnails_dir, meta["duration_seconds"]
            )
        except Exception as te:
            logger.error(f"Échec de la génération de miniature pour {dest_path}: {te}")
            thumbnail_path = None

        update_job(job_id, stage="saving")
        db = SessionLocal()
        try:
            title = Path(original_filename).stem.replace("_", " ").replace("-", " ")
            background = Background(
                file_path=str(dest_path),
                title=title,
                duration_seconds=meta["duration_seconds"],
                thumbnail_path=thumbnail_path,
            )
            db.add(background)
            db.commit()
            db.refresh(background)
            logger.info(f"Fond animé indexé avec succès : {background.title} (ID: {background.id})")
            log_activity(db, "background_imported", background.title)
            db.refresh(background)  # log_activity() a réexpiré les attributs via son propre commit
            return background
        except Exception as dbe:
            db.rollback()
            logger.error(f"Erreur DB lors de l'enregistrement du fond {original_filename}: {dbe}")
            if dest_path and dest_path.exists():
                os.remove(dest_path)
            if thumbnail_path and Path(thumbnail_path).exists():
                os.remove(thumbnail_path)
            raise dbe
        finally:
            db.close()

    except Exception as e:
        logger.error(f"Erreur lors de l'importation du fond animé {original_filename}: {e}")
        if source == ImportSource.watched_folder and path_obj.exists():
            try:
                os.remove(src_path)
            except Exception:
                pass
        raise e


def reconcile_orphaned_media() -> None:
    """
    Filet de sécurité au démarrage (réf. correctif "le déplacement de fichier
    et le commit en base ne sont pas atomiques") : import_video/import_background
    déplacent déjà le fichier vers son dossier final AVANT le commit DB, avec
    un nettoyage sur exception Python (`except Exception as dbe`) — mais un
    crash DUR du processus (coupure électrique, kill -9) entre les deux
    n'est pas une exception Python à rattraper, et peut laisser un fichier à
    son emplacement final sans plus aucune ligne DB pour le référencer.

    Appelé une fois au démarrage (avant que le watcher ne traite quoi que ce
    soit de nouveau — aucun import n'est possible avant que l'app ait fini de
    démarrer, donc tout fichier trouvé ici provient forcément d'une exécution
    PRÉCÉDENTE) :
    - un fichier "temp_*" (jamais censé survivre à un import réussi, son
      propre `finally` le supprime toujours en cas de succès) est supprimé
      directement, sans risque ;
    - un fichier à son nom final sans ligne DB n'est que SIGNALÉ : le
      supprimer automatiquement serait destructif si ce diagnostic se
      trompait sur un cas non prévu, mieux vaut laisser l'administrateur
      l'examiner (visible dans le journal technique à chaque démarrage tant
      que non résolu, plutôt que perdu silencieusement).
    """
    db = SessionLocal()
    try:
        known_video_paths = {row[0] for row in db.query(Video.file_path).all()}
        known_background_paths = {row[0] for row in db.query(Background.file_path).all()}
    finally:
        db.close()

    for directory, known_paths in (
        (Path(settings.media_dir), known_video_paths),
        (Path(settings.backgrounds_dir), known_background_paths),
    ):
        if not directory.is_dir():
            continue
        for entry in directory.iterdir():
            if not entry.is_file():
                continue
            if entry.name.startswith("temp_"):
                try:
                    entry.unlink()
                    logger.warning(f"Fichier temporaire orphelin nettoyé au démarrage : {entry}")
                except OSError as e:
                    logger.error(f"Impossible de nettoyer le fichier temporaire orphelin {entry}: {e}")
                continue
            if str(entry) not in known_paths:
                logger.warning(
                    f"Fichier orphelin détecté (aucune ligne en base ne le référence) : {entry} — "
                    "probablement laissé par un arrêt brutal du service pendant un import. "
                    "À vérifier/nettoyer manuellement."
                )
