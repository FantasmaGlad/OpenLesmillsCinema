import logging

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Video, Playlist
from app.playback_manager import get_playback_manager, init_playback_manager
from app.utils.ws_manager import manager as ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["playback"])

# Le PlaybackManager est initialisé ici avec le broadcast du ConnectionManager :
# un seul écran cinéma, un seul état partagé pour toute l'application.
playback_manager = init_playback_manager(ws_manager.broadcast)


@router.get("/api/playback/state")
def get_playback_state():
    """Snapshot ponctuel de l'état de lecture (utile au premier rendu, avant connexion WebSocket)."""
    return get_playback_manager().snapshot()


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
            video.id, video.title, video.duration_seconds, video.program, client_ts
        )
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
            })
        await manager.load_playlist(
            playlist.id, playlist.name, items_data, client_ts
        )
    elif command == "play":
        await manager.play(client_ts)
    elif command == "pause":
        await manager.pause(client_ts)
    elif command == "stop":
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
