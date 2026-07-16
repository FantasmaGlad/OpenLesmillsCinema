import json
import logging
from datetime import date, datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from sqlalchemy.orm import Session
from tzlocal import get_localzone

from app.database import SessionLocal
from app.models import (
    OverrideAction,
    Playlist,
    PlaybackState,
    Schedule,
    ScheduleOverride,
    ScheduleTargetType,
    ScheduleType,
    Video,
)
from app.playback_manager import PlaybackStateEnum, get_playback_manager

logger = logging.getLogger(__name__)

# Le planning représente le programme réel d'une salle physique : les horaires
# saisis par l'utilisateur (ex. "RPM tous les mardis 18h00") sont des heures
# locales de la salle. On ancre donc le scheduler sur le fuseau local de la
# machine plutôt que UTC, pour que les récurrences restent correctes après un
# changement d'heure été/hiver (F5.5 : fonctionnement horloge locale).
LOCAL_TZ = get_localzone()

# Filet de sécurité anti-boucle infinie lors du déroulé d'une récurrence sur
# une plage de dates (ne devrait jamais être atteint en usage normal : une
# programmation hebdomadaire sur une plage d'un an ne produit que ~52 occurrences).
_MAX_OCCURRENCES_PER_SCHEDULE = 1000

_scheduler: AsyncIOScheduler | None = None


def _job_id(schedule_id: int) -> str:
    return f"schedule-{schedule_id}"


