"""Router du module Radio — bibliothèque musicale (réf. docs/cahier-des-charges-radio.md).

Lot L1 : gestion de la bibliothèque (« Piste Audio Radio ») — import, liste
filtrable, édition des métadonnées et pochettes, navigation artiste/album, tags.
Le moteur de lecture (canal radio) et les playlists arrivent aux lots suivants.
Le streaming audio et la pochette sont servis par main.py (via _range_stream_response).
"""
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import RadioPlaylistItem, RadioTag, RadioTrack, radio_track_tags
from app.utils.executors import io_executor
from app.utils.import_jobs import create_job, update_job
from app.utils.radio_importer import import_radio_tracks_from_files, import_radio_tracks_from_zip
from app.utils.radio_utils import save_cover_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/radio", tags=["radio"])


@router.get("/state")
def get_radio_state():
    """Snapshot ponctuel de l'état du canal radio (réf. lot L3), utile au
    premier rendu de la télécommande admin avant connexion WebSocket —
    même rôle que GET /api/playback/state pour câblé/réseau."""
    from app.radio_manager import get_radio_manager

    return get_radio_manager().snapshot()


# ---------------------------------------------------------------------------
# Schémas
# ---------------------------------------------------------------------------
class RadioTrackResponse(BaseModel):
    id: int
    title: str
    artist: str | None
    album: str | None
    album_artist: str | None
    track_number: int | None
    disc_number: int | None
    year: int | None
    genre: str | None
    duration_seconds: float | None
    has_cover: bool
    tags: List[str]


class RadioTrackUpdate(BaseModel):
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    album_artist: str | None = None
    track_number: int | None = None
    disc_number: int | None = None
    year: int | None = None
    genre: str | None = None
    # Si fourni, remplace l'ensemble des tags du morceau (noms ; créés si absents).
    tags: List[str] | None = None


class TagInput(BaseModel):
    name: str


class ImportJobAccepted(BaseModel):
    job_id: str


def _to_track_response(track: RadioTrack) -> dict:
    return {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "album_artist": track.album_artist,
        "track_number": track.track_number,
        "disc_number": track.disc_number,
        "year": track.year,
        "genre": track.genre,
        "duration_seconds": track.duration_seconds,
        "has_cover": track.cover_path is not None,
        "tags": sorted(t.name for t in track.tags),
    }


# ---------------------------------------------------------------------------
# Bibliothèque — morceaux
# ---------------------------------------------------------------------------
@router.get("/tracks", response_model=List[RadioTrackResponse])
def list_tracks(
    q: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    genre: str | None = None,
    tag: str | None = None,
    db: Session = Depends(get_db),
):
    """Liste filtrable des morceaux (vue « Morceaux » + filtres artiste/album/
    genre/tag des autres vues, réf. D7)."""
    query = db.query(RadioTrack)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(RadioTrack.title.ilike(like), RadioTrack.artist.ilike(like), RadioTrack.album.ilike(like))
        )
    if artist:
        query = query.filter(or_(RadioTrack.artist == artist, RadioTrack.album_artist == artist))
    if album:
        query = query.filter(RadioTrack.album == album)
    if genre:
        query = query.filter(RadioTrack.genre == genre)
    if tag:
        query = query.join(RadioTrack.tags).filter(RadioTag.name == tag)

    query = query.order_by(
        func.coalesce(RadioTrack.album_artist, RadioTrack.artist).asc(),
        RadioTrack.album.asc(),
        RadioTrack.disc_number.asc(),
        RadioTrack.track_number.asc(),
        RadioTrack.title.asc(),
    )
    return [_to_track_response(t) for t in query.all()]


