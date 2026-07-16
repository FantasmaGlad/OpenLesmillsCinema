import asyncio
import enum
import logging
from typing import Any, Awaitable, Callable

from app.config import settings

logger = logging.getLogger(__name__)

BroadcastFn = Callable[[dict], Awaitable[None]]


class PlaybackStateEnum(str, enum.Enum):
    waiting = "waiting"
    countdown = "countdown"
    playing = "playing"
    paused = "paused"
    coach_mode = "coach_mode"
    offline = "offline"
    playlist_waiting = "playlist_waiting"


class PlaybackManager:
    """
    État de lecture global et partagé de l'écran cinéma (Lot 3, réf. plan
    de construction §8.3.1). Le kiosk reste seul maître de la lecture réelle
    (élément <video>) ; ce gestionnaire fait autorité sur l'état logique
    partagé, diffusé à tous les clients (kiosk + télécommandes) via WebSocket.
    """

    def __init__(self, broadcast: BroadcastFn):
        self._broadcast = broadcast
        self._countdown_task: asyncio.Task | None = None
        self._waiting_task: asyncio.Task | None = None
        self.state: dict[str, Any] = {
            "state": PlaybackStateEnum.waiting.value,
            "current_video": None,
            "position_seconds": 0.0,
            "volume": settings.volume_default,
            "speed": 1.0,
            "countdown_remaining": None,
            "playlist_id": None,
            "playlist_name": None,
            "playlist_items": None,
            "playlist_index": None,
            "playlist_waiting_remaining": None,
        }

    def snapshot(self) -> dict:
        return dict(self.state)

    async def _emit(self, cause: str, client_ts: float | None = None):
        payload: dict[str, Any] = {
            "event": "state_change",
            "cause": cause,
            "data": self.snapshot(),
        }
        if client_ts is not None:
            payload["client_ts"] = client_ts
        await self._broadcast(payload)

    def _cancel_countdown(self):
        if self._countdown_task and not self._countdown_task.done():
            self._countdown_task.cancel()
        self._countdown_task = None

    def _cancel_waiting(self):
        if self._waiting_task and not self._waiting_task.done():
            self._waiting_task.cancel()
        self._waiting_task = None

    async def load(
        self,
        video_id: int,
        title: str,
        duration_seconds: float | None,
        program: str | None = None,
        client_ts: float | None = None,
        keep_playlist: bool = False,
        skip_countdown: bool = False,
    ):
        """Lance un cours : bascule en compte à rebours puis en lecture."""
        self._cancel_countdown()
        if not keep_playlist:
            self._cancel_waiting()
            self.state["playlist_id"] = None
            self.state["playlist_name"] = None
            self.state["playlist_items"] = None
            self.state["playlist_index"] = None
            self.state["playlist_waiting_remaining"] = None

        self.state["current_video"] = {
            "id": video_id,
            "title": title,
            "duration_seconds": duration_seconds,
            "program": program,
        }
        self.state["position_seconds"] = 0.0
        self.state["volume"] = self.state.get("volume", settings.volume_default)

        if skip_countdown:
            self.state["state"] = PlaybackStateEnum.playing.value
            self.state["countdown_remaining"] = None
            await self._emit("load", client_ts)
            return

        seconds = settings.countdown_seconds
        if seconds <= 0:
            # Compte à rebours désactivé (réglage à 0) : passage direct en lecture.
            self.state["state"] = PlaybackStateEnum.playing.value
            self.state["countdown_remaining"] = None
            await self._emit("load", client_ts)
            return

        self.state["state"] = PlaybackStateEnum.countdown.value
        self.state["countdown_remaining"] = float(seconds)
        await self._emit("load", client_ts)
        self._countdown_task = asyncio.create_task(self._run_countdown())

    async def _run_countdown(self):
        try:
            remaining = self.state["countdown_remaining"] or 0.0
            while remaining > 0:
                await asyncio.sleep(1.0)
                remaining -= 1.0
                self.state["countdown_remaining"] = max(0.0, remaining)
                await self._emit("countdown_tick")
            self.state["state"] = PlaybackStateEnum.playing.value
            self.state["countdown_remaining"] = None
            await self._emit("countdown_end")
        except asyncio.CancelledError:
            pass

    async def load_playlist(
        self,
        playlist_id: int,
        playlist_name: str,
        playlist_items: list[dict],
        client_ts: float | None = None,
    ):
        """Lance une playlist : initialise l'index et charge la première vidéo avec compte à rebours."""
        self._cancel_countdown()
        self._cancel_waiting()
        
        self.state["playlist_id"] = playlist_id
        self.state["playlist_name"] = playlist_name
        self.state["playlist_items"] = playlist_items
        self.state["playlist_index"] = 0
        self.state["playlist_waiting_remaining"] = None

        if not playlist_items:
            await self.stop(client_ts)
            return

        first_item = playlist_items[0]
        await self.load(
            video_id=first_item["id"],
            title=first_item["title"],
            duration_seconds=first_item["duration_seconds"],
            program=first_item.get("program"),
            client_ts=client_ts,
            keep_playlist=True,
            skip_countdown=False,
        )

    async def _run_waiting_period(self):
        try:
            remaining = self.state["playlist_waiting_remaining"] or 0.0
            while remaining > 0:
                await asyncio.sleep(1.0)
                remaining -= 1.0
                self.state["playlist_waiting_remaining"] = max(0.0, remaining)
                await self._emit("playlist_waiting_tick")
            
            # Temps d'attente écoulé : lance la vidéo suivante
            await self._play_next_video()
        except asyncio.CancelledError:
            pass

    async def _play_next_video(self, client_ts: float | None = None):
        self._cancel_countdown()
        self._cancel_waiting()

        idx = self.state["playlist_index"]
        items = self.state["playlist_items"]
        if idx is None or items is None:
            await self.stop(client_ts)
            return

        next_idx = idx + 1
        if next_idx < len(items):
            self.state["playlist_index"] = next_idx
            next_item = items[next_idx]
            await self.load(
                video_id=next_item["id"],
                title=next_item["title"],
                duration_seconds=next_item["duration_seconds"],
                program=next_item.get("program"),
                client_ts=client_ts,
                keep_playlist=True,
                skip_countdown=True, # Pas de décompte initial de 5s pour les vidéos suivantes
            )
        else:
            await self.stop(client_ts)

    async def next_video(self, client_ts: float | None = None):
        """Passe immédiatement à la vidéo suivante de la playlist active."""
        if self.state["playlist_items"] is None or self.state["playlist_index"] is None:
            return
        await self._play_next_video(client_ts)

    async def previous_video(self, client_ts: float | None = None):
        """Revient immédiatement à la vidéo précédente de la playlist active."""
        idx = self.state["playlist_index"]
        items = self.state["playlist_items"]
        if idx is None or items is None or idx - 1 < 0:
            return

        prev_idx = idx - 1
        self.state["playlist_index"] = prev_idx
        prev_item = items[prev_idx]

        self._cancel_countdown()
        self._cancel_waiting()

        await self.load(
            video_id=prev_item["id"],
            title=prev_item["title"],
            duration_seconds=prev_item["duration_seconds"],
            program=prev_item.get("program"),
            client_ts=client_ts,
            keep_playlist=True,
            skip_countdown=True,
        )

    async def skip_waiting(self, client_ts: float | None = None):
        """Passe immédiatement le compte à rebours d'attente intercalée."""
        if self.state["state"] != PlaybackStateEnum.playlist_waiting.value:
            return
        await self._play_next_video(client_ts)

    async def video_ended(self, client_ts: float | None = None):
        """Gère la fin naturelle d'une vidéo signalée par le kiosk."""
        self._cancel_countdown()
        self._cancel_waiting()

        idx = self.state["playlist_index"]
        items = self.state["playlist_items"]
        if idx is not None and items is not None:
            if idx + 1 < len(items):
                # Transition vers l'écran d'attente intercalée
                self.state["state"] = PlaybackStateEnum.playlist_waiting.value
                self.state["playlist_waiting_remaining"] = float(settings.wait_time_between_courses)
                await self._emit("video_ended", client_ts)
                self._waiting_task = asyncio.create_task(self._run_waiting_period())
            else:
                # Fin de la playlist
                await self.stop(client_ts)
        else:
            # Pas de playlist active, comportement stop standard
            await self.stop(client_ts)

    async def play(self, client_ts: float | None = None):
        if (
            self.state["current_video"] is None
            or self.state["state"] == PlaybackStateEnum.countdown.value
            or self.state["state"] == PlaybackStateEnum.playlist_waiting.value
        ):
            return
        self.state["state"] = PlaybackStateEnum.playing.value
        await self._emit("play", client_ts)

    async def pause(self, client_ts: float | None = None):
        if (
            self.state["current_video"] is None
            or self.state["state"] == PlaybackStateEnum.countdown.value
            or self.state["state"] == PlaybackStateEnum.playlist_waiting.value
        ):
            return
        self.state["state"] = PlaybackStateEnum.paused.value
        await self._emit("pause", client_ts)

    async def stop(self, client_ts: float | None = None):
        self._cancel_countdown()
        self._cancel_waiting()
        self.state["state"] = PlaybackStateEnum.waiting.value
        self.state["current_video"] = None
        self.state["position_seconds"] = 0.0
        self.state["countdown_remaining"] = None
        self.state["playlist_id"] = None
        self.state["playlist_name"] = None
        self.state["playlist_items"] = None
        self.state["playlist_index"] = None
        self.state["playlist_waiting_remaining"] = None
        await self._emit("stop", client_ts)

    async def seek(self, position_seconds: float, client_ts: float | None = None):
        if self.state["current_video"] is None or self.state["state"] == PlaybackStateEnum.playlist_waiting.value:
            return
        duration = self.state["current_video"].get("duration_seconds")
        position_seconds = max(0.0, position_seconds)
        if duration:
            position_seconds = min(position_seconds, duration)
        self.state["position_seconds"] = position_seconds
        await self._emit("seek", client_ts)

    async def set_volume(self, volume: float, client_ts: float | None = None):
        self.state["volume"] = max(0, min(100, int(volume)))
        await self._emit("volume", client_ts)

    async def set_speed(self, speed: float, client_ts: float | None = None):
        self.state["speed"] = max(0.25, min(2.0, float(speed)))
        await self._emit("speed", client_ts)

    async def report_position(self, position_seconds: float):
        """Rapport silencieux de la position réelle par le kiosk."""
        if self.state["current_video"] is None or self.state["state"] == PlaybackStateEnum.playlist_waiting.value:
            return
        self.state["position_seconds"] = position_seconds
        await self._emit("position_report")


_manager: PlaybackManager | None = None


def init_playback_manager(broadcast: BroadcastFn) -> PlaybackManager:
    global _manager
    _manager = PlaybackManager(broadcast)
    return _manager


def get_playback_manager() -> PlaybackManager:
    if _manager is None:
        raise RuntimeError("PlaybackManager non initialisé")
    return _manager
