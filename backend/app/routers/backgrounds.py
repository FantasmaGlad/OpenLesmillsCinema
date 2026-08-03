import os
import shutil
import logging
import tempfile
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from pydantic import BaseModel, computed_field
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.models import Background, ImportSource
from app.utils.importer import import_background, is_image_background
from app.utils.executors import ffmpeg_executor
from app.utils.import_jobs import create_job, update_job

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backgrounds", tags=["backgrounds"])


class BackgroundUpdate(BaseModel):
    title: str | None = None


class BackgroundResponse(BaseModel):
    id: int
    file_path: str
    title: str
    duration_seconds: float | None
    thumbnail_path: str | None

    class Config:
        from_attributes = True

    # Réf. mission "fond figé ou animé" : pas de colonne dédiée en base,
    # dérivé de l'extension du fichier pour que le kiosk et les écrans admin
    # sachent rendre une <img> plutôt qu'une <video> en boucle.
    @computed_field
    @property
    def is_image(self) -> bool:
        return is_image_background(self.file_path)


class ImportJobAccepted(BaseModel):
    job_id: str


def _run_background_import_job(job_id: str, temp_path: str, filename: str, title: str | None) -> None:
    """Voir `videos.py::_run_video_import_job` — même mécanique (exécuteur
    ffmpeg partagé, réf. audit plan-corrections-bugs point 5 ; job suivi via
    `app.utils.import_jobs`, réf. mission "voir en direct les imports")."""
    try:
        background = import_background(temp_path, filename, ImportSource.upload, job_id=job_id)

        if title:
            db = SessionLocal()
            try:
                db_bg = db.query(Background).filter(Background.id == background.id).first()
                if db_bg:
                    db_bg.title = title
                    db.commit()
            finally:
                db.close()

        update_job(job_id, stage="done", result_id=background.id)
    except Exception as e:
        logger.error(f"Erreur lors de l'upload et de l'import du fond animé (job {job_id}): {e}", exc_info=True)
        update_job(job_id, stage="error", error=str(e))


@router.post("/upload", response_model=ImportJobAccepted, status_code=202)
def upload_background(
    file: UploadFile = File(...),
    title: str | None = Form(None),
):
    """Upload web d'un fond animé (réf. F9.1, UX3.12) — traité en arrière-plan,
    voir `_run_background_import_job` et `GET /api/import-jobs`."""
    suffix = Path(file.filename).suffix.lower()
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            shutil.copyfileobj(file.file, temp_file)
            temp_path = temp_file.name
    except Exception as e:
        logger.error(f"Erreur lors de la réception de l'upload du fond animé: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))

    job_id = create_job("background", file.filename, title or Path(file.filename).stem)
    ffmpeg_executor.submit(_run_background_import_job, job_id, temp_path, file.filename, title)
    return {"job_id": job_id}


@router.get("", response_model=List[BackgroundResponse])
def list_backgrounds(db: Session = Depends(get_db)):
    return db.query(Background).order_by(Background.imported_at.desc()).all()


@router.get("/{background_id}", response_model=BackgroundResponse)
def get_background(background_id: int, db: Session = Depends(get_db)):
    background = db.query(Background).filter(Background.id == background_id).first()
    if not background:
        raise HTTPException(status_code=404, detail="Fond animé non trouvé")
    return background


@router.put("/{background_id}", response_model=BackgroundResponse)
def update_background(background_id: int, payload: BackgroundUpdate, db: Session = Depends(get_db)):
    background = db.query(Background).filter(Background.id == background_id).first()
    if not background:
        raise HTTPException(status_code=404, detail="Fond animé non trouvé")
    if payload.title is not None and payload.title.strip():
        background.title = payload.title.strip()
    db.commit()
    db.refresh(background)
    return background


@router.delete("/{background_id}")
def delete_background(background_id: int, db: Session = Depends(get_db)):
    background = db.query(Background).filter(Background.id == background_id).first()
    if not background:
        raise HTTPException(status_code=404, detail="Fond animé non trouvé")

    if background.file_path:
        p = Path(background.file_path)
        if p.exists():
            try:
                os.remove(p)
            except Exception as e:
                logger.error(f"Impossible de supprimer le fichier de fond {p}: {e}")

    if background.thumbnail_path:
        p = Path(background.thumbnail_path)
        if p.exists():
            try:
                os.remove(p)
            except Exception as e:
                logger.error(f"Impossible de supprimer la miniature {p}: {e}")

    db.delete(background)
    db.commit()
    return {"message": "Fond animé supprimé avec succès"}
