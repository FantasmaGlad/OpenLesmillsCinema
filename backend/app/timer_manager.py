import asyncio
import enum
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

BroadcastFn = Callable[[dict], Awaitable[None]]


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
        self._task: asyncio.Task | None = None
        self.state: dict[str, Any] = {
            "mode": TimerMode.next_course.value,
            "running": False,
            "remaining_seconds": None,
            "elapsed_seconds": None,
            "ended": False,
        }

    def snapshot(self) -> dict:
        return dict(self.state)

    async def _emit(self, cause: str):
        await self._broadcast({"event": "timer_change", "cause": cause, "data": self.snapshot()})

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
        })
        await self._emit("mode")

    async def start_countdown(self, seconds: float):
        self._cancel_task()
        self.state.update({
            "mode": TimerMode.countdown.value,
            "remaining_seconds": max(0.0, float(seconds)),
            "elapsed_seconds": None,
            "running": True,
            "ended": False,
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
        })
        await self._emit("start")
        self._task = asyncio.create_task(self._run_countup())

    async def _run_countdown(self):
        try:
            while self.state["running"] and (self.state["remaining_seconds"] or 0) > 0:
                await asyncio.sleep(1.0)
                if not self.state["running"]:
                    return
                self.state["remaining_seconds"] = max(0.0, self.state["remaining_seconds"] - 1.0)
                await self._emit("tick")
            if self.state["running"] and self.state["remaining_seconds"] == 0:
                self.state["running"] = False
                self.state["ended"] = True
                await self._emit("end")
        except asyncio.CancelledError:
            pass

    async def _run_countup(self):
        try:
            while self.state["running"]:
                await asyncio.sleep(1.0)
                if not self.state["running"]:
                    return
                self.state["elapsed_seconds"] = (self.state["elapsed_seconds"] or 0.0) + 1.0
                await self._emit("tick")
        except asyncio.CancelledError:
            pass

    async def pause(self):
        if self.state["mode"] not in (TimerMode.countdown.value, TimerMode.countup.value):
            return
        self._cancel_task()
        self.state["running"] = False
        await self._emit("pause")

    async def resume(self):
        if self.state["mode"] == TimerMode.countdown.value and self.state["remaining_seconds"]:
            self._cancel_task()
            self.state["running"] = True
            await self._emit("resume")
            self._task = asyncio.create_task(self._run_countdown())
        elif self.state["mode"] == TimerMode.countup.value:
            self._cancel_task()
            self.state["running"] = True
            await self._emit("resume")
            self._task = asyncio.create_task(self._run_countup())

    async def adjust(self, delta_seconds: float):
        if self.state["mode"] == TimerMode.countdown.value and self.state["remaining_seconds"] is not None:
            self.state["remaining_seconds"] = max(0.0, self.state["remaining_seconds"] + delta_seconds)
            self.state["ended"] = False
            await self._emit("adjust")

    async def reset(self):
        self._cancel_task()
        self.state.update({
            "running": False,
            "remaining_seconds": None,
            "elapsed_seconds": None,
            "ended": False,
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
