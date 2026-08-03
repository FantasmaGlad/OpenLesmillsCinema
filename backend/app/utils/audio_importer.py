import os
import re
import time
import uuid
import shutil
import zipfile
import logging
import tempfile
from pathlib import Path

from app.config import settings
from app.database import SessionLocal
from app.models import AudioCourse, AudioTrack
from app.utils.activity_log import log_activity
from app.utils.audio_utils import extract_audio_duration, parse_track_number_and_title
from app.utils.import_jobs import update_job

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".mp3"}


def _guess_program(title: str) -> str | None:
    upper = title.upper()
    if "RPM" in upper:
        return "RPM"
    if "SPRINT" in upper:
        return "Sprint"
    if "TRIP" in upper:
        return "The Trip"
    return None


def _guess_release(title: str) -> str | None:
    match = re.search(r"\b\d{1,3}\b", title)
    return match.group(0) if match else None


def wait_for_folder_to_stabilize(dir_path: str, stable_secs: int = 3, timeout: int = 300) -> bool:
    """
    Variante de `importer.wait_for_file_to_copy` pour un dossier entier :
    attend que la taille CUMULÉE de tous les fichiers qu'il contient cesse de
    changer (copie de plusieurs MP3 en cours dans le dossier surveillé des
    cours audio, réf. F10.1).
    """
    last_total = -1
    stable_since = 0
    start_time = time.time()

    while time.time() - start_time < timeout:
        path = Path(dir_path)
        if not path.exists():
            time.sleep(0.5)
            continue

        try:
            files = [p for p in path.iterdir() if p.is_file() and not p.name.startswith(".")]
            total = sum(p.stat().st_size for p in files)
        except OSError:
            time.sleep(0.5)
            continue

        if total == last_total and total > 0 and files:
            stable_since += 1
            if stable_since >= stable_secs:
                return True
        else:
            last_total = total
            stable_since = 0

        time.sleep(1)

    return False


def import_audio_course_from_files(
    mp3_paths: list[str],
    course_title: str,
    program: str | None = None,
    release: str | None = None,
    job_id: str | None = None,
) -> AudioCourse:
    """
    Importe un cours audio à partir d'une liste de fichiers MP3 déjà présents
    sur disque (réf. F10.1/F10.2) : les déplace dans un sous-dossier dédié de
    `settings.audio_dir`, extrait durée/numéro/titre par piste (ffprobe +
    parsing du nom de fichier), crée le cours et ses pistes en base dans
    l'ordre déduit du nom de fichier (réordonnable ensuite depuis l'UI).

    `job_id` (réf. mission "queue en direct des importations") : voir
    `app.utils.importer.import_video` pour la même mécanique de suivi.
    """
    if not mp3_paths:
        raise ValueError("Aucun fichier MP3 fourni pour l'import du cours audio.")

    update_job(job_id, stage="probing")
    course_dir = Path(settings.audio_dir) / f"course_{uuid.uuid4().hex}"
    course_dir.mkdir(parents=True, exist_ok=True)

    parsed = []
    for src in mp3_paths:
        src_path = Path(src)
        number, title = parse_track_number_and_title(src_path.name)
        parsed.append((number, title, src_path))

    # Tri : par numéro déduit du nom de fichier si présent, sinon par nom (ordre stable)
    parsed.sort(key=lambda t: (t[0] is None, t[0] if t[0] is not None else 0, str(t[2])))

    update_job(job_id, stage="saving")
    db = SessionLocal()
    try:
        course = AudioCourse(
            title=course_title,
            program=program if program else _guess_program(course_title),
            release=release if release else _guess_release(course_title),
        )
        db.add(course)
        db.flush()

        for position, (number, title, src_path) in enumerate(parsed):
            duration = extract_audio_duration(str(src_path))
            dest_name = f"track_{uuid.uuid4().hex}{src_path.suffix.lower()}"
            dest_path = course_dir / dest_name
            shutil.move(str(src_path), dest_path)

            track = AudioTrack(
                audio_course_id=course.id,
                number=number,
                title=title or f"Piste {position + 1}",
                file_path=str(dest_path),
                duration_seconds=duration,
                position=position,
            )
            db.add(track)

        db.commit()
        db.refresh(course)
        logger.info(f"Cours audio importé : {course.title} ({len(parsed)} piste(s), ID {course.id})")
        # log_activity() fait son propre commit (sur la même session), ce qui
        # réexpire tous les attributs déjà chargés de `course` (comportement
        # par défaut de SQLAlchemy, expire_on_commit=True) — il doit donc
        # s'exécuter AVANT le chargement forcé de `tracks` ci-dessous, pas après.
        log_activity(db, "audio_course_imported", f"{course.title} ({len(parsed)} piste(s))")
        # Force le chargement de la relation `tracks` pendant que la session
        # est encore ouverte : l'appelant (routeur FastAPI ou test) accède à
        # `course.tracks` après le retour de cette fonction, une fois la
        # session fermée (DetachedInstanceError sinon — la relation est lazy
        # par défaut et `refresh()` seul ne recharge que les colonnes).
        _ = list(course.tracks)
        return course
    except Exception as e:
        db.rollback()
        if course_dir.exists():
            shutil.rmtree(course_dir, ignore_errors=True)
        logger.error(f"Erreur lors de l'import du cours audio {course_title}: {e}")
        raise e
    finally:
        db.close()


def import_audio_course_from_zip(
    zip_path: str,
    course_title: str,
    program: str | None = None,
    release: str | None = None,
    job_id: str | None = None,
) -> AudioCourse:
    """Extrait une archive ZIP d'un cours complet puis importe les MP3 qu'elle contient (réf. F10.1)."""
    update_job(job_id, stage="extracting")
    with tempfile.TemporaryDirectory() as tmp_dir:
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(tmp_dir)
        except zipfile.BadZipFile:
            raise ValueError("L'archive ZIP est invalide ou corrompue.")
        finally:
            if Path(zip_path).exists():
                os.remove(zip_path)

        mp3_paths = sorted(
            str(p) for p in Path(tmp_dir).rglob("*")
            if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS and not p.name.startswith(".")
        )
        if not mp3_paths:
            raise ValueError("Aucun fichier MP3 trouvé dans l'archive ZIP.")

        return import_audio_course_from_files(mp3_paths, course_title, program, release, job_id=job_id)


def import_audio_course_from_watched_folder(course_dir: str, job_id: str | None = None) -> AudioCourse:
    """
    Importe un cours audio détecté par le watcher (réf. F10.1, import par
    dossier surveillé) : le nom du sous-dossier devient le titre du cours,
    tous les MP3 qu'il contient (à plat, non récursif) en deviennent les
    pistes.
    """
    path = Path(course_dir)
    course_title = path.name.replace("_", " ").replace("-", " ").strip() or "Cours importé"

    mp3_paths = sorted(
        str(p) for p in path.iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS and not p.name.startswith(".")
    )
    if not mp3_paths:
        raise ValueError(f"Le dossier {path.name} ne contient aucun fichier MP3.")

    course = import_audio_course_from_files(mp3_paths, course_title, job_id=job_id)

    # Le sous-dossier source (copié par l'utilisateur dans le dossier
    # surveillé) est maintenant vide de ses MP3 (déplacés dans audio_dir) :
    # on le supprime pour ne pas laisser un dossier fantôme derrière soi.
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass

    return course
