import asyncio
import enum
import json
import logging
import os
import time
from typing import Any, Awaitable, Callable

from app.utils.boot_state import BOOT_ID_REDIS_KEY, current_boot_id
from app.utils.redis_client import get_redis
from app.utils.tick_lock import acquire_tick_lock

logger = logging.getLogger(__name__)

BroadcastFn = Callable[[dict], Awaitable[None]]

# Réf. correctif "contrairement à PlaybackManager, le minuteur n'a aucune
# persistance Redis — le crash d'un worker gèle définitivement l'état pour
# les autres, sans reprise possible" : même mécanique que
# playback_manager.REDIS_STATE_KEY_PREFIX, une seule clé ici (pas de canal —
# le minuteur est unique pour tout l'écran cinéma, indépendant câblé/réseau).
TIMER_REDIS_STATE_KEY = "timer:state"


class TimerMode(str, enum.Enum):
    next_course = "next_course"
    countdown = "countdown"
    countup = "countup"
    hidden = "hidden"


class TimerManager:
    """
    Minuteur/chronomètre de l'écran cinéma (Lot 4, réf. F1.3, UX2.4-2.7).
    Indépendant de la lecture vidéo : reste utilisable pendant l'attente, en
    overlay sur un fond animé (Lot 7) ou pendant le mode audio (Lot 8).

    Le mode "next_course" n'a pas de tâche de tick serveur : c'est un simple
    compte à rebours jusqu'à `schedule.next.run_at`, calculé côté client à
    partir de l'horloge locale (cf. §5.5 fonctionnement hors ligne).
    """

    def __init__(self, broadcast: BroadcastFn):
        self._broadcast = broadcast
        # Même mécanique d'origine que PlaybackManager (correctif "0
        # synchronisation") : chaque worker applique les états diffusés par
        # les autres pour que son snapshot REST/WebSocket reste juste.
        self._worker_id = str(os.getpid())
        self._task: asyncio.Task | None = None
        self.state: dict[str, Any] = {
            "mode": TimerMode.next_course.value,
            "running": False,
            "remaining_seconds": None,
            "elapsed_seconds": None,
            "ended": False,
            # Instants serveur absolus (epoch ms, réf. audit
            # plan-corrections-bugs, point 7) : permettent au kiosk de
            # calculer l'affichage localement à chaque frame plutôt que
            # d'attendre le tick serveur par seconde (rendu saccadé au
            # moindre aléa réseau). None quand non pertinent (arrêté/en pause).
            "ends_at": None,
            "started_at": None,
        }

    def snapshot(self) -> dict:
        return dict(self.state)

    async def sync_from_redis(self):
        """
        À appeler au démarrage de CE worker (lifespan FastAPI), avant de
        traiter la moindre commande — même rôle que
        PlaybackManager.sync_from_redis (réf. correctif "le minuteur n'a
        aucune persistance Redis, contrairement à PlaybackManager").

        Purge au redémarrage COMPLET du service (boot_id différent, cf.
        app.utils.boot_state) : un minuteur en cours avant une coupure/mise à
        jour n'a plus de sens à reprendre. Sinon (un seul worker relancé par
        le superviseur au sein du même lancement), l'état est repris tel
        quel — et si celui-ci indique un minuteur toujours "en cours", la
        tâche de tick LOCALE est relancée immédiatement : sans ça, seul le
        worker qui avait initialement reçu start_countdown/start_countup la
        faisait vivre en mémoire ; s'il crashait, les AUTRES workers gardaient
        (via apply_remote_state) un état affiché "en cours" tandis que plus
        aucun processus ne décrémentait ni ne diffusait de tick — le
        minuteur semblait gelé indéfiniment, sans aucune reprise possible
        avant une commande manuelle (pause/reset). Le verrou de tick
        (acquire_tick_lock, cf. _run_countdown/_run_countup) évite qu'un
        redémarrage simultané des 4 workers ne fasse toutes les copies
        relancées décompter en double.
        """
        try:
            redis = get_redis()
            boot_id = current_boot_id()
            stored_boot_id = await redis.get(BOOT_ID_REDIS_KEY)
            if stored_boot_id != boot_id:
                # Premier worker (PlaybackManager ou TimerManager) à détecter
                # ce nouveau lancement : idempotent si plusieurs s'en
                # aperçoivent en même temps.
                await redis.set(BOOT_ID_REDIS_KEY, boot_id)
                await redis.delete(TIMER_REDIS_STATE_KEY)
                logger.info("Nouveau lancement du service : état du minuteur temporaire purgé")
                return
            raw = await redis.get(TIMER_REDIS_STATE_KEY)
        except Exception as e:
            logger.warning(f"Impossible de lire l'état du minuteur depuis Redis au démarrage : {e}")
            return
        if not raw:
            return
        try:
            saved_state = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("État du minuteur Redis illisible, ignoré")
            return
        for key in self.state:
            if key in saved_state:
                self.state[key] = saved_state[key]
        if self.state["running"] and self.state["mode"] == TimerMode.countdown.value:
            self._task = asyncio.create_task(self._run_countdown())
        elif self.state["running"] and self.state["mode"] == TimerMode.countup.value:
            self._task = asyncio.create_task(self._run_countup())

    async def _persist_to_redis(self):
        try:
            await get_redis().set(TIMER_REDIS_STATE_KEY, json.dumps(self.state))
        except Exception as e:
            logger.warning(f"Impossible d'enregistrer l'état du minuteur dans Redis : {e}")

    async def _emit(self, cause: str):
        await self._persist_to_redis()
        await self._broadcast({
            "event": "timer_change",
            "cause": cause,
            "origin": self._worker_id,
            "data": self.snapshot(),
        })

    def apply_remote_state(self, data: dict, origin: str | None):
        """Applique un état minuteur diffusé par un autre worker (cf.
        PlaybackManager.apply_remote_state). Les boucles de tick locales
        vérifient `running` à chaque tour : un pause/reset traité ailleurs les
        arrête donc naturellement via cette mise à jour ; l'annulation
        explicite ci-dessous ne fait que couper court sans attendre le tour
        suivant."""
        if origin is not None and origin == self._worker_id:
            return
        for key in self.state:
            if key in data:
                self.state[key] = data[key]
        if not self.state["running"]:
            self._cancel_task()

    def _cancel_task(self):
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None

    async def set_mode(self, mode: str | None):
        if mode not in (m.value for m in TimerMode):
            return
        self._cancel_task()
        self.state.update({
            "mode": mode,
            "running": False,
            "remaining_seconds": None,
            "elapsed_seconds": None,
            "ended": False,
            "ends_at": None,
            "started_at": None,
        })
        await self._emit("mode")

    async def start_countdown(self, seconds: float):
        self._cancel_task()
        seconds = max(0.0, float(seconds))
        self.state.update({
            "mode": TimerMode.countdown.value,
            "remaining_seconds": seconds,
            "elapsed_seconds": None,
            "running": True,
            "ended": False,
            "ends_at": time.time() * 1000 + seconds * 1000,
            "started_at": None,
        })
        await self._emit("start")
        self._task = asyncio.create_task(self._run_countdown())

    async def start_countup(self):
        self._cancel_task()
        self.state.update({
            "mode": TimerMode.countup.value,
            "elapsed_seconds": 0.0,
            "remaining_seconds": None,
            "running": True,
            "ended": False,
            "ends_at": None,
            "started_at": time.time() * 1000,
        })
        await self._emit("start")
        self._task = asyncio.create_task(self._run_countup())

    async def _run_countdown(self):
        # Verrou de tick (réf. correctif "aucune de ces tâches n'a l'équivalent
        # du verrou de déclenchement Redis utilisé pour le planning") : au
        # repos, un seul worker fait vivre ce minuteur — ce verrou ne protège
        # que le cas où une reprise après crash (cf. sync_from_redis) laisse
        # momentanément deux copies actives, qui décompteraient sinon chacune
        # de leur côté.
        lock_key = "tick:timer:countdown"
        try:
            # TTL du verrou < intervalle de tick (1 s) et drapeau du worker qui
            # atteint 0 : même correctif que PlaybackMan._run_waiting_period —
            # un TTL ≥ 1 s faisait entrer le worker en collision avec son propre
            # verrou (décompte serveur 2× trop lent) et la re-tentative finale
            # échouait, si bien que l'évènement "end" ne partait jamais.
            ended_here = False
            while self.state["running"] and (self.state["remaining_seconds"] or 0) > 0:
                await asyncio.sleep(1.0)
                if not self.state["running"]:
                    return
                if not await acquire_tick_lock(lock_key, ttl_ms=800):
                    continue
                self.state["remaining_seconds"] = max(0.0, self.state["remaining_seconds"] - 1.0)
                await self._emit("tick")
                if self.state["remaining_seconds"] == 0:
                    ended_here = True
            if self.state["running"] and self.state["remaining_seconds"] == 0:
                if not ended_here and not await acquire_tick_lock(lock_key, ttl_ms=800):
                    return
                self.state["running"] = False
                self.state["ended"] = True
                await self._emit("end")
        except asyncio.CancelledError:
            pass

    async def _run_countup(self):
        lock_key = "tick:timer:countup"
        try:
            while self.state["running"]:
                await asyncio.sleep(1.0)
                if not self.state["running"]:
                    return
                # TTL < 1 s : cf. _run_countdown, sinon le worker se bloque sur
                # son propre verrou et le compteur monte 2× trop lentement.
                if not await acquire_tick_lock(lock_key, ttl_ms=800):
                    continue
                self.state["elapsed_seconds"] = (self.state["elapsed_seconds"] or 0.0) + 1.0
                await self._emit("tick")
        except asyncio.CancelledError:
            pass

    async def pause(self):
        if self.state["mode"] not in (TimerMode.countdown.value, TimerMode.countup.value):
            return
        self._cancel_task()
        self.state["running"] = False
        # Plus d'instant de référence pertinent tant qu'en pause : le kiosk
        # affiche alors directement remaining_seconds/elapsed_seconds figés,
        # sans interpolation locale (réf. point 7).
        self.state["ends_at"] = None
        self.state["started_at"] = None
        await self._emit("pause")

    async def resume(self):
        now_ms = time.time() * 1000
        if self.state["mode"] == TimerMode.countdown.value and self.state["remaining_seconds"]:
            self._cancel_task()
            self.state["running"] = True
            self.state["ends_at"] = now_ms + self.state["remaining_seconds"] * 1000
            await self._emit("resume")
            self._task = asyncio.create_task(self._run_countdown())
        elif self.state["mode"] == TimerMode.countup.value:
            self._cancel_task()
            self.state["running"] = True
            self.state["started_at"] = now_ms - (self.state["elapsed_seconds"] or 0.0) * 1000
            await self._emit("resume")
            self._task = asyncio.create_task(self._run_countup())

    async def adjust(self, delta_seconds: float):
        if self.state["mode"] == TimerMode.countdown.value and self.state["remaining_seconds"] is not None:
            self.state["remaining_seconds"] = max(0.0, self.state["remaining_seconds"] + delta_seconds)
            self.state["ended"] = False
            if self.state["running"]:
                self.state["ends_at"] = time.time() * 1000 + self.state["remaining_seconds"] * 1000
            await self._emit("adjust")

    async def reset(self):
        self._cancel_task()
        self.state.update({
            "running": False,
            "remaining_seconds": None,
            "elapsed_seconds": None,
            "ended": False,
            "ends_at": None,
            "started_at": None,
        })
        await self._emit("reset")


_manager: TimerManager | None = None


def init_timer_manager(broadcast: BroadcastFn) -> TimerManager:
    global _manager
    _manager = TimerManager(broadcast)
    return _manager


def get_timer_manager() -> TimerManager:
    if _manager is None:
        raise RuntimeError("TimerManager non initialisé")
    return _manager
