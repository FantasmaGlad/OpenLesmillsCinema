import logging
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AudioPlaylist, AudioPlaylistItem, AudioTrack, Background
from app.utils.activity_log import log_activity
from app.utils.importer import is_image_background

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/audio-playlists", tags=["audio-playlists"])


# Pydantic Schemas
class AudioPlaylistItemInput(BaseModel):
    audio_track_id: int
    position: int | None = None
    # Fond d'ambiance propre à cette piste (réf. mission "associer un fond
    # animé à chaque musique qui se jouera en arrière plan") : nul = pas de
    # fond propre, le fond de la playlist/du cours reste affiché.
    background_id: int | None = None


class AudioPlaylistInput(BaseModel):
    name: str
    items: List[AudioPlaylistItemInput] = []


class AudioTrackSummaryResponse(BaseModel):
    id: int
    number: int | None = None
    title: str
    duration_seconds: float | None = None
    course_id: int
    course_title: str
    course_program: str | None = None

    class Config:
        from_attributes = True


class AudioPlaylistItemBackgroundResponse(BaseModel):
    id: int
    title: str
    is_image: bool


class AudioPlaylistItemResponse(BaseModel):
    id: int
    position: int
    track: AudioTrackSummaryResponse
    background: AudioPlaylistItemBackgroundResponse | None = None

    class Config:
        from_attributes = True


class AudioPlaylistDetailResponse(BaseModel):
    id: int
    name: str
    created_at: datetime
    items: List[AudioPlaylistItemResponse]
    total_duration_seconds: float

    class Config:
        from_attributes = True


class AudioPlaylistSummaryResponse(BaseModel):
    id: int
    name: str
    created_at: datetime
    item_count: int
    total_duration_seconds: float

    class Config:
        from_attributes = True


def _track_summary(track: AudioTrack) -> dict:
    return {
        "id": track.id,
        "number": track.number,
        "title": track.title,
        "duration_seconds": track.duration_seconds,
        "course_id": track.course.id,
        "course_title": track.course.title,
        "course_program": track.course.program,
    }


def _item_background(item: AudioPlaylistItem) -> dict | None:
    if not item.background:
        return None
    return {
        "id": item.background.id,
        "title": item.background.title,
        "is_image": is_image_background(item.background.file_path),
    }


def _validate_background_id(background_id: int | None, db: Session) -> None:
    if background_id is None:
        return
    if not db.query(Background).filter(Background.id == background_id).first():
        raise HTTPException(status_code=400, detail=f"Fond animé {background_id} introuvable")


@router.get("", response_model=List[AudioPlaylistSummaryResponse])
def list_audio_playlists(db: Session = Depends(get_db)):
    """Liste toutes les playlists audio ("éditions mixées") avec le nombre
    de pistes et la durée totale."""
    playlists = db.query(AudioPlaylist).order_by(AudioPlaylist.name.asc()).all()
    response = []
    for p in playlists:
        total_duration = sum((item.track.duration_seconds or 0.0) for item in p.items)
        response.append({
            "id": p.id,
            "name": p.name,
            "created_at": p.created_at,
            "item_count": len(p.items),
            "total_duration_seconds": total_duration,
        })
    return response


@router.get("/{playlist_id}", response_model=AudioPlaylistDetailResponse)
def get_audio_playlist(playlist_id: int, db: Session = Depends(get_db)):
    playlist = db.query(AudioPlaylist).filter(AudioPlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist audio non trouvée")

    sorted_items = sorted(playlist.items, key=lambda x: x.position)
    total_duration = sum((item.track.duration_seconds or 0.0) for item in playlist.items)

    return {
        "id": playlist.id,
        "name": playlist.name,
        "created_at": playlist.created_at,
        "items": [
            {
                "id": item.id,
                "position": item.position,
                "track": _track_summary(item.track),
                "background": _item_background(item),
            }
            for item in sorted_items
        ],
        "total_duration_seconds": total_duration,
    }


@router.post("", response_model=AudioPlaylistDetailResponse)
def create_audio_playlist(data: AudioPlaylistInput, db: Session = Depends(get_db)):
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Le nom de la playlist ne peut pas être vide")

    playlist = AudioPlaylist(name=data.name.strip())
    db.add(playlist)
    db.flush()

    for i, item_input in enumerate(data.items):
        track = db.query(AudioTrack).filter(AudioTrack.id == item_input.audio_track_id).first()
        if not track:
            raise HTTPException(status_code=400, detail=f"Piste audio {item_input.audio_track_id} introuvable")
        _validate_background_id(item_input.background_id, db)

        position = item_input.position if item_input.position is not None else i
        db.add(AudioPlaylistItem(
            playlist_id=playlist.id, audio_track_id=track.id, position=position,
            background_id=item_input.background_id,
        ))

    db.commit()
    db.refresh(playlist)
    log_activity(db, "audio_playlist_created", f"{playlist.name} ({len(data.items)} piste(s))")

    return get_audio_playlist(playlist.id, db)


@router.put("/{playlist_id}", response_model=AudioPlaylistDetailResponse)
def update_audio_playlist(playlist_id: int, data: AudioPlaylistInput, db: Session = Depends(get_db)):
    playlist = db.query(AudioPlaylist).filter(AudioPlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist audio non trouvée")

    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Le nom de la playlist ne peut pas être vide")

    playlist.name = data.name.strip()

    db.query(AudioPlaylistItem).filter(AudioPlaylistItem.playlist_id == playlist.id).delete()

    for i, item_input in enumerate(data.items):
        track = db.query(AudioTrack).filter(AudioTrack.id == item_input.audio_track_id).first()
        if not track:
            raise HTTPException(status_code=400, detail=f"Piste audio {item_input.audio_track_id} introuvable")
        _validate_background_id(item_input.background_id, db)

        position = item_input.position if item_input.position is not None else i
        db.add(AudioPlaylistItem(
            playlist_id=playlist.id, audio_track_id=track.id, position=position,
            background_id=item_input.background_id,
        ))

    db.commit()
    db.refresh(playlist)
    log_activity(db, "audio_playlist_updated", playlist.name)

    return get_audio_playlist(playlist.id, db)


@router.delete("/{playlist_id}")
def delete_audio_playlist(playlist_id: int, db: Session = Depends(get_db)):
    playlist = db.query(AudioPlaylist).filter(AudioPlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist audio non trouvée")

    name = playlist.name
    db.delete(playlist)
    db.commit()
    log_activity(db, "audio_playlist_deleted", name)
    return {"message": "Playlist audio supprimée avec succès"}


@router.post("/{playlist_id}/duplicate", response_model=AudioPlaylistDetailResponse)
def duplicate_audio_playlist(playlist_id: int, db: Session = Depends(get_db)):
    original = db.query(AudioPlaylist).filter(AudioPlaylist.id == playlist_id).first()
    if not original:
        raise HTTPException(status_code=404, detail="Playlist audio non trouvée")

    copy_playlist = AudioPlaylist(name=f"{original.name} (copie)")
    db.add(copy_playlist)
    db.flush()

    for item in original.items:
        db.add(AudioPlaylistItem(
            playlist_id=copy_playlist.id, audio_track_id=item.audio_track_id, position=item.position,
            background_id=item.background_id,
        ))

    db.commit()
    db.refresh(copy_playlist)

    return get_audio_playlist(copy_playlist.id, db)
