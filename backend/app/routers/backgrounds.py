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
from app.models import Background, ImportSource
from app.utils.importer import import_background

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


@router.post("/upload", response_model=BackgroundResponse)
def upload_background(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    db: Session = Depends(get_db),
):
    """Upload web d'un fond animé (réf. F9.1, UX3.12)."""
    suffix = Path(file.filename).suffix.lower()
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            shutil.copyfileobj(file.file, temp_file)
            temp_path = temp_file.name

        background = import_background(temp_path, file.filename, ImportSource.upload)

        if title:
            db_bg = db.query(Background).filter(Background.id == background.id).first()
            if db_bg:
                db_bg.title = title
                db.commit()
                db.refresh(db_bg)
                return db_bg

        return background
    except Exception as e:
        logger.error(f"Erreur lors de l'upload et de l'import du fond animé: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))


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
