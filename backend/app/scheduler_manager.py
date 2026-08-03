import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone

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
from app.utils.redis_client import get_redis

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

# Tolérance de retard APScheduler (réf. sync_schedule_job, misfire_grace_time)
# ET marge de recalage du jour civil dans fire_schedule ci-dessous : les DEUX
# doivent rester identiques (correctif "recherche d'exception en course avec
# la marge de tolérance de retard"), sinon une programmation proche de minuit
# qui se déclenche avec quelques secondes de retard (redémarrage, contention)
# chercherait par erreur l'override du jour SUIVANT au lieu de celui
# réellement visé.
MISFIRE_GRACE_SECONDS = 60

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
                        "channel": schedule.channel or "cable",
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
                        "channel": schedule.channel or "cable",
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
                        "channel": schedule.channel or "cable",
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
                        "channel": schedule.channel or "cable",
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


async def _launch_target(
    db: Session, target_type: ScheduleTargetType, target_id: int, channel: str = "cable"
) -> None:
    """Lance la cible d'une programmation sur l'état de lecture de SON canal
    (réf. mission "tableaux de bord Câblé / Réseau" : un planning par canal,
    zéro interférence entre les deux lectures)."""
    manager = get_playback_manager(channel)
    current = manager.snapshot()

    # F10.7 — priorité au mode audio coach : contrairement à F5.3, la
    # programmation n'est PAS prioritaire ici. Le coach anime un cours en
    # physique ; une programmation automatique ne doit surtout pas lui couper
    # le son. On n'appelle jamais _launch_target dans ce cas : la cible est
    # mémorisée telle quelle (pas de position, elle n'a jamais démarré) pour
    # une relance manuelle ultérieure depuis l'UI, et on s'arrête là.
    # (Ne peut concerner que le canal câblé, seul à porter le mode coach.)
    if current["state"] == PlaybackStateEnum.coach_mode.value:
        db.query(PlaybackState).filter(PlaybackState.channel == channel).delete()
        db.add(
            PlaybackState(
                target_type=target_type.value,
                target_id=target_id,
                cause="coach_priority",
                channel=channel,
            )
        )
        db.commit()
        logger.info(
            f"Programmation ({target_type.value} {target_id}) reportée : mode audio coach actif (réf. F10.7)"
        )
        return

    # Réf. correctif "état interrompu incorrect pendant l'attente entre deux
    # vidéos d'une playlist" : `current_video` reste renseigné (celui qui
    # vient de se terminer) pendant `playlist_waiting`, comme le sont déjà
    # obligées de le vérifier PlaybackManager.play/pause/seek/report_position
    # — sans cette même exclusion ici, une programmation qui se déclenche
    # exactement dans cette fenêtre de quelques secondes croit qu'une "vidéo
    # manuelle" est active et sauvegarde une fausse interruption pointant sur
    # la vidéo déjà terminée (position ≈ sa fin, rien de sensé à reprendre).
    manual_video_active = current["current_video"] is not None and current["state"] not in (
        PlaybackStateEnum.waiting.value,
        PlaybackStateEnum.offline.value,
        PlaybackStateEnum.playlist_waiting.value,
    )

    # Règle de conflit RÉSEAU (retour utilisateur 2026-07-21) : sur ce canal,
    # un lancement manuel en cours gagne toujours — une programmation qui
    # arrive en même temps est simplement annulée, sans jamais interrompre la
    # lecture manuelle. Contraire à F5.3 (câblé) ci-dessous : le réseau sert
    # des appareils individuels lancés à la demande, pas le planning de la
    # salle physique, donc la priorité s'inverse.
    if channel == "network" and manual_video_active:
        logger.info(
            f"Programmation ({target_type.value} {target_id}) annulée : lecture manuelle en cours sur le "
            "canal réseau (priorité au manuel, réf. retour utilisateur 2026-07-21)"
        )
        return

    # F5.3 — règle de conflit CÂBLÉ : la programmation est prioritaire sur une
    # lecture manuelle en cours. On ne la reprend jamais automatiquement ;
    # on mémorise juste sa position pour une relance manuelle depuis l'UI
    # (endpoints /api/playback/interrupted*). Une seule interruption "en
    # attente de reprise" à la fois PAR CANAL : la précédente (non reprise)
    # du même canal est purgée.
    if manual_video_active:
        db.query(PlaybackState).filter(PlaybackState.channel == channel).delete()
        db.add(
            PlaybackState(
                video_id=current["current_video"]["id"],
                position_seconds=current["position_seconds"],
                cause="schedule",
                channel=channel,
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


async def _acquire_fire_lock(schedule_id: int) -> bool:
    """
    Avec plusieurs workers uvicorn (réf. plan perf/concurrence Phase 1), chaque
    processus démarre son propre AsyncIOScheduler à partir de la même règle
    cron : sans garde-fou, une programmation se déclencherait donc une fois
    PAR worker au même instant. Un verrou distribué Redis (SET NX PX) garantit
    qu'un seul worker exécute réellement le lancement — les autres constatent
    que le verrou est déjà pris et abandonnent silencieusement.

    Tous les workers tournent sur la même machine (même horloge système), donc
    leurs AsyncIOScheduler respectifs déclenchent le même job à quelques
    millisecondes d'écart, pas à la seconde près : une fenêtre de 2s (avec une
    expiration tout aussi courte, pour ne pas bloquer une occurrence future
    distincte) suffit largement à les regrouper sous la même clé sans risquer
    de retenir un verrou périmé d'une exécution précédente.

    Si Redis est injoignable, on choisit de laisser passer l'exécution plutôt
    que de risquer de perdre une programmation : mieux vaut un déclenchement
    en double occasionnel qu'un cours qui ne démarre jamais.
    """
    two_second_bucket = int(datetime.now(timezone.utc).timestamp() // 2)
    lock_key = f"schedule:firelock:{schedule_id}:{two_second_bucket}"
    try:
        acquired = await get_redis().set(lock_key, "1", nx=True, px=10_000)
        return bool(acquired)
    except Exception as e:
        logger.warning(
            f"Verrou Redis indisponible pour la programmation {schedule_id}, "
            f"exécution locale sans dédoublonnage inter-workers : {e}"
        )
        return True


async def fire_schedule(schedule_id: int) -> None:
    """Callback APScheduler déclenché à l'heure d'une programmation."""
    if not await _acquire_fire_lock(schedule_id):
        logger.info(f"Programmation {schedule_id} déjà prise en charge par un autre worker, ignorée ici")
        return
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
            # Recalé de MISFIRE_GRACE_SECONDS avant de prendre le jour civil
            # (réf. correctif "recherche d'exception en course avec la marge
            # de tolérance de retard") : ce callback peut s'exécuter jusqu'à
            # misfire_grace_time secondes après l'heure prévue (add_job
            # ci-dessous). Sans ce recalage, une programmation à 23:59:30
            # déclenchée avec 45s de retard (23:59:75 = 00:00:15) verrait
            # `date.today()` retourner le jour SUIVANT, alors que l'override
            # (annulation/remplacement) visé par l'utilisateur a été créé
            # pour le jour ORIGINALEMENT prévu.
            today = (datetime.now(LOCAL_TZ) - timedelta(seconds=MISFIRE_GRACE_SECONDS)).date()
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

        await _launch_target(db, target_type, target_id, schedule.channel or "cable")
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

    try:
        if schedule.schedule_type == ScheduleType.once:
            run_at = ensure_utc(schedule.run_at) if schedule.run_at else None
            if not run_at or run_at <= datetime.now(timezone.utc):
                remove_schedule_job(schedule.id)
                return
            trigger = DateTrigger(run_date=run_at)
        else:
            trigger = _build_cron_trigger(schedule)
    except Exception as e:
        # Réf. correctif "json.loads non protégé sur une ligne malformée peut
        # interrompre toute la boucle de resynchronisation au démarrage" :
        # start_scheduler() appelle sync_schedule_job() pour CHAQUE
        # programmation active dans une simple boucle for — une seule ligne
        # corrompue (recurrence_rule invalide après une édition manuelle en
        # base, par ex.) levait une exception qui remontait jusqu'à
        # start_scheduler(), empêchant TOUTES les programmations suivantes de
        # la boucle d'être rechargées, et donc le démarrage même du backend
        # (appelé depuis le lifespan FastAPI, jamais protégé). On ignore
        # cette seule programmation, en le signalant clairement.
        logger.error(f"Programmation {schedule.id} ignorée : règle de récurrence invalide ({e})")
        remove_schedule_job(schedule.id)
        return

    _scheduler.add_job(
        fire_schedule,
        trigger=trigger,
        id=job_id,
        args=[schedule.id],
        replace_existing=True,
        # Tolère un redémarrage court du backend à cheval sur l'heure de
        # déclenchement (le mini PC peut redémarrer) sans pour autant rejouer
        # une programmation manquée depuis des heures.
        misfire_grace_time=MISFIRE_GRACE_SECONDS,
    )


def remove_schedule_job(schedule_id: int) -> None:
    if _scheduler is None:
        return
    if _scheduler.get_job(_job_id(schedule_id)):
        _scheduler.remove_job(_job_id(schedule_id))


# ---------------------------------------------------------------------------
# Propagation inter-workers (réf. correctif "la modification d'un planning ne
# se propage qu'au worker qui a reçu la requête") : sync_schedule_job/
# remove_schedule_job ci-dessus ne touchent que l'AsyncIOScheduler EN MÉMOIRE
# du worker courant, sans jobstore ni verrou partagé. En production (install.sh
# lance uvicorn --workers 4), seul le worker ayant reçu la requête HTTP de
# création/modification/suppression voyait donc son déclencheur à jour — les
# 3 autres gardaient l'ancien : une récurrence modifiée se déclenchait alors
# en double à l'ancien horaire (chaque worker restant la déclenche une fois),
# et un déplacement d'horaire pouvait ne jamais se déclencher si l'ancien tir,
# sur un des workers à jour, avait déjà marqué l'occurrence "once" comme faite.
#
# On republie donc chaque changement sur un canal Redis dédié, sur le même
# principe que ws_manager.py pour l'état de lecture : CHAQUE worker (y
# compris l'émetteur, qui réapplique alors sans effet réel) relit la
# programmation depuis SA PROPRE session DB et appelle la fonction locale
# ci-dessus — pas l'objet Schedule lui-même qui ne voyage pas sur Redis.
SCHEDULE_SYNC_CHANNEL = "schedule:sync"

_schedule_sync_task: asyncio.Task | None = None


async def broadcast_schedule_change(schedule_id: int, removed: bool = False) -> None:
    """À appeler après CHAQUE création/modification/suppression de
    programmation (cf. routers/schedule.py), en plus de l'appel local à
    sync_schedule_job/remove_schedule_job — jamais à la place."""
    try:
        await get_redis().publish(
            SCHEDULE_SYNC_CHANNEL,
            json.dumps({"schedule_id": schedule_id, "removed": removed}),
        )
    except Exception as e:
        logger.warning(
            f"Publication Redis indisponible pour la programmation {schedule_id} : "
            f"les autres workers ne verront ce changement qu'à leur prochain redémarrage. {e}"
        )


def _apply_schedule_sync_message(data: dict) -> None:
    schedule_id = data.get("schedule_id")
    if schedule_id is None:
        return
    if data.get("removed"):
        remove_schedule_job(schedule_id)
        return
    db = SessionLocal()
    try:
        schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
        # Déjà supprimée/désactivée entre l'émission et la réception ailleurs
        # (rare mais possible) : sync_schedule_job gère déjà ce cas via
        # `schedule.active`, il ne reste qu'à couvrir la suppression pure.
        if schedule:
            sync_schedule_job(schedule)
        else:
            remove_schedule_job(schedule_id)
    finally:
        db.close()


async def _listen_schedule_sync(pubsub) -> None:
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                data = json.loads(message["data"])
            except (TypeError, ValueError):
                logger.warning("Message de synchronisation planning invalide, ignoré")
                continue
            try:
                _apply_schedule_sync_message(data)
            except Exception as e:
                logger.error(f"Échec d'application d'une synchronisation de planning distante : {e}")
    except asyncio.CancelledError:
        pass
    finally:
        await pubsub.unsubscribe(SCHEDULE_SYNC_CHANNEL)
        await pubsub.aclose()


async def start_schedule_sync_listener() -> None:
    global _schedule_sync_task
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(SCHEDULE_SYNC_CHANNEL)
    _schedule_sync_task = asyncio.create_task(_listen_schedule_sync(pubsub))


async def stop_schedule_sync_listener() -> None:
    global _schedule_sync_task
    if _schedule_sync_task:
        _schedule_sync_task.cancel()
        try:
            await _schedule_sync_task
        except asyncio.CancelledError:
            pass
        _schedule_sync_task = None


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
