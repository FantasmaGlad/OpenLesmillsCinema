"""Moteur de lecture du canal Radio (réf. docs/cahier-des-charges-radio.md, lot L3).

Sous-système INDÉPENDANT du PlaybackManager câblé/réseau (décisions D1/D2) : un
3e canal `radio` avec sa propre sémantique musicale — playlist, ordre de lecture
(shuffle), répétition (piste/playlist), file d'attente « à suivre », volume.

Comme le PlaybackManager, il fait autorité sur l'ÉTAT LOGIQUE partagé (diffusé à
tous les clients via WebSocket + persisté dans Redis pour la synchro inter-workers).
La lecture audio réelle est faite par l'écran `/radio` (lot L4) : il rapporte la
position et signale la fin de piste (`radio_track_ended`), le moteur avance alors
selon repeat/shuffle/queue. Le crossfade viendra au lot L5.
"""
import asyncio
import json
import logging
import os
import random
import time
from typing import Any, Awaitable, Callable

from app.config import settings
from app.utils.boot_state import current_boot_id
from app.utils.redis_client import get_redis

logger = logging.getLogger(__name__)

BroadcastFn = Callable[[dict], Awaitable[None]]

RADIO_CHANNEL = "radio"
REDIS_STATE_KEY = "radio:state"
RADIO_BOOT_KEY = "radio:boot_id"

REPEAT_MODES = ("off", "playlist", "track")