def ensure_utc(value: datetime) -> datetime:
    """
    SQLite ne conserve pas le fuseau des datetimes stockés : une valeur aware
    écrite en base est relue *naïve* par SQLAlchemy, alors qu'elle représente
    toujours un instant UTC (convention utilisée dans tout le schéma —
    imported_at, created_at, etc.). On la retague donc systématiquement avant
    toute comparaison ou sérialisation, plutôt que de la laisser se comparer
    silencieusement de travers avec un datetime.now(timezone.utc) frais.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _build_cron_trigger(schedule: Schedule) -> CronTrigger:
    rule = json.loads(schedule.recurrence_rule)
    days = ",".join(str(d) for d in rule["days_of_week"])
    hour, minute = (int(part) for part in rule["time"].split(":"))
    return CronTrigger(day_of_week=days, hour=hour, minute=minute, timezone=LOCAL_TZ)


def resolve_target_title(
    db: Session, target_type: ScheduleTargetType, target_id: int
) -> tuple[str | None, str | None]:
    """Titre + programme d'une cible de programmation, pour l'affichage (planning, overrides)."""
    if target_type == ScheduleTargetType.video:
        video = db.query(Video).filter(Video.id == target_id).first()
        return (video.title, video.program) if video else (None, None)
    playlist = db.query(Playlist).filter(Playlist.id == target_id).first()
    return (playlist.name, None) if playlist else (None, None)


def expand_occurrences(
    db: Session, schedules: list[Schedule], start: datetime, end: datetime
) -> list[dict]:
    """
    Développe une liste de programmations actives en occurrences concrètes
    dans l'intervalle [start, end], overrides résolus (réf. F5.2/F5.4, UX3.14-16).

    Les occurrences annulées sont *incluses* dans le résultat (avec le titre
    d'origine) plutôt qu'omises : le planning doit pouvoir les afficher barrées
    (UX3.15), pas simplement les faire disparaître.
    """
    if not schedules:
        return []

    schedule_ids = [s.id for s in schedules]
    overrides = (
        db.query(ScheduleOverride).filter(ScheduleOverride.schedule_id.in_(schedule_ids)).all()
    )
    overrides_by_key: dict[tuple[int, date], ScheduleOverride] = {
        (o.schedule_id, o.occurrence_date.date()): o for o in overrides
    }

    results: list[dict] = []
    for schedule in schedules:
        if schedule.schedule_type == ScheduleType.once:
            run_at = ensure_utc(schedule.run_at) if schedule.run_at else None
            if run_at and start <= run_at <= end:
                title, program = resolve_target_title(db, schedule.target_type, schedule.target_id)
                results.append(
                    {
                        "schedule_id": schedule.id,
                        "schedule_type": schedule.schedule_type,
                        "run_at": run_at,
                        "target_type": schedule.target_type,
                        "target_id": schedule.target_id,
                        "title": title,
                        "program": program,
                        "is_override": False,
                        "override_action": None,
                        "override_id": None,
                    }
                )
            continue

        trigger = _build_cron_trigger(schedule)
        fire_time = trigger.get_next_fire_time(None, start)
        guard = 0
        while fire_time is not None and fire_time <= end and guard < _MAX_OCCURRENCES_PER_SCHEDULE:
            guard += 1
            override = overrides_by_key.get((schedule.id, fire_time.date()))

            if override is not None and override.action == OverrideAction.cancelled:
                title, program = resolve_target_title(db, schedule.target_type, schedule.target_id)
                results.append(
                    {
                        "schedule_id": schedule.id,
                        "schedule_type": schedule.schedule_type,
                        "run_at": fire_time,
                        "target_type": schedule.target_type,
                        "target_id": schedule.target_id,
                        "title": title,
                        "program": program,
                        "is_override": True,
                        "override_action": OverrideAction.cancelled,
                        "override_id": override.id,
                    }
                )
            elif override is not None and override.action == OverrideAction.replaced:
                title, program = resolve_target_title(
                    db, override.replacement_target_type, override.replacement_target_id
                )
                results.append(
                    {
                        "schedule_id": schedule.id,
                        "schedule_type": schedule.schedule_type,
                        "run_at": fire_time,
                        "target_type": override.replacement_target_type,
                        "target_id": override.replacement_target_id,
                        "title": title,
                        "program": program,
                        "is_override": True,
                        "override_action": OverrideAction.replaced,
                        "override_id": override.id,
                    }
                )
            else:
                title, program = resolve_target_title(db, schedule.target_type, schedule.target_id)
                results.append(
                    {
                        "schedule_id": schedule.id,
                        "schedule_type": schedule.schedule_type,
                        "run_at": fire_time,
                        "target_type": schedule.target_type,
                        "target_id": schedule.target_id,
                        "title": title,
                        "program": program,
                        "is_override": False,
                        "override_action": None,
                        "override_id": None,
                    }
                )

            fire_time = trigger.get_next_fire_time(fire_time, fire_time)

    results.sort(key=lambda o: o["run_at"])
    return results


async def _launch_target(db: Session, target_type: ScheduleTargetType, target_id: int) -> None:
    manager = get_playback_manager()
    current = manager.snapshot()

    # F10.7 — priorité au mode audio coach : contrairement à F5.3, la
    # programmation n'est PAS prioritaire ici. Le coach anime un cours en
    # physique ; une programmation automatique ne doit surtout pas lui couper
    # le son. On n'appelle jamais _launch_target dans ce cas : la cible est
    # mémorisée telle quelle (pas de position, elle n'a jamais démarré) pour
    # une relance manuelle ultérieure depuis l'UI, et on s'arrête là.
    if current["state"] == PlaybackStateEnum.coach_mode.value:
        db.query(PlaybackState).delete()
        db.add(
            PlaybackState(
                target_type=target_type.value,
                target_id=target_id,
                cause="coach_priority",
            )
        )
        db.commit()
        logger.info(
            f"Programmation ({target_type.value} {target_id}) reportée : mode audio coach actif (réf. F10.7)"
        )
        return

    # F5.3 — règle de conflit : la programmation est prioritaire sur une
    # lecture manuelle en cours. On ne la reprend jamais automatiquement ;
    # on mémorise juste sa position pour une relance manuelle depuis l'UI
    # (endpoints /api/playback/interrupted*). Une seule interruption "en
    # attente de reprise" à la fois : la précédente (non reprise) est purgée.
    if current["current_video"] is not None and current["state"] not in (
        PlaybackStateEnum.waiting.value,
        PlaybackStateEnum.offline.value,
    ):
        db.query(PlaybackState).delete()
        db.add(
            PlaybackState(
                video_id=current["current_video"]["id"],
                position_seconds=current["position_seconds"],
                cause="schedule",
            )
        )
        db.commit()

    if target_type == ScheduleTargetType.video:
        video = db.query(Video).filter(Video.id == target_id).first()
        if not video:
            logger.warning(f"Cible programmée introuvable : vidéo {target_id}")
            return
        thumb = video.thumbnail_path.split("/")[-1] if video.thumbnail_path else None
        await manager.load(video.id, video.title, video.duration_seconds, video.program, thumbnail_url=thumb)
    else:
        playlist = db.query(Playlist).filter(Playlist.id == target_id).first()
        if not playlist:
            logger.warning(f"Cible programmée introuvable : playlist {target_id}")
            return
        sorted_items = sorted(playlist.items, key=lambda item: item.position)
        items_data = [
            {
                "id": item.video.id,
                "title": item.video.title,
                "duration_seconds": item.video.duration_seconds,
                "program": item.video.program,
                "thumbnail_url": item.video.thumbnail_path.split("/")[-1] if item.video.thumbnail_path else None,
            }
            for item in sorted_items
        ]
        await manager.load_playlist(playlist.id, playlist.name, items_data)


async def fire_schedule(schedule_id: int) -> None:
    """Callback APScheduler déclenché à l'heure d'une programmation."""
    db = SessionLocal()
    try:
        schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
        if not schedule or not schedule.active:
            return

        target_type, target_id = schedule.target_type, schedule.target_id

        if schedule.schedule_type == ScheduleType.recurring:
            # Jour civil *local* : une occurrence récurrente est ancrée au
            # calendrier de la salle, pas à la date UTC (qui peut différer
            # près de minuit selon le fuseau).
            today = date.today()
            overrides = (
                db.query(ScheduleOverride).filter(ScheduleOverride.schedule_id == schedule.id).all()
            )
            match = next((o for o in overrides if o.occurrence_date.date() == today), None)
            if match:
                if match.action == OverrideAction.cancelled:
                    logger.info(f"Programmation {schedule.id} : occurrence du {today} annulée (override), non lancée")
                    return
                target_type, target_id = match.replacement_target_type, match.replacement_target_id
        else:
            # Une programmation ponctuelle ne se déclenche qu'une fois :
            # la désactiver évite qu'elle ne traîne comme "active" dans les
            # listes une fois passée.
            schedule.active = False
            db.commit()

        await _launch_target(db, target_type, target_id)
    finally:
        db.close()


def sync_schedule_job(schedule: Schedule) -> None:
    """(Ré)enregistre le job APScheduler d'une programmation, ou le retire si
    elle est inactive/déjà passée. Appelé après chaque création/mise à jour."""
    if _scheduler is None:
        logger.debug(f"Scheduler non démarré : synchronisation ignorée ({_job_id(schedule.id)})")
        return

    job_id = _job_id(schedule.id)

    if not schedule.active:
        remove_schedule_job(schedule.id)
        return

    if schedule.schedule_type == ScheduleType.once:
        run_at = ensure_utc(schedule.run_at) if schedule.run_at else None
        if not run_at or run_at <= datetime.now(timezone.utc):
            remove_schedule_job(schedule.id)
            return
        trigger = DateTrigger(run_date=run_at)
    else:
        trigger = _build_cron_trigger(schedule)

    _scheduler.add_job(
        fire_schedule,
        trigger=trigger,
        id=job_id,
        args=[schedule.id],
        replace_existing=True,
        # Tolère un redémarrage court du backend à cheval sur l'heure de
        # déclenchement (le mini PC peut redémarrer) sans pour autant rejouer
        # une programmation manquée depuis des heures.
        misfire_grace_time=60,
    )


def remove_schedule_job(schedule_id: int) -> None:
    if _scheduler is None:
        return
    if _scheduler.get_job(_job_id(schedule_id)):
        _scheduler.remove_job(_job_id(schedule_id))


def start_scheduler() -> None:
    global _scheduler
    _scheduler = AsyncIOScheduler(timezone=LOCAL_TZ)
    _scheduler.start()

    db = SessionLocal()
    try:
        active_schedules = db.query(Schedule).filter(Schedule.active == True).all()  # noqa: E712
        for schedule in active_schedules:
            sync_schedule_job(schedule)
        logger.info(f"Scheduler démarré, {len(active_schedules)} programmation(s) active(s) rechargée(s)")
    finally:
        db.close()


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
