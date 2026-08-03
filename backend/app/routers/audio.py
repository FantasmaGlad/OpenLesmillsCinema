import os
import shutil
import logging
import tempfile
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AudioCourse, AudioTrack
from app.utils.audio_importer import import_audio_course_from_files, import_audio_course_from_zip
from app.utils.executors import io_executor
from app.utils.import_jobs import create_job, update_job

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/audio", tags=["audio"])


class AudioTrackResponse(BaseModel):
    id: int
    number: int | None
    title: str
    duration_seconds: float | None
    position: int

    class Config:
        from_attributes = True


class AudioCourseResponse(BaseModel):
    id: int
    title: str
    program: str | None
    release: str | None
    background_id: int | None
    track_count: int
    total_duration_seconds: float

    class Config:
        from_attributes = True


class AudioCourseDetailResponse(BaseModel):
    id: int
    title: str
    program: str | None
    release: str | None
    background_id: int | None
    tracks: List[AudioTrackResponse]

    class Config:
        from_attributes = True


class AudioCourseUpdate(BaseModel):
    title: str | None = None
    program: str | None = None
    release: str | None = None
    background_id: int | None = None
    clear_background: bool = False


class TrackReorderInput(BaseModel):
    track_ids: List[int]


class AudioTrackWithCourseResponse(BaseModel):
    """Piste individuelle avec le contexte de son cours d'origine (réf.
    mission "playlists spéciales... musiques de plusieurs RPM différents") :
    sert de source pour le sélecteur de pistes des playlists audio, qui pioche
    librement dans n'importe quel cours plutôt que de les enchaîner entiers."""
    id: int
    number: int | None
    title: str
    duration_seconds: float | None
    course_id: int
    course_title: str
    course_program: str | None


def _to_summary(course: AudioCourse) -> dict:
    return {
        "id": course.id,
        "title": course.title,
        "program": course.program,
        "release": course.release,
        "background_id": course.background_id,
        "track_count": len(course.tracks),
        "total_duration_seconds": sum(t.duration_seconds or 0.0 for t in course.tracks),
    }


@router.get("", response_model=List[AudioCourseResponse])
def list_audio_courses(db: Session = Depends(get_db)):
    courses = db.query(AudioCourse).order_by(AudioCourse.imported_at.desc()).all()
    return [_to_summary(c) for c in courses]


@router.get("/tracks", response_model=List[AudioTrackWithCourseResponse])
def list_all_tracks(db: Session = Depends(get_db)):
    """
    Toutes les pistes de tous les cours audio, à plat, avec leur contexte de
    cours d'origine (réf. mission "playlists spéciales... des musiques de
    plusieurs RPM différents, pas juste plusieurs RPM collés") : source du
    sélecteur de pistes des playlists audio — DOIT être déclarée avant
    `/{course_id}` pour ne pas être interceptée par cette route paramétrée.
    """
    tracks = (
        db.query(AudioTrack)
        .join(AudioCourse, AudioTrack.audio_course_id == AudioCourse.id)
        .order_by(AudioCourse.title.asc(), AudioTrack.position.asc())
        .all()
    )
    return [
        {
            "id": t.id,
            "number": t.number,
            "title": t.title,
            "duration_seconds": t.duration_seconds,
            "course_id": t.course.id,
            "course_title": t.course.title,
            "course_program": t.course.program,
        }
        for t in tracks
    ]


