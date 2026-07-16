import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AudioCourse, Background, PlaybackState, Video, Playlist
from app.playback_manager import get_playback_manager, init_playback_manager
from app.scheduler_manager import ensure_utc, resolve_target_title
from app.utils.activity_log import log_activity
from app.utils.ws_manager import manager as ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["playback"])

# Le PlaybackManager est initialisé ici avec le broadcast du ConnectionManager :
# un seul écran cinéma, un seul état partagé pour toute l'application.
playback_manager = init_playback_manager(ws_manager.broadcast)


class InterruptedStateResponse(BaseModel):
    id: int
    cause: str | None
    interrupted_at: datetime
    # Forme F5.3 (cause="schedule") : lecture manuelle interrompue, reprise à la position exacte.
    video_id: int | None = None
    title: str | None = None
    position_seconds: float | None = None
    # Forme F10.7 (cause="coach_priority") : programmation reportée par le mode coach, relance depuis zéro.
    target_type: str | None = None
    target_id: int | None = None


def _thumbnail_filename(thumbnail_path: str | None) -> str | None:
    """Nom de fichier seul (pas le chemin disque complet) pour reconstruire
    l'URL `/api/thumbnails/<fichier>` côté client — réf. UX3.3 vignette du
    bloc « En direct »."""
    return thumbnail_path.split("/")[-1] if thumbnail_path else None


async def _load_audio_course_into_manager(course: AudioCourse, manager, chain_mode=None, chain_timer_seconds=None, client_ts=None):
    tracks = [
        {"id": t.id, "number": t.number, "title": t.title, "duration_seconds": t.duration_seconds}
        for t in sorted(course.tracks, key=lambda t: t.position)
    ]
    await manager.load_audio_course(
        course.id, course.title, course.program, course.background_id, tracks,
        chain_mode=chain_mode, chain_timer_seconds=chain_timer_seconds, client_ts=client_ts,
    )


@router.get("/api/playback/state")
def get_playback_state():
    """Snapshot ponctuel de l'état de lecture (utile au premier rendu, avant connexion WebSocket)."""
    return get_playback_manager().snapshot()


@router.get("/api/playback/interrupted", response_model=InterruptedStateResponse | None)
def get_interrupted_state(db: Session = Depends(get_db)):
    """
    Dernière action différée en attente de reprise/relance explicite depuis
    l'interface : soit une lecture manuelle interrompue par une programmation
    (F5.3), soit une programmation reportée par le mode coach (F10.7).
    """
    state = db.query(PlaybackState).order_by(PlaybackState.id.desc()).first()
    if not state:
        return None

    if state.cause == "coach_priority":
        title, _program = resolve_target_title(db, state.target_type, state.target_id)
        return {
            "id": state.id,
            "cause": state.cause,
            "interrupted_at": ensure_utc(state.interrupted_at),
            "target_type": state.target_type,
            "target_id": state.target_id,
            "title": title,
        }

    video = db.query(Video).filter(Video.id == state.video_id).first()
    return {
        "id": state.id,
        "cause": state.cause,
        "interrupted_at": ensure_utc(state.interrupted_at),
        "video_id": state.video_id,
        "title": video.title if video else None,
        "position_seconds": state.position_seconds,
    }


@router.post("/api/playback/interrupted/resume")
async def resume_interrupted_state(db: Session = Depends(get_db)):
    """
    Relance l'action différée : reprise à la position exacte pour F5.3,
    relance depuis zéro de la cible programmée pour F10.7 (elle n'avait
    jamais démarré, il n'y a pas de position à reprendre).
    """
    state = db.query(PlaybackState).order_by(PlaybackState.id.desc()).first()
    if not state:
        raise HTTPException(status_code=404, detail="Aucune action différée à reprendre")

    manager = get_playback_manager()

    if state.cause == "coach_priority":
        if state.target_type == "video":
            video = db.query(Video).filter(Video.id == state.target_id).first()
            if not video:
                db.delete(state)
                db.commit()
                raise HTTPException(status_code=404, detail="La vidéo programmée n'existe plus dans la bibliothèque")
            await manager.load(
                video.id, video.title, video.duration_seconds, video.program,
                thumbnail_url=_thumbnail_filename(video.thumbnail_path),
            )
        else:
            playlist = db.query(Playlist).filter(Playlist.id == state.target_id).first()
            if not playlist:
                db.delete(state)
                db.commit()
                raise HTTPException(status_code=404, detail="La playlist programmée n'existe plus")
            sorted_items = sorted(playlist.items, key=lambda item: item.position)
            items_data = [
                {
                    "id": i.video.id, "title": i.video.title, "duration_seconds": i.video.duration_seconds,
                    "program": i.video.program, "thumbnail_url": _thumbnail_filename(i.video.thumbnail_path),
                }
                for i in sorted_items
            ]
            await manager.load_playlist(playlist.id, playlist.name, items_data)

        db.delete(state)
        db.commit()
        return {"message": "Programmation relancée"}

    video = db.query(Video).filter(Video.id == state.video_id).first()
    if not video:
        db.delete(state)
        db.commit()
        raise HTTPException(status_code=404, detail="La vidéo interrompue n'existe plus dans la bibliothèque")

    await manager.load(
        video.id, video.title, video.duration_seconds, video.program, skip_countdown=True,
        thumbnail_url=_thumbnail_filename(video.thumbnail_path),
    )
    await manager.seek(state.position_seconds or 0.0)

    db.delete(state)
    db.commit()
    return {"message": "Lecture reprise"}


