import logging
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Playlist, PlaylistItem, Video
from app.utils.activity_log import log_activity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/playlists", tags=["playlists"])


# Pydantic Schemas
class PlaylistItemInput(BaseModel):
    video_id: int
    position: int | None = None


class PlaylistInput(BaseModel):
    name: str
    items: List[PlaylistItemInput] = []


class VideoResponse(BaseModel):
    id: int
    title: str
    program: str | None = None
    release: str | None = None
    duration_seconds: float | None = None
    thumbnail_path: str | None = None

    class Config:
        from_attributes = True


class PlaylistItemResponse(BaseModel):
    id: int
    position: int
    video: VideoResponse

    class Config:
        from_attributes = True


class PlaylistDetailResponse(BaseModel):
    id: int
    name: str
    created_at: datetime
    items: List[PlaylistItemResponse]
    total_duration_seconds: float

    class Config:
        from_attributes = True


class PlaylistSummaryResponse(BaseModel):
    id: int
    name: str
    created_at: datetime
    item_count: int
    total_duration_seconds: float

    class Config:
        from_attributes = True


@router.get("", response_model=List[PlaylistSummaryResponse])
def list_playlists(db: Session = Depends(get_db)):
    """
    Liste toutes les playlists avec le nombre d'éléments et la durée totale.
    """
    playlists = db.query(Playlist).order_by(Playlist.name.asc()).all()
    response = []
    for p in playlists:
        total_duration = sum((item.video.duration_seconds or 0.0) for item in p.items)
        response.append({
            "id": p.id,
            "name": p.name,
            "created_at": p.created_at,
            "item_count": len(p.items),
            "total_duration_seconds": total_duration,
        })
    return response


@router.get("/{playlist_id}", response_model=PlaylistDetailResponse)
def get_playlist(playlist_id: int, db: Session = Depends(get_db)):
    """
    Détails d'une playlist avec ses éléments ordonnés et les métadonnées des vidéos associées.
    """
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist non trouvée")

    # Trier les éléments par position
    sorted_items = sorted(playlist.items, key=lambda x: x.position)
    total_duration = sum((item.video.duration_seconds or 0.0) for item in playlist.items)

    return {
        "id": playlist.id,
        "name": playlist.name,
        "created_at": playlist.created_at,
        "items": sorted_items,
        "total_duration_seconds": total_duration,
    }


@router.post("", response_model=PlaylistDetailResponse)
def create_playlist(data: PlaylistInput, db: Session = Depends(get_db)):
    """
    Crée une nouvelle playlist avec ses éléments.
    """
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Le nom de la playlist ne peut pas être vide")

    playlist = Playlist(name=data.name.strip())
    db.add(playlist)
    db.flush()  # Récupère l'id de la playlist

    # Ajouter les éléments de la playlist
    for i, item_input in enumerate(data.items):
        video = db.query(Video).filter(Video.id == item_input.video_id).first()
        if not video:
            raise HTTPException(status_code=400, detail=f"Vidéo {item_input.video_id} introuvable")

        position = item_input.position if item_input.position is not None else i
        item = PlaylistItem(
            playlist_id=playlist.id,
            video_id=video.id,
            position=position
        )
        db.add(item)

    db.commit()
    db.refresh(playlist)
    log_activity(db, "playlist_created", f"{playlist.name} ({len(data.items)} cours)")

    # Re-requêter les détails pour renvoyer la réponse structurée
    return get_playlist(playlist.id, db)


@router.put("/{playlist_id}", response_model=PlaylistDetailResponse)
def update_playlist(playlist_id: int, data: PlaylistInput, db: Session = Depends(get_db)):
    """
    Met à jour le nom et/ou les éléments d'une playlist (remplace proprement la liste ordonnée des éléments).
    """
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist non trouvée")

    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Le nom de la playlist ne peut pas être vide")

    playlist.name = data.name.strip()

    # Supprimer les anciens éléments
    db.query(PlaylistItem).filter(PlaylistItem.playlist_id == playlist.id).delete()

    # Ajouter les nouveaux éléments
    for i, item_input in enumerate(data.items):
        video = db.query(Video).filter(Video.id == item_input.video_id).first()
        if not video:
            raise HTTPException(status_code=400, detail=f"Vidéo {item_input.video_id} introuvable")

        position = item_input.position if item_input.position is not None else i
        item = PlaylistItem(
            playlist_id=playlist.id,
            video_id=video.id,
            position=position
        )
        db.add(item)

    db.commit()
    db.refresh(playlist)
    log_activity(db, "playlist_updated", playlist.name)

    return get_playlist(playlist.id, db)


@router.delete("/{playlist_id}")
def delete_playlist(playlist_id: int, db: Session = Depends(get_db)):
    """
    Supprime la playlist (les éléments associés sont supprimés en cascade).
    """
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist non trouvée")

    name = playlist.name
    db.delete(playlist)
    db.commit()
    log_activity(db, "playlist_deleted", name)
    return {"message": "Playlist supprimée avec succès"}


@router.post("/{playlist_id}/duplicate", response_model=PlaylistDetailResponse)
def duplicate_playlist(playlist_id: int, db: Session = Depends(get_db)):
    """
    Duplique une playlist existante (copie le nom en y ajoutant " (copie)" et clone ses éléments).
    """
    original = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not original:
        raise HTTPException(status_code=404, detail="Playlist non trouvée")

    new_name = f"{original.name} (copie)"
    copy_playlist = Playlist(name=new_name)
    db.add(copy_playlist)
    db.flush()

    for item in original.items:
        copy_item = PlaylistItem(
            playlist_id=copy_playlist.id,
            video_id=item.video_id,
            position=item.position
        )
        db.add(copy_item)

    db.commit()
    db.refresh(copy_playlist)

    return get_playlist(copy_playlist.id, db)