class RadioPlaybackManager:
    def __init__(self, broadcast: BroadcastFn):
        self._broadcast = broadcast
        self._worker_id = str(os.getpid())
        self._last_direct_report = 0.0
        self._position_broadcast_task: asyncio.Task | None = None
        self.state: dict[str, Any] = {
            "state": "idle",            # idle | playing | paused
            "playlist_id": None,
            "playlist_name": None,
            "order": [],                # ordre de lecture courant (liste de pistes)
            "index": None,              # position courante dans `order`
            "current_track": None,      # = order[index] (confort client)
            "position_seconds": 0.0,
            "duration_seconds": None,   # durée de la piste courante (confort client)
            "volume": settings.radio_volume_default,
            "shuffle": False,
            "repeat": "off",            # off | playlist | track
            "playing": False,
            # Réglages transmis au lecteur /radio (lots L4/L5).
            "crossfade_seconds": settings.radio_crossfade_seconds,
        }

    # ------------------------------------------------------------------
    # État partagé (Redis) + diffusion
    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        return dict(self.state)

    async def sync_from_redis(self):
        """Reprend l'état radio publié par un autre worker au démarrage. Purge
        l'état d'un lancement de service PRÉCÉDENT (correctif « pas de fantôme »,
        clé boot dédiée pour ne pas entrer en concurrence avec le PlaybackManager)."""
        try:
            redis = get_redis()
            boot_id = current_boot_id()
            stored = await redis.get(RADIO_BOOT_KEY)
            if stored != boot_id:
                await redis.set(RADIO_BOOT_KEY, boot_id)
                await redis.delete(REDIS_STATE_KEY)
                logger.info("Nouveau lancement du service : état radio temporaire purgé")
                return
            raw = await redis.get(REDIS_STATE_KEY)
        except Exception as e:
            logger.warning(f"Impossible de lire l'état radio depuis Redis au démarrage : {e}")
            return
        if not raw:
            return
        try:
            saved = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("État radio Redis illisible, ignoré")
            return
        for key in self.state:
            if key in saved:
                self.state[key] = saved[key]

    async def _persist_to_redis(self):
        try:
            await get_redis().set(REDIS_STATE_KEY, json.dumps(self.state))
        except Exception as e:
            logger.warning(f"Impossible d'enregistrer l'état radio dans Redis : {e}")

    async def _emit(self, cause: str, client_ts: float | None = None):
        payload: dict[str, Any] = {
            "event": "state_change",
            "cause": cause,
            "origin": self._worker_id,
            "channel": RADIO_CHANNEL,
            "data": self.snapshot(),
        }
        if client_ts is not None:
            payload["client_ts"] = client_ts
        await self._persist_to_redis()
        await self._broadcast(payload)

    def apply_remote_state(self, data: dict, origin: str | None):
        """Applique un état radio diffusé par un AUTRE worker (synchro inter-workers)."""
        if origin is not None and origin == self._worker_id:
            return
        for key in self.state:
            if key in data:
                self.state[key] = data[key]

    # ------------------------------------------------------------------
    # Boucle de diffusion de la position (pour la barre de progression live)
    # ------------------------------------------------------------------
    def start_position_broadcast_loop(self):
        if self._position_broadcast_task is None or self._position_broadcast_task.done():
            self._position_broadcast_task = asyncio.create_task(self._position_broadcast_loop())

    def stop_position_broadcast_loop(self):
        if self._position_broadcast_task and not self._position_broadcast_task.done():
            self._position_broadcast_task.cancel()
        self._position_broadcast_task = None

    async def _position_broadcast_loop(self):
        try:
            while True:
                await asyncio.sleep(1.0)
                # Seul le worker qui tient la connexion du lecteur /radio
                # (source de la position) diffuse les ticks, et seulement en
                # lecture — évite des ticks contradictoires entre workers.
                if self.state["playing"] and (time.monotonic() - self._last_direct_report) < 5.0:
                    await self._emit("radio_position_tick")
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _sync_current(self):
        order = self.state["order"]
        idx = self.state["index"]
        if order and idx is not None and 0 <= idx < len(order):
            self.state["current_track"] = order[idx]
            self.state["duration_seconds"] = order[idx].get("duration_seconds")
        else:
            self.state["current_track"] = None
            self.state["duration_seconds"] = None

    def _advance_index(self) -> bool:
        """Avance à la piste suivante en respectant repeat=playlist/shuffle.
        Renvoie False si fin atteinte sans répétition (rien à jouer ensuite)."""
        order = self.state["order"]
        if not order:
            return False
        i = (self.state["index"] or 0) + 1
        if i >= len(order):
            if self.state["repeat"] == "playlist":
                if self.state["shuffle"]:
                    random.shuffle(order)
                i = 0
            else:
                return False
        self.state["index"] = i
        return True

    # ------------------------------------------------------------------
    # Commandes
    # ------------------------------------------------------------------
    async def load_playlist(self, playlist_id: int, name: str, tracks: list[dict],
                            shuffle: bool | None = None, client_ts: float | None = None):
        if shuffle is not None:
            self.state["shuffle"] = bool(shuffle)
        order = list(tracks)
        if self.state["shuffle"]:
            random.shuffle(order)
        self.state["playlist_id"] = playlist_id
        self.state["playlist_name"] = name
        self.state["order"] = order
        self.state["index"] = 0 if order else None
        self.state["position_seconds"] = 0.0
        self.state["playing"] = bool(order)
        self.state["state"] = "playing" if order else "idle"
        self._sync_current()
        await self._emit("radio_load_playlist", client_ts)

    async def play(self, client_ts: float | None = None):
        if self.state["current_track"] is None:
            return
        self.state["playing"] = True
        self.state["state"] = "playing"
        await self._emit("radio_play", client_ts)

    async def pause(self, client_ts: float | None = None):
        if self.state["current_track"] is None:
            return
        self.state["playing"] = False
        self.state["state"] = "paused"
        await self._emit("radio_pause", client_ts)

    async def stop(self, client_ts: float | None = None):
        self.state.update({
            "state": "idle", "playlist_id": None, "playlist_name": None,
            "order": [], "index": None, "current_track": None,
            "duration_seconds": None, "position_seconds": 0.0, "playing": False,
        })
        await self._emit("radio_stop", client_ts)

    async def next_track(self, client_ts: float | None = None):
        """Passage manuel : boucle en fin de liste même sans répétition (geste
        volontaire du DJ), contrairement à la fin de piste automatique."""
        if not self.state["order"]:
            return
        if not self._advance_index():
            self.state["index"] = 0  # wrap manuel
            if self.state["shuffle"]:
                random.shuffle(self.state["order"])
        self.state["position_seconds"] = 0.0
        self.state["playing"] = True
        self.state["state"] = "playing"
        self._sync_current()
        await self._emit("radio_next_track", client_ts)

    async def previous_track(self, client_ts: float | None = None):
        if not self.state["order"]:
            return
        # Au-delà de 3 s, « précédent » redémarre la piste courante (comme Spotify).
        if self.state["position_seconds"] > 3.0:
            self.state["position_seconds"] = 0.0
            await self._emit("radio_restart_track", client_ts)
            return
        i = (self.state["index"] or 0) - 1
        if i < 0:
            i = len(self.state["order"]) - 1 if self.state["repeat"] == "playlist" else 0
        self.state["index"] = i
        self.state["position_seconds"] = 0.0
        self.state["playing"] = True
        self.state["state"] = "playing"
        self._sync_current()
        await self._emit("radio_previous_track", client_ts)

    async def jump_to(self, index: int, client_ts: float | None = None):
        order = self.state["order"]
        if not order or not (0 <= index < len(order)):
            return
        self.state["index"] = index
        self.state["position_seconds"] = 0.0
        self.state["playing"] = True
        self.state["state"] = "playing"
        self._sync_current()
        await self._emit("radio_jump_to_track", client_ts)

    async def track_ended(self, client_ts: float | None = None):
        """Fin de piste rapportée par le lecteur /radio : enchaînement auto."""
        if not self.state["order"]:
            return
        if self.state["repeat"] == "track":
            self.state["position_seconds"] = 0.0
            await self._emit("radio_restart_track", client_ts)
            return
        if self._advance_index():
            self.state["position_seconds"] = 0.0
            self.state["playing"] = True
            self.state["state"] = "playing"
            self._sync_current()
            await self._emit("radio_next_track", client_ts)
        else:
            # Fin de playlist, pas de répétition : on s'arrête sur la dernière.
            self.state["playing"] = False
            self.state["state"] = "paused"
            self.state["position_seconds"] = 0.0
            await self._emit("radio_ended", client_ts)

    async def seek(self, position_seconds: float, client_ts: float | None = None):
        self.state["position_seconds"] = max(0.0, position_seconds)
        await self._emit("radio_seek", client_ts)

    async def set_volume(self, volume: float, client_ts: float | None = None):
        self.state["volume"] = max(0, min(100, int(volume)))
        await self._emit("radio_volume", client_ts)

    async def set_shuffle(self, on: bool, client_ts: float | None = None):
        self.state["shuffle"] = bool(on)
        order = self.state["order"]
        idx = self.state["index"]
        # Ne réordonne que les pistes À VENIR (garde l'historique et la piste
        # courante en place). Désactiver le shuffle ne restaure pas l'ordre
        # d'origine (recharger la playlist pour cela) — limitation assumée en L3.
        if on and order and idx is not None and idx + 1 < len(order):
            upcoming = order[idx + 1:]
            random.shuffle(upcoming)
            self.state["order"] = order[: idx + 1] + upcoming
        await self._emit("radio_set_shuffle", client_ts)

    async def set_repeat(self, mode: str, client_ts: float | None = None):
        if mode not in REPEAT_MODES:
            return
        self.state["repeat"] = mode
        await self._emit("radio_set_repeat", client_ts)

    async def add_to_queue(self, track: dict, client_ts: float | None = None):
        """Ajoute une piste « à suivre » juste après la piste courante."""
        order = self.state["order"]
        idx = self.state["index"]
        insert_at = (idx + 1) if idx is not None else len(order)
        order.insert(insert_at, track)
        self.state["order"] = order
        # Si rien ne jouait, cette piste devient la piste courante.
        if self.state["index"] is None:
            self.state["index"] = 0
            self._sync_current()
        await self._emit("radio_queue_changed", client_ts)

    async def remove_from_order(self, index: int, client_ts: float | None = None):
        """Retire une piste de l'ordre de lecture (file d'attente)."""
        order = self.state["order"]
        if not (0 <= index < len(order)):
            return
        cur = self.state["index"] or 0
        order.pop(index)
        if index < cur:
            self.state["index"] = cur - 1
        elif index == cur:
            # La piste courante a été retirée : on reste sur le même index
            # (= piste suivante) en le bornant à la fin de liste.
            self.state["index"] = min(cur, len(order) - 1) if order else None
        self.state["order"] = order
        if not order:
            self.state.update({"playing": False, "state": "idle"})
        self._sync_current()
        await self._emit("radio_queue_changed", client_ts)

    async def report_position(self, position_seconds: float):
        """Rapport de position du lecteur /radio (pas de diffusion à chaque
        appel — la boucle de position s'en charge)."""
        self.state["position_seconds"] = max(0.0, position_seconds)
        self._last_direct_report = time.monotonic()
        await self._persist_to_redis()


_manager: RadioPlaybackManager | None = None


def init_radio_manager(broadcast: BroadcastFn) -> RadioPlaybackManager:
    global _manager
    _manager = RadioPlaybackManager(broadcast)
    return _manager


def get_radio_manager() -> RadioPlaybackManager:
    if _manager is None:
        raise RuntimeError("RadioPlaybackManager non initialisé")
    return _manager