@router.get("/{course_id}", response_model=AudioCourseDetailResponse)
def get_audio_course(course_id: int, db: Session = Depends(get_db)):
    course = db.query(AudioCourse).filter(AudioCourse.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Cours audio non trouvé")
    return course


class ImportJobAccepted(BaseModel):
    job_id: str


def _run_audio_files_import_job(
    job_id: str, tmp_dir: Path, temp_paths: list[str], title: str, program: str | None, release: str | None
) -> None:
    """Voir `videos.py::_run_video_import_job` — même mécanique de suivi. Sur
    `io_executor` (pas `ffmpeg_executor`) : cet import n'appelle que ffprobe,
    pas de réencodage ffmpeg (réf. watcher.py, même choix pour le dossier
    surveillé), donc pas de raison de faire la queue derrière un import
    vidéo/fond en cours."""
    try:
        course = import_audio_course_from_files(temp_paths, title, program, release, job_id=job_id)
        update_job(job_id, stage="done", result_id=course.id)
    except Exception as e:
        logger.error(f"Erreur lors de l'upload du cours audio (job {job_id}): {e}", exc_info=True)
        update_job(job_id, stage="error", error=str(e))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _run_audio_zip_import_job(
    job_id: str, temp_path: str, title: str, program: str | None, release: str | None
) -> None:
    try:
        course = import_audio_course_from_zip(temp_path, title, program, release, job_id=job_id)
        update_job(job_id, stage="done", result_id=course.id)
    except Exception as e:
        logger.error(f"Erreur lors de l'upload ZIP du cours audio (job {job_id}): {e}", exc_info=True)
        update_job(job_id, stage="error", error=str(e))


@router.post("/upload", response_model=ImportJobAccepted, status_code=202)
def upload_audio_course(
    files: List[UploadFile] = File(...),
    title: str = Form(...),
    program: str | None = Form(None),
    release: str | None = Form(None),
):
    """Import multi-fichiers MP3 d'un cours (réf. F10.1, UX3.11), traité en
    arrière-plan — voir `_run_audio_files_import_job` et `GET /api/import-jobs`."""
    if not title.strip():
        raise HTTPException(status_code=400, detail="Le titre du cours est requis")

    # Dossier temporaire dédié à cette requête : chaque fichier y garde son
    # nom d'origine intact (le numéro de piste en tête de nom, réf. F10.1,
    # doit rester parsable — un fichier temporaire renommé le perdrait).
    tmp_dir = Path(tempfile.mkdtemp(prefix="olmc_audio_upload_"))
    temp_paths = []
    try:
        for f in files:
            dest = tmp_dir / Path(f.filename).name
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out)
            temp_paths.append(str(dest))
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        logger.error(f"Erreur lors de la réception de l'upload du cours audio: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))

    job_id = create_job("audio", title.strip(), title.strip())
    io_executor.submit(_run_audio_files_import_job, job_id, tmp_dir, temp_paths, title.strip(), program, release)
    return {"job_id": job_id}


@router.post("/upload-zip", response_model=ImportJobAccepted, status_code=202)
def upload_audio_course_zip(
    file: UploadFile = File(...),
    title: str = Form(...),
    program: str | None = Form(None),
    release: str | None = Form(None),
):
    """Import d'une archive ZIP d'un cours complet (réf. F10.1, UX3.11),
    traité en arrière-plan — voir `_run_audio_zip_import_job` et
    `GET /api/import-jobs`."""
    if not title.strip():
        raise HTTPException(status_code=400, detail="Le titre du cours est requis")

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as temp_file:
            shutil.copyfileobj(file.file, temp_file)
            temp_path = temp_file.name
    except Exception as e:
        logger.error(f"Erreur lors de la réception de l'upload ZIP du cours audio: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))

    job_id = create_job("audio", title.strip(), title.strip())
    io_executor.submit(_run_audio_zip_import_job, job_id, temp_path, title.strip(), program, release)
    return {"job_id": job_id}


@router.put("/{course_id}", response_model=AudioCourseDetailResponse)
def update_audio_course(course_id: int, payload: AudioCourseUpdate, db: Session = Depends(get_db)):
    course = db.query(AudioCourse).filter(AudioCourse.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Cours audio non trouvé")

    if payload.title is not None and payload.title.strip():
        course.title = payload.title.strip()
    if payload.program is not None:
        course.program = payload.program
    if payload.release is not None:
        course.release = payload.release
    if payload.clear_background:
        course.background_id = None
    elif payload.background_id is not None:
        course.background_id = payload.background_id

    db.commit()
    db.refresh(course)
    return course


@router.put("/{course_id}/tracks/reorder", response_model=AudioCourseDetailResponse)
def reorder_tracks(course_id: int, payload: TrackReorderInput, db: Session = Depends(get_db)):
    """Réordonnancement des pistes par glisser-déposer (réf. UX3.10)."""
    course = db.query(AudioCourse).filter(AudioCourse.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Cours audio non trouvé")

    tracks_by_id = {t.id: t for t in course.tracks}
    if set(payload.track_ids) != set(tracks_by_id.keys()):
        raise HTTPException(status_code=400, detail="La liste fournie ne correspond pas exactement aux pistes du cours")

    for position, track_id in enumerate(payload.track_ids):
        tracks_by_id[track_id].position = position

    db.commit()
    db.refresh(course)
    return course


@router.delete("/{course_id}")
def delete_audio_course(course_id: int, db: Session = Depends(get_db)):
    course = db.query(AudioCourse).filter(AudioCourse.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Cours audio non trouvé")

    for track in course.tracks:
        if track.file_path:
            p = Path(track.file_path)
            if p.exists():
                try:
                    # Supprime aussi le dossier parent (dédié au cours) s'il devient vide.
                    os.remove(p)
                    if p.parent.exists() and not any(p.parent.iterdir()):
                        p.parent.rmdir()
                except Exception as e:
                    logger.error(f"Impossible de supprimer la piste {p}: {e}")

    db.delete(course)
    db.commit()
    return {"message": "Cours audio supprimé avec succès"}
