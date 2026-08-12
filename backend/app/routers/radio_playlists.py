"""Router des playlists Radio (réf. docs/cahier-des-charges-radio.md, lot L2).

Playlists de morceaux de la bibliothèque radio, sur le modèle des playlists audio
coach (remplacement complet de la liste ordonnée à la création/mise à jour). En
plus : une playlist peut être marquée `is_default` — la playlist d'ambiance jouée
en boucle 24/7 (décision D9), une seule à la fois.
"""
import logging
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import RadioPlaylist, RadioPlaylistItem, RadioTrack
from app.utils.activity_log import log_activity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/radio/playlists", tags=["radio-playlists"])


# ---------------------------------------------------------------------------
# Schémas
# ---------------------------------------------------------------------------
class RadioPlaylistInput(BaseModel):
    name: str
    # Liste ORDONNÉE des morceaux (remplacement complet, comme les playlists
    # audio coach) : la position = l'ordre dans ce tableau.
    track_ids: List[int] = []


class RadioPlaylistRename(BaseModel):
    name: str


class AddTrackInput(BaseModel):
    track_id: int


class RadioPlaylistTrackResponse(BaseModel):
    id: int
    title: str
    artist: str | None
    album: str | None
    duration_seconds: float | None
    has_cover: bool


class RadioPlaylistItemResponse(BaseModel):
    id: int
    position: int
    track: RadioPlaylistTrackResponse


class RadioPlaylistDetailResponse(BaseModel):
    id: int
    name: str
    is_default: bool
    created_at: datetime
    items: List[RadioPlaylistItemResponse]
    total_duration_seconds: float


class RadioPlaylistSummaryResponse(BaseModel):
    id: int
    name: str
    is_default: bool
    created_at: datetime
    item_count: int
    total_duration_seconds: float
    # Pochette d'affichage : premier morceau de la playlist ayant une pochette.
    cover_track_id: int | None


def _track_summary(track: RadioTrack) -> dict:
    return {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration_seconds": track.duration_seconds,
        "has_cover": track.cover_path is not None,
    }


def _detail(playlist: RadioPlaylist) -> dict:
    sorted_items = sorted(playlist.items, key=lambda x: x.position)
    total = sum((item.track.duration_seconds or 0.0) for item in sorted_items if item.track)
    return {
        "id": playlist.id,
        "name": playlist.name,
        "is_default": playlist.is_default,
        "created_at": playlist.created_at,
        "items": [
            {"id": item.id, "position": item.position, "track": _track_summary(item.track)}
            for item in sorted_items
            if item.track
        ],
        "total_duration_seconds": total,
    }


def _get_or_404(playlist_id: int, db: Session) -> RadioPlaylist:
    playlist = db.query(RadioPlaylist).filter(RadioPlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist radio non trouvée")
    return playlist


def _replace_items(playlist: RadioPlaylist, track_ids: List[int], db: Session) -> None:
    db.query(RadioPlaylistItem).filter(RadioPlaylistItem.playlist_id == playlist.id).delete()
    for position, track_id in enumerate(track_ids):
        if not db.query(RadioTrack).filter(RadioTrack.id == track_id).first():
            raise HTTPException(status_code=400, detail=f"Morceau {track_id} introuvable")
        db.add(RadioPlaylistItem(playlist_id=playlist.id, radio_track_id=track_id, position=position))


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
@router.get("", response_model=List[RadioPlaylistSummaryResponse])
def list_playlists(db: Session = Depends(get_db)):
    playlists = db.query(RadioPlaylist).order_by(RadioPlaylist.is_default.desc(), RadioPlaylist.name.asc()).all()
    out = []
    for p in playlists:
        items = sorted(p.items, key=lambda x: x.position)
        cover_track_id = next((it.track.id for it in items if it.track and it.track.cover_path), None)
        out.append({
            "id": p.id,
            "name": p.name,
            "is_default": p.is_default,
            "created_at": p.created_at,
            "item_count": len(items),
            "total_duration_seconds": sum((it.track.duration_seconds or 0.0) for it in items if it.track),
            "cover_track_id": cover_track_id,
        })
    return out


@router.get("/{playlist_id}", response_model=RadioPlaylistDetailResponse)
def get_playlist(playlist_id: int, db: Session = Depends(get_db)):
    return _detail(_get_or_404(playlist_id, db))


@router.post("", response_model=RadioPlaylistDetailResponse)
def create_playlist(data: RadioPlaylistInput, db: Session = Depends(get_db)):
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Le nom de la playlist ne peut pas être vide")
    playlist = RadioPlaylist(name=data.name.strip())
    db.add(playlist)
    db.flush()
    _replace_items(playlist, data.track_ids, db)
    db.commit()
    db.refresh(playlist)
    log_activity(db, "radio_playlist_created", f"{playlist.name} ({len(data.track_ids)} morceau(x))")
    return _detail(playlist)


@router.put("/{playlist_id}", response_model=RadioPlaylistDetailResponse)
def update_playlist(playlist_id: int, data: RadioPlaylistInput, db: Session = Depends(get_db)):
    playlist = _get_or_404(playlist_id, db)
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Le nom de la playlist ne peut pas être vide")
    playlist.name = data.name.strip()
    _replace_items(playlist, data.track_ids, db)
    db.commit()
    db.refresh(playlist)
    log_activity(db, "radio_playlist_updated", playlist.name)
    return _detail(playlist)


@router.post("/{playlist_id}/tracks", response_model=RadioPlaylistDetailResponse)
def add_track(playlist_id: int, data: AddTrackInput, db: Session = Depends(get_db)):
    """Ajoute un morceau à la fin de la playlist (bouton « ajouter à la playlist »
    depuis la vue Morceaux)."""
    playlist = _get_or_404(playlist_id, db)
    if not db.query(RadioTrack).filter(RadioTrack.id == data.track_id).first():
        raise HTTPException(status_code=400, detail=f"Morceau {data.track_id} introuvable")
    max_pos = max((item.position for item in playlist.items), default=-1)
    db.add(RadioPlaylistItem(playlist_id=playlist.id, radio_track_id=data.track_id, position=max_pos + 1))
    db.commit()
    db.refresh(playlist)
    return _detail(playlist)


@router.put("/{playlist_id}/default", response_model=RadioPlaylistDetailResponse)
def set_default(playlist_id: int, db: Session = Depends(get_db)):
    """Désigne la playlist d'ambiance par défaut (décision D9) : une seule à la
    fois, garantie applicativement."""
    playlist = _get_or_404(playlist_id, db)
    db.query(RadioPlaylist).filter(RadioPlaylist.id != playlist_id, RadioPlaylist.is_default == True).update(  # noqa: E712
        {"is_default": False}
    )
    playlist.is_default = True
    db.commit()
    db.refresh(playlist)
    log_activity(db, "radio_playlist_set_default", playlist.name)
    return _detail(playlist)


@router.delete("/{playlist_id}/default", response_model=RadioPlaylistDetailResponse)
def unset_default(playlist_id: int, db: Session = Depends(get_db)):
    """Retire le statut « par défaut » (plus aucune playlist d'ambiance)."""
    playlist = _get_or_404(playlist_id, db)
    playlist.is_default = False
    db.commit()
    db.refresh(playlist)
    return _detail(playlist)


@router.delete("/{playlist_id}")
def delete_playlist(playlist_id: int, db: Session = Depends(get_db)):
    playlist = _get_or_404(playlist_id, db)
    name = playlist.name
    db.delete(playlist)
    db.commit()
    log_activity(db, "radio_playlist_deleted", name)
    return {"message": "Playlist radio supprimée"}