@router.get("/tracks/{track_id}", response_model=RadioTrackResponse)
def get_track(track_id: int, db: Session = Depends(get_db)):
    track = db.query(RadioTrack).filter(RadioTrack.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Morceau non trouvé")
    return _to_track_response(track)


def _run_files_import_job(job_id: str, tmp_dir: Path, temp_paths: list[str]) -> None:
    try:
        tracks = import_radio_tracks_from_files(temp_paths, job_id=job_id)
        update_job(job_id, stage="done", result_id=tracks[0].id if tracks else None)
    except Exception as e:
        logger.error(f"Import radio (job {job_id}) échoué : {e}", exc_info=True)
        update_job(job_id, stage="error", error=str(e))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _run_zip_import_job(job_id: str, temp_path: str) -> None:
    try:
        tracks = import_radio_tracks_from_zip(temp_path, job_id=job_id)
        update_job(job_id, stage="done", result_id=tracks[0].id if tracks else None)
    except Exception as e:
        logger.error(f"Import radio ZIP (job {job_id}) échoué : {e}", exc_info=True)
        update_job(job_id, stage="error", error=str(e))


@router.post("/tracks/upload", response_model=ImportJobAccepted, status_code=202)
def upload_tracks(files: List[UploadFile] = File(...)):
    """Import multi-fichiers de morceaux (tous formats audio, réf. A2), traité en
    arrière-plan — voir GET /api/import-jobs."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="olmc_radio_upload_"))
    temp_paths = []
    try:
        for f in files:
            dest = tmp_dir / Path(f.filename).name
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out)
            temp_paths.append(str(dest))
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(e))

    label = Path(files[0].filename).name if files else "morceaux"
    job_id = create_job("radio", label, label)
    io_executor.submit(_run_files_import_job, job_id, tmp_dir, temp_paths)
    return {"job_id": job_id}


@router.post("/tracks/upload-zip", response_model=ImportJobAccepted, status_code=202)
def upload_tracks_zip(file: UploadFile = File(...)):
    """Import d'une archive ZIP de morceaux, traité en arrière-plan."""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as temp_file:
            shutil.copyfileobj(file.file, temp_file)
            temp_path = temp_file.name
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = create_job("radio", file.filename or "archive.zip", file.filename)
    io_executor.submit(_run_zip_import_job, job_id, temp_path)
    return {"job_id": job_id}


def _apply_tags(db: Session, track: RadioTrack, tag_names: List[str]) -> None:
    """Remplace l'ensemble des tags du morceau par `tag_names` (créés si absents)."""
    resolved: list[RadioTag] = []
    for raw in tag_names:
        name = raw.strip()
        if not name:
            continue
        tag = db.query(RadioTag).filter(RadioTag.name == name).first()
        if not tag:
            tag = RadioTag(name=name)
            db.add(tag)
            db.flush()
        if tag not in resolved:
            resolved.append(tag)
    track.tags = resolved


@router.put("/tracks/{track_id}", response_model=RadioTrackResponse)
def update_track(track_id: int, payload: RadioTrackUpdate, db: Session = Depends(get_db)):
    """Édition manuelle des métadonnées et des tags (réf. D3 override manuel)."""
    track = db.query(RadioTrack).filter(RadioTrack.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Morceau non trouvé")

    fields_set = payload.model_fields_set
    text_fields = ("title", "artist", "album", "album_artist", "genre")
    for field in text_fields:
        if field in fields_set:
            value = getattr(payload, field)
            # Chaîne vide -> None (efface le champ) ; sinon valeur nettoyée.
            setattr(track, field, value.strip() if value and value.strip() else None)
    if "title" in fields_set and not track.title:
        raise HTTPException(status_code=400, detail="Le titre ne peut pas être vide")
    for field in ("track_number", "disc_number", "year"):
        if field in fields_set:
            setattr(track, field, getattr(payload, field))
    if payload.tags is not None:
        _apply_tags(db, track, payload.tags)

    db.commit()
    db.refresh(track)
    return _to_track_response(track)


@router.post("/tracks/{track_id}/cover", response_model=RadioTrackResponse)
def upload_track_cover(track_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Pochette fournie manuellement (réf. D3) : remplace la pochette existante."""
    from app.models import RadioCoverSource

    track = db.query(RadioTrack).filter(RadioTrack.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Morceau non trouvé")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "").suffix)
    try:
        shutil.copyfileobj(file.file, tmp)
        tmp.close()
        import uuid
        file_id = uuid.uuid4().hex
        try:
            new_cover = save_cover_image(tmp.name, settings.radio_covers_dir, file_id)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Image invalide : {e}")
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass

    old_cover = track.cover_path
    track.cover_path = new_cover
    track.cover_source = RadioCoverSource.manual
    db.commit()
    db.refresh(track)
    # Supprime l'ancienne pochette du disque une fois la bascule committée.
    if old_cover and old_cover != new_cover and Path(old_cover).exists():
        try:
            os.remove(old_cover)
        except OSError:
            pass
    return _to_track_response(track)


@router.delete("/tracks/{track_id}")
def delete_track(track_id: int, db: Session = Depends(get_db)):
    track = db.query(RadioTrack).filter(RadioTrack.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Morceau non trouvé")

    file_path = track.file_path
    cover_path = track.cover_path
    # FK non appliquées par SQLite ici (cf. database.py) : on retire à la main
    # les items de playlist et les liens de tags référençant ce morceau.
    db.query(RadioPlaylistItem).filter(RadioPlaylistItem.radio_track_id == track_id).delete()
    track.tags = []
    db.delete(track)
    db.commit()

    for path in (file_path, cover_path):
        if path and Path(path).exists():
            try:
                os.remove(path)
            except OSError as e:
                logger.error(f"Suppression de fichier radio impossible ({path}) : {e}")
    return {"message": "Morceau supprimé"}


# ---------------------------------------------------------------------------
# Navigation dérivée — artistes / albums (réf. D7, pas de tables dédiées)
# ---------------------------------------------------------------------------
@router.get("/artists")
def list_artists(db: Session = Depends(get_db)):
    """Artistes dérivés par regroupement (album_artist sinon artist)."""
    name_col = func.coalesce(RadioTrack.album_artist, RadioTrack.artist)
    rows = (
        db.query(
            name_col.label("name"),
            func.count(RadioTrack.id).label("track_count"),
            func.count(func.distinct(RadioTrack.album)).label("album_count"),
        )
        .filter(name_col.isnot(None))
        .group_by(name_col)
        .order_by(name_col.asc())
        .all()
    )
    return [{"name": r.name, "track_count": r.track_count, "album_count": r.album_count} for r in rows]


@router.get("/albums")
def list_albums(db: Session = Depends(get_db)):
    """Albums dérivés par regroupement (album_artist, album). `cover_track_id`
    = premier morceau de l'album ayant une pochette (pour l'affichage)."""
    albums: dict[tuple, dict] = {}
    tracks = (
        db.query(RadioTrack)
        .filter(RadioTrack.album.isnot(None))
        .order_by(RadioTrack.disc_number.asc(), RadioTrack.track_number.asc())
        .all()
    )
    for t in tracks:
        artist = t.album_artist or t.artist
        key = (artist, t.album)
        entry = albums.setdefault(key, {
            "album": t.album, "album_artist": artist, "track_count": 0,
            "year": t.year, "cover_track_id": None,
        })
        entry["track_count"] += 1
        if entry["cover_track_id"] is None and t.cover_path is not None:
            entry["cover_track_id"] = t.id
        if entry["year"] is None and t.year is not None:
            entry["year"] = t.year
    return sorted(albums.values(), key=lambda a: ((a["album_artist"] or "").lower(), (a["album"] or "").lower()))


# ---------------------------------------------------------------------------
# Tags (réf. D7 « étiquettes / genres »)
# ---------------------------------------------------------------------------
@router.get("/tags")
def list_tags(db: Session = Depends(get_db)):
    rows = (
        db.query(RadioTag.id, RadioTag.name, func.count(radio_track_tags.c.radio_track_id).label("track_count"))
        .outerjoin(radio_track_tags, RadioTag.id == radio_track_tags.c.tag_id)
        .group_by(RadioTag.id, RadioTag.name)
        .order_by(RadioTag.name.asc())
        .all()
    )
    return [{"id": r.id, "name": r.name, "track_count": r.track_count} for r in rows]


@router.post("/tags")
def create_tag(payload: TagInput, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Le nom du tag est requis")
    if db.query(RadioTag).filter(RadioTag.name == name).first():
        raise HTTPException(status_code=409, detail="Ce tag existe déjà")
    tag = RadioTag(name=name)
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return {"id": tag.id, "name": tag.name}


@router.put("/tags/{tag_id}")
def rename_tag(tag_id: int, payload: TagInput, db: Session = Depends(get_db)):
    tag = db.query(RadioTag).filter(RadioTag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag non trouvé")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Le nom du tag est requis")
    existing = db.query(RadioTag).filter(RadioTag.name == name, RadioTag.id != tag_id).first()
    if existing:
        raise HTTPException(status_code=409, detail="Ce tag existe déjà")
    tag.name = name
    db.commit()
    return {"id": tag.id, "name": tag.name}


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, db: Session = Depends(get_db)):
    tag = db.query(RadioTag).filter(RadioTag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag non trouvé")
    db.delete(tag)
    db.commit()
    return {"message": "Tag supprimé"}
