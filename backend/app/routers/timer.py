import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.timer_manager import get_timer_manager, init_timer_manager
from app.utils.ws_manager import TIMER_REDIS_CHANNEL, ConnectionManager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["timer"])

# Instance dédiée : le minuteur est indépendant de la lecture vidéo (Lot 3),
# donc de son propre canal WebSocket plutôt que de partager celui du kiosk.
# Canal Redis dédié aussi : son écouteur est démarré dans le lifespan
# (main.py), comme celui de la lecture — sans lui, aucun évènement minuteur
# ne parvenait jamais aux clients (publication dans le vide).
timer_ws_manager = ConnectionManager(channel=TIMER_REDIS_CHANNEL)
timer_manager = init_timer_manager(timer_ws_manager.broadcast)


@router.get("/api/timer/state")
def get_timer_state():
    return get_timer_manager().snapshot()


@router.websocket("/ws/timer")
async def timer_ws(websocket: WebSocket):
    manager = get_timer_manager()
    await timer_ws_manager.connect(websocket)
    try:
        await websocket.send_json({
            "event": "timer_change",
            "cause": "sync",
            "data": manager.snapshot(),
        })
        while True:
            message = await websocket.receive_json()
            await _handle_command(message, manager)
    except WebSocketDisconnect:
        timer_ws_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"Erreur sur la connexion WebSocket timer : {e}", exc_info=True)
        timer_ws_manager.disconnect(websocket)


async def _handle_command(message: dict, manager) -> None:
    command = message.get("command")
    params = message.get("params") or {}

    if command == "set_mode":
        await manager.set_mode(params.get("mode"))
    elif command == "start_countdown":
        await manager.start_countdown(float(params.get("seconds", 60)))
    elif command == "start_countup":
        await manager.start_countup()
    elif command == "pause":
        await manager.pause()
    elif command == "resume":
        await manager.resume()
    elif command == "adjust":
        await manager.adjust(float(params.get("delta_seconds", 0)))
    elif command == "reset":
        await manager.reset()
    else:
        logger.warning(f"Commande timer inconnue reçue : {command}")
