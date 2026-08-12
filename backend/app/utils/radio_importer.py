"""Import de morceaux dans la bibliothèque Radio (réf. docs/cahier-des-charges-radio.md §5.3).

Chaque fichier musical devient un `RadioTrack` indépendant (contrairement aux
cours audio coach regroupés) : métadonnées ID3 + pochette extraites, fichier
déplacé dans `radio_dir` (ou transcodé en AAC si le navigateur ne le lit pas),
pochette écrite dans `radio_covers_dir`.
"""
import logging
import os
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from app.config import settings
from app.database import SessionLocal
from app.models import ImportSource, RadioAnnouncement, RadioCoverSource, RadioTrack
from app.utils.activity_log import log_activity
from app.utils.import_jobs import update_job
from app.utils.radio_utils import (
    AUDIO_EXTENSIONS,
    extract_embedded_cover,
    extract_radio_metadata,
    needs_transcode,
    normalize_announcement_loudness,
    transcode_to_web,
)

logger = logging.getLogger(__name__)


def _ingest_one(db, src_path: Path, source: ImportSource) -> RadioTrack:
    """Ingère un fichier : métadonnées + pochette + placement disque + ligne DB.
    N'effectue PAS le commit (fait par lot dans l'appelant)."""
    file_id = uuid.uuid4().hex
    meta = extract_radio_metadata(str(src_path))

    # Pochette extraite depuis le fichier SOURCE (le transcodage AAC ci-dessous
    # retire la pochette embarquée avec `-vn`), avant tout déplacement.
    cover_path = extract_embedded_cover(str(src_path), settings.radio_covers_dir, file_id)

    Path(settings.radio_dir).mkdir(parents=True, exist_ok=True)
    if needs_transcode(str(src_path)):
        dest_path = Path(settings.radio_dir) / f"track_{file_id}.m4a"
        transcode_to_web(str(src_path), str(dest_path))
        # Durée inchangée par le transcodage ; on garde celle des métadonnées.
        try:
            os.remove(src_path)
        except OSError:
            pass
    else:
        dest_path = Path(settings.radio_dir) / f"track_{file_id}{src_path.suffix.lower()}"
        shutil.move(str(src_path), dest_path)

    track = RadioTrack(
        file_path=str(dest_path),
        title=meta["title"],
        artist=meta["artist"],
        album=meta["album"],
        album_artist=meta["album_artist"],
        track_number=meta["track_number"],
        disc_number=meta["disc_number"],
        year=meta["year"],
        genre=meta["genre"],
        duration_seconds=meta["duration_seconds"],
        cover_path=cover_path,
        cover_source=RadioCoverSource.id3 if cover_path else RadioCoverSource.none,
        source=source,
    )
    db.add(track)
    return track


def import_radio_tracks_from_files(
    paths: list[str], source: ImportSource = ImportSource.upload, job_id: str | None = None
) -> list[RadioTrack]:
    """Importe une liste de fichiers audio (déjà sur disque). Chaque fichier est
    indépendant : un échec isolé est journalisé sans faire tomber le lot entier.
    Lève seulement si AUCUN fichier n'a pu être importé."""
    audio_paths = [Path(p) for p in paths if Path(p).suffix.lower() in AUDIO_EXTENSIONS and not Path(p).name.startswith(".")]
    if not audio_paths:
        raise ValueError("Aucun fichier audio pris en charge fourni pour l'import radio.")

    update_job(job_id, stage="saving")
    db = SessionLocal()
    created: list[RadioTrack] = []
    try:
        for src in audio_paths:
            if not src.exists():
                continue
            try:
                created.append(_ingest_one(db, src, source))
            except Exception as e:
                logger.error(f"Import radio : échec pour {src.name} : {e}")

        if not created:
            raise ValueError("Aucun morceau n'a pu être importé (tous les fichiers ont échoué).")

        db.commit()
        for track in created:
            db.refresh(track)
        logger.info(f"Import radio : {len(created)} morceau(x) importé(s).")
        log_activity(db, "radio_tracks_imported", f"{len(created)} morceau(x)")
        # Recharge les ids/valeurs après le commit d'activity_log (expire_on_commit).
        ids = [t.id for t in created]
        return db.query(RadioTrack).filter(RadioTrack.id.in_(ids)).all()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def import_radio_tracks_from_zip(zip_path: str, job_id: str | None = None) -> list[RadioTrack]:
    """Extrait une archive ZIP puis importe tous les fichiers audio qu'elle
    contient (récursivement)."""
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

        audio_paths = sorted(
            str(p) for p in Path(tmp_dir).rglob("*")
            if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS and not p.name.startswith(".")
        )
        if not audio_paths:
            raise ValueError("Aucun fichier audio trouvé dans l'archive ZIP.")

        return import_radio_tracks_from_files(audio_paths, source=ImportSource.upload, job_id=job_id)


def import_radio_track_from_watched_file(file_path: str, job_id: str | None = None) -> list[RadioTrack]:
    """Import d'un fichier unique déposé dans le dossier surveillé radio."""
    return import_radio_tracks_from_files([file_path], source=ImportSource.watched_folder, job_id=job_id)


def import_radio_announcement(file_path: str, description: str, db) -> RadioAnnouncement:
    """Importe un rappel (réf. lot L6, D11-D13) : fichier unique + description
    OBLIGATOIRE, saisie en même temps que l'upload — pas de traitement en
    arrière-plan (pas de dossier surveillé pour les rappels, cf. §10.2 :
    une description manuelle est de toute façon requise). Effectue le commit."""
    src = Path(file_path)
    if src.suffix.lower() not in AUDIO_EXTENSIONS:
        raise ValueError(f"Format audio non pris en charge : {src.suffix}")

    file_id = uuid.uuid4().hex
    meta = extract_radio_metadata(str(src))

    Path(settings.radio_announcements_dir).mkdir(parents=True, exist_ok=True)
    # Normalisation loudness systématique (réf. correctif « rappel quasi
    # inaudible ») : on ré-encode toujours en AAC/.m4a avec loudnorm, pour que
    # le rappel s'entende à une puissance comparable à la musique masterisée.
    dest_path = Path(settings.radio_announcements_dir) / f"announcement_{file_id}.m4a"
    normalize_announcement_loudness(str(src), str(dest_path))

    announcement = RadioAnnouncement(
        file_path=str(dest_path), description=description, duration_seconds=meta["duration_seconds"],
    )
    db.add(announcement)
    db.commit()
    db.refresh(announcement)
    log_activity(db, "radio_announcement_imported", description)
    return announcement