@router.delete("/api/playback/interrupted")
def dismiss_interrupted_state(db: Session = Depends(get_db)):
    """Abandonne la lecture interrompue sans la relancer."""
    state = db.query(PlaybackState).order_by(PlaybackState.id.desc()).first()
    if state:
        db.delete(state)
        db.commit()
    return {"message": "Lecture interrompue abandonnée"}


@router.websocket("/ws/playback")
async def playback_ws(websocket: WebSocket, db: Session = Depends(get_db)):
    manager = get_playback_manager()
    await ws_manager.connect(websocket)
    try:
        # Envoi immédiat de l'état courant au nouveau client (kiosk ou télécommande).
        await websocket.send_json({
            "event": "state_change",
            "cause": "sync",
            "data": manager.snapshot(),
        })
        while True:
            message = await websocket.receive_json()
            await _handle_command(message, db, manager)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"Erreur sur la connexion WebSocket playback : {e}", exc_info=True)
        ws_manager.disconnect(websocket)


async def _handle_command(message: dict, db: Session, manager) -> None:
    command = message.get("command")
    params = message.get("params") or {}
    client_ts = params.get("client_ts")

    if command == "load":
        video_id = params.get("video_id")
        video = db.query(Video).filter(Video.id == video_id).first()
        if not video:
            logger.warning(f"Commande load : vidéo {video_id} introuvable")
            return
        await manager.load(
            video.id, video.title, video.duration_seconds, video.program, client_ts,
            thumbnail_url=_thumbnail_filename(video.thumbnail_path),
        )
        log_activity(db, "video_started", video.title)
    elif command == "load_background":
        background_id = params.get("background_id")
        background = db.query(Background).filter(Background.id == background_id).first()
        if not background:
            logger.warning(f"Commande load_background : fond animé {background_id} introuvable")
            return
        await manager.load_background(background.id, background.title, client_ts)
        log_activity(db, "background_started", background.title)
    elif command == "load_audio_course":
        course_id = params.get("audio_course_id")
        course = db.query(AudioCourse).filter(AudioCourse.id == course_id).first()
        if not course:
            logger.warning(f"Commande load_audio_course : cours audio {course_id} introuvable")
            return
        await _load_audio_course_into_manager(
            course, manager,
            chain_mode=params.get("chain_mode"),
            chain_timer_seconds=params.get("chain_timer_seconds"),
            client_ts=client_ts,
        )
        log_activity(db, "audio_course_started", course.title)
    elif command == "audio_next_track":
        await manager.audio_next_track(client_ts)
    elif command == "audio_previous_track":
        await manager.audio_previous_track(client_ts)
    elif command == "audio_restart_track":
        await manager.audio_restart_track(client_ts)
    elif command == "audio_jump_to_track":
        await manager.audio_jump_to_track(int(params.get("index", 0)), client_ts)
    elif command == "audio_set_chain_mode":
        await manager.audio_set_chain_mode(params.get("mode", "auto"), client_ts)
    elif command == "audio_set_chain_timer":
        await manager.audio_set_chain_timer(float(params.get("seconds", 20)), client_ts)
    elif command == "audio_report_position":
        await manager.audio_report_position(float(params.get("position_seconds", 0)))
    elif command == "audio_track_ended":
        await manager.audio_track_ended(client_ts)
    elif command == "load_playlist":
        playlist_id = params.get("playlist_id")
        playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
        if not playlist:
            logger.warning(f"Commande load_playlist : playlist {playlist_id} introuvable")
            return
        sorted_items = sorted(playlist.items, key=lambda x: x.position)
        items_data = []
        for item in sorted_items:
            items_data.append({
                "id": item.video.id,
                "title": item.video.title,
                "duration_seconds": item.video.duration_seconds,
                "program": item.video.program,
                "thumbnail_url": _thumbnail_filename(item.video.thumbnail_path),
            })
        await manager.load_playlist(
            playlist.id, playlist.name, items_data, client_ts
        )
        log_activity(db, "playlist_started", playlist.name)
    elif command == "play":
        await manager.play(client_ts)
    elif command == "pause":
        await manager.pause(client_ts)
    elif command == "stop":
        # F8.1 "annulation" : n'a de sens comme évènement que s'il y avait
        # effectivement quelque chose en cours à interrompre.
        current = manager.snapshot()
        if current["current_video"] or current["current_background"] or current["current_audio_course"]:
            title = (
                (current["current_video"] or {}).get("title")
                or (current["current_background"] or {}).get("title")
                or (current["current_audio_course"] or {}).get("title")
            )
            log_activity(db, "playback_stopped", title)
        await manager.stop(client_ts)
    elif command == "seek":
        await manager.seek(float(params.get("position_seconds", 0)), client_ts)
    elif command == "volume":
        await manager.set_volume(params.get("volume", 100), client_ts)
    elif command == "speed":
        await manager.set_speed(params.get("speed", 1.0), client_ts)
    elif command == "next_video":
        await manager.next_video(client_ts)
    elif command == "previous_video":
        await manager.previous_video(client_ts)
    elif command == "skip_waiting":
        await manager.skip_waiting(client_ts)
    elif command == "video_ended":
        await manager.video_ended(client_ts)
    elif command == "report_position":
        await manager.report_position(float(params.get("position_seconds", 0)))
    else:
        logger.warning(f"Commande WebSocket inconnue reçue : {command}")
