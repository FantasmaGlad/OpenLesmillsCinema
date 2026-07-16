import os
import uuid
import shutil
import logging
import tempfile
from pathlib import Path
from typing import List

from fastapi import (
    APIRouter,
    Depends,
    UploadFile,
    File,
    Form,
    HTTPException,
    BackgroundTasks,
)
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.models import Video, ImportSource
from app.config import settings
from app.utils.importer import import_video
from app.utils.video_utils import (
    extract_metadata,
    check_compatibility,
    normalize_video,
    generate_thumbnail,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos", tags=["videos"])


class VideoUpdate(BaseModel):
    title: str | None = None
    program: str | None = None
    release: str | None = None


class VideoResponse(BaseModel):
    id: int
    file_path: str
    title: str
    program: str | None
    release: str | None
    duration_seconds: float | None
    width: int | None
    height: int | None
    codec: str | None
    thumbnail_path: str | None
    source: str

    class Config:
        from_attributes = True


@router.post("/upload", response_model=VideoResponse)
def upload_video(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    program: str | None = Form(None),
    release: str | None = Form(None),
    db: Session = Depends(get_db),
):
    """
    Upload une vidéo en HTTP, l'enregistre sur disque et l'indexe (avec normalisation automatique si requise).
    """
    suffix = Path(file.filename).suffix.lower()
    # Créer un fichier temporaire pour stocker l'upload
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            shutil.copyfileobj(file.file, temp_file)
            temp_path = temp_file.name

        # Traiter et importer le fichier vidéo
        video = import_video(temp_path, file.filename, ImportSource.upload)

        # Mettre à jour avec les métadonnées fournies par le formulaire si présentes
        db_video = db.query(Video).filter(Video.id == video.id).first()
        if db_video:
            if title:
                db_video.title = title
            if program:
                db_video.program = program
            if release:
                db_video.release = release
            db.commit()
            db.refresh(db_video)
            return db_video

        return video
    except Exception as e:
        logger.error(f"Erreur lors de l'upload et de l'import de la vidéo: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[VideoResponse])
def list_videos(
    search: str | None = None,
    program: str | None = None,
    release: str | None = None,
    sort_by: str = "imported_at",
    order: str = "desc",
    db: Session = Depends(get_db),
):
    """
    Récupère la liste des vidéos de la bibliothèque avec filtres et tris.
    """
    query = db.query(Video)

    if search:
        query = query.filter(Video.title.ilike(f"%{search}%"))
    if program:
        query = query.filter(Video.program == program)
    if release:
        query = query.filter(Video.release == release)

    # Tris
    if sort_by == "title":
        col = Video.title
    elif sort_by == "duration":
        col = Video.duration_seconds
    else:
        col = Video.imported_at

    if order == "asc":
        query = query.order_by(col.asc())
    else:
        query = query.order_by(col.desc())

    return query.all()


@router.get("/{video_id}", response_model=VideoResponse)
def get_video(video_id: int, db: Session = Depends(get_db)):
    """
    Récupère les détails d'une vidéo spécifique.
    """
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")
    return video


@router.put("/{video_id}", response_model=VideoResponse)
def update_video(video_id: int, payload: VideoUpdate, db: Session = Depends(get_db)):
    """
    Met à jour les métadonnées modifiables d'une vidéo (titre, programme, release).
    Modifie également le nom physique du fichier sur disque pour rester cohérent avec le titre.
    """
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")

    # Si le titre change, renommer physiquement le fichier sur disque
    if payload.title is not None and payload.title != video.title:
        old_path = Path(video.file_path)
        if old_path.exists():
            import re
            # Tenter de conserver le même UUID s'il est présent dans le nom de fichier actuel
            match = re.match(r"^video_([a-f0-9]{32})_(.+)$", old_path.name)
            if match:
                uuid_str = match.group(1)
            else:
                uuid_str = uuid.uuid4().hex

            # Nettoyer et formater le nouveau titre pour le nom de fichier
            clean_title = "".join(c for c in payload.title if c.isalnum() or c in (" ", "_", "-")).strip()
            clean_title = clean_title.replace(" ", "_")
            if not clean_title:
                clean_title = "video"

            new_filename = f"video_{uuid_str}_{clean_title}{old_path.suffix}"
            new_path = old_path.parent / new_filename

            if new_path != old_path:
                try:
                    shutil.move(old_path, new_path)
                    video.file_path = str(new_path)
                    logger.info(f"Fichier vidéo physiquement renommé de {old_path.name} à {new_filename}")
                except Exception as e:
                    logger.error(f"Erreur lors du renommage physique du fichier vidéo {old_path} -> {new_path}: {e}")

        video.title = payload.title

    if payload.program is not None:
        video.program = payload.program
    if payload.release is not None:
        video.release = payload.release

    db.commit()
    db.refresh(video)
    return video


@router.delete("/{video_id}")
def delete_video(video_id: int, db: Session = Depends(get_db)):
    """
    Supprime physiquement les fichiers de la vidéo et de sa miniature, puis supprime son entrée en BDD.
    """
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")

    # Suppression du fichier vidéo
    if video.file_path:
        p = Path(video.file_path)
        if p.exists():
            try:
                os.remove(p)
            except Exception as e:
                logger.error(f"Impossible de supprimer le fichier média {p}: {e}")

    # Suppression de la miniature
    if video.thumbnail_path:
        p = Path(video.thumbnail_path)
        if p.exists():
            try:
                os.remove(p)
            except Exception as e:
                logger.error(f"Impossible de supprimer la miniature {p}: {e}")

    db.delete(video)
    db.commit()
    return {"message": "Vidéo supprimée avec succès"}


def bg_normalize(video_id: int, actions: list):
    """
    Tâche en arrière-plan pour normaliser une vidéo existante de manière asynchrone.
    """
    db = SessionLocal()
    try:
        video = db.query(Video).filter(Video.id == video_id).first()
        if not video:
            return

        old_path = Path(video.file_path)
        file_id = uuid.uuid4().hex
        clean_name = old_path.name
        temp_dest_path = old_path.parent / f"temp_{file_id}_{clean_name}"

        # Déplacement temporaire
        shutil.move(old_path, temp_dest_path)

        # Cible finale (.mp4)
        new_name = f"video_{file_id}_{old_path.stem}.mp4"
        new_path = old_path.parent / new_name

        try:
            normalize_video(str(temp_dest_path), str(new_path), actions)

            # Re-extraction des métadonnées finales
            meta = extract_metadata(str(new_path))

            # Mettre à jour l'enregistrement DB
            video.file_path = str(new_path)
            video.duration_seconds = meta["duration_seconds"]
            video.width = meta["width"]
            video.height = meta["height"]
            video.codec = meta["codec"]

            # Régénérer la miniature
            if video.thumbnail_path:
                try:
                    os.remove(video.thumbnail_path)
                except Exception:
                    pass

            try:
                thumb_path = generate_thumbnail(
                    str(new_path), settings.thumbnails_dir, meta["duration_seconds"]
                )
                video.thumbnail_path = thumb_path
            except Exception as te:
                logger.error(f"Miniature post-normalisation échouée: {te}")

            db.commit()
            logger.info(f"Vidéo ID {video_id} normalisée avec succès en tâche de fond.")
        finally:
            if temp_dest_path.exists():
                os.remove(temp_dest_path)

    except Exception as e:
        logger.error(f"Erreur lors de la normalisation en tâche de fond de la vidéo {video_id}: {e}")
    finally:
        db.close()


@router.post("/{video_id}/normalize")
def manual_normalize(
    video_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Déclenche manuellement la normalisation d'une vidéo si elle n'est pas Direct Play.
    """
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")

    # Extraire les infos réelles pour vérifier les besoins
    try:
        meta = extract_metadata(video.file_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Impossible d'analyser la vidéo : {e}")

    compat = check_compatibility(meta, video.file_path)
    if not compat["needs_normalization"]:
        return {"message": "La vidéo est déjà compatible Direct Play, aucune action requise."}

    background_tasks.add_task(bg_normalize, video_id, compat["actions"])
    return {"message": "La tâche de normalisation a été démarrée en tâche de fond."}
