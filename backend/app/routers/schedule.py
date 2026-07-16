import json
import re
from datetime import datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    OverrideAction,
    Playlist,
    Schedule,
    ScheduleOverride,
    ScheduleTargetType,
    ScheduleType,
    Video,
)
from app.scheduler_manager import (
    ensure_utc,
    expand_occurrences,
    remove_schedule_job,
    resolve_target_title,
    sync_schedule_job,
)
from app.utils.activity_log import log_activity

router = APIRouter(prefix="/api/schedule", tags=["schedule"])

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


# ---------------------------------------------------------------------------
# Schémas Pydantic
# ---------------------------------------------------------------------------
class ScheduleInput(BaseModel):
    target_type: ScheduleTargetType
    target_id: int
    schedule_type: ScheduleType
    run_at: datetime | None = None
    days_of_week: List[int] | None = None  # 0=lundi .. 6=dimanche
    time_of_day: str | None = None  # "HH:MM"
    active: bool = True


class ScheduleResponse(BaseModel):
    id: int
    target_type: ScheduleTargetType
    target_id: int
    target_title: str | None
    target_program: str | None
    schedule_type: ScheduleType
    run_at: datetime | None
    days_of_week: List[int] | None
    time_of_day: str | None
    active: bool
    override_count: int


class OverrideInput(BaseModel):
    occurrence_date: str  # "YYYY-MM-DD"
    action: OverrideAction
    replacement_target_type: ScheduleTargetType | None = None
    replacement_target_id: int | None = None


class OverrideResponse(BaseModel):
    id: int
    occurrence_date: str
    action: OverrideAction
    replacement_target_type: ScheduleTargetType | None
    replacement_target_id: int | None
    replacement_title: str | None


class OccurrenceResponse(BaseModel):
    schedule_id: int
    schedule_type: ScheduleType
    run_at: datetime
    target_type: ScheduleTargetType
    target_id: int
    title: str | None
    program: str | None
    is_override: bool
    override_action: OverrideAction | None
    override_id: int | None


# ---------------------------------------------------------------------------
# Aides internes
# ---------------------------------------------------------------------------
def _check_target_exists(db: Session, target_type: ScheduleTargetType, target_id: int) -> None:
    if target_type == ScheduleTargetType.video:
        found = db.query(Video).filter(Video.id == target_id).first()
    else:
        found = db.query(Playlist).filter(Playlist.id == target_id).first()
    if not found:
        raise HTTPException(status_code=400, detail=f"Cible introuvable ({target_type.value} {target_id})")


def _validate_and_normalize(data: ScheduleInput) -> tuple[datetime | None, str | None]:
    """Valide la cohérence des champs selon le type, renvoie (run_at, recurrence_rule_json)."""
    if data.schedule_type == ScheduleType.once:
        if data.run_at is None:
            raise HTTPException(status_code=400, detail="Une programmation ponctuelle nécessite une date/heure")
        run_at = ensure_utc(data.run_at)
        if run_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Une programmation ponctuelle doit être dans le futur")
        return run_at, None

    if not data.days_of_week:
        raise HTTPException(
            status_code=400, detail="Une programmation récurrente nécessite au moins un jour de la semaine"
        )
    if any(d < 0 or d > 6 for d in data.days_of_week):
        raise HTTPException(status_code=400, detail="Jour de semaine invalide (attendu 0=lundi à 6=dimanche)")
    if not data.time_of_day or not _TIME_RE.match(data.time_of_day):
        raise HTTPException(status_code=400, detail="Heure invalide (attendu HH:MM)")

    rule = json.dumps({"days_of_week": sorted(set(data.days_of_week)), "time": data.time_of_day})
    return None, rule


def _to_response(db: Session, schedule: Schedule) -> dict:
    title, program = resolve_target_title(db, schedule.target_type, schedule.target_id)
    days_of_week, time_of_day = None, None
    if schedule.recurrence_rule:
        rule = json.loads(schedule.recurrence_rule)
        days_of_week = rule.get("days_of_week")
        time_of_day = rule.get("time")
    return {
        "id": schedule.id,
        "target_type": schedule.target_type,
        "target_id": schedule.target_id,
        "target_title": title,
        "target_program": program,
        "schedule_type": schedule.schedule_type,
        "run_at": ensure_utc(schedule.run_at) if schedule.run_at else None,
        "days_of_week": days_of_week,
        "time_of_day": time_of_day,
        "active": schedule.active,
        "override_count": len(schedule.overrides),
    }


# ---------------------------------------------------------------------------
# Programmations (CRUD)
# ---------------------------------------------------------------------------
@router.get("", response_model=List[ScheduleResponse])
def list_schedules(db: Session = Depends(get_db)):
    schedules = db.query(Schedule).order_by(Schedule.id.desc()).all()
    return [_to_response(db, s) for s in schedules]


@router.get("/occurrences", response_model=List[OccurrenceResponse])
def list_occurrences(start: datetime, end: datetime, db: Session = Depends(get_db)):
    """
    Occurrences résolues (récurrence + overrides) dans [start, end], pour les
    vues planning calendrier/liste (UX3.14-3.16). Inclut les occurrences
    annulées (à afficher barrées côté UI).
    """
    start, end = ensure_utc(start), ensure_utc(end)
    if end <= start:
        raise HTTPException(status_code=400, detail="La date de fin doit être postérieure à la date de début")
    schedules = db.query(Schedule).filter(Schedule.active == True).all()  # noqa: E712
    return expand_occurrences(db, schedules, start, end)


@router.get("/next")
def get_next_schedule(db: Session = Depends(get_db)):
    """
    Prochaine occurrence active à venir, récurrence et overrides résolus, pour
    le bloc « prochain cours » de l'écran d'attente (Lot 4, réf. UX2.1/UX2.5).
    """
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=60)
    schedules = db.query(Schedule).filter(Schedule.active == True).all()  # noqa: E712
    occurrences = expand_occurrences(db, schedules, now, horizon)
    upcoming = next((o for o in occurrences if o["override_action"] != OverrideAction.cancelled), None)
    if not upcoming:
        return None
    return {"run_at": upcoming["run_at"].isoformat(), "title": upcoming["title"]}


@router.get("/{schedule_id}", response_model=ScheduleResponse)
def get_schedule(schedule_id: int, db: Session = Depends(get_db)):
    schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Programmation non trouvée")
    return _to_response(db, schedule)


@router.post("", response_model=ScheduleResponse)
def create_schedule(data: ScheduleInput, db: Session = Depends(get_db)):
    _check_target_exists(db, data.target_type, data.target_id)
    run_at, recurrence_rule = _validate_and_normalize(data)

    schedule = Schedule(
        target_type=data.target_type,
        target_id=data.target_id,
        schedule_type=data.schedule_type,
        run_at=run_at,
        recurrence_rule=recurrence_rule,
        active=data.active,
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    sync_schedule_job(schedule)
    title, _ = resolve_target_title(db, schedule.target_type, schedule.target_id)
    log_activity(db, "schedule_created", f"{title or schedule.target_type.value} ({schedule.schedule_type.value})")
    return _to_response(db, schedule)


@router.put("/{schedule_id}", response_model=ScheduleResponse)
def update_schedule(schedule_id: int, data: ScheduleInput, db: Session = Depends(get_db)):
    schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Programmation non trouvée")
    _check_target_exists(db, data.target_type, data.target_id)
    run_at, recurrence_rule = _validate_and_normalize(data)

    schedule.target_type = data.target_type
    schedule.target_id = data.target_id
    schedule.schedule_type = data.schedule_type
    schedule.run_at = run_at
    schedule.recurrence_rule = recurrence_rule
    schedule.active = data.active
    db.commit()
    db.refresh(schedule)
    sync_schedule_job(schedule)
    title, _ = resolve_target_title(db, schedule.target_type, schedule.target_id)
    log_activity(db, "schedule_updated", title or schedule.target_type.value)
    return _to_response(db, schedule)


@router.delete("/{schedule_id}")
def delete_schedule(schedule_id: int, db: Session = Depends(get_db)):
    schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Programmation non trouvée")
    title, _ = resolve_target_title(db, schedule.target_type, schedule.target_id)
    db.delete(schedule)
    db.commit()
    remove_schedule_job(schedule_id)
    log_activity(db, "schedule_deleted", title or schedule.target_type.value)
    return {"message": "Programmation supprimée avec succès"}


# ---------------------------------------------------------------------------
# Overrides (exceptions ponctuelles sur une programmation récurrente)
# ---------------------------------------------------------------------------
@router.post("/{schedule_id}/overrides", response_model=OverrideResponse)
def create_override(schedule_id: int, data: OverrideInput, db: Session = Depends(get_db)):
    schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Programmation non trouvée")
    if schedule.schedule_type != ScheduleType.recurring:
        raise HTTPException(status_code=400, detail="Les overrides ne s'appliquent qu'aux programmations récurrentes")

    try:
        occurrence_date = datetime.strptime(data.occurrence_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Date d'occurrence invalide (attendu YYYY-MM-DD)")

    if data.action == OverrideAction.replaced:
        if not data.replacement_target_type or not data.replacement_target_id:
            raise HTTPException(status_code=400, detail="Une occurrence remplacée nécessite une cible de remplacement")
        _check_target_exists(db, data.replacement_target_type, data.replacement_target_id)

    # Une occurrence n'a qu'un seul override actif à la fois : un override
    # précédent sur la même date est remplacé silencieusement.
    existing = (
        db.query(ScheduleOverride)
        .filter(ScheduleOverride.schedule_id == schedule_id, ScheduleOverride.occurrence_date == occurrence_date)
        .first()
    )
    if existing:
        db.delete(existing)
        db.flush()

    override = ScheduleOverride(
        schedule_id=schedule_id,
        occurrence_date=occurrence_date,
        action=data.action,
        replacement_target_type=data.replacement_target_type if data.action == OverrideAction.replaced else None,
        replacement_target_id=data.replacement_target_id if data.action == OverrideAction.replaced else None,
    )
    db.add(override)
    db.commit()
    db.refresh(override)

    title = None
    if override.action == OverrideAction.replaced:
        title, _ = resolve_target_title(db, override.replacement_target_type, override.replacement_target_id)

    log_activity(
        db, "schedule_override_created",
        f"{data.occurrence_date} — {override.action.value}" + (f" par {title}" if title else ""),
    )

    return {
        "id": override.id,
        "occurrence_date": data.occurrence_date,
        "action": override.action,
        "replacement_target_type": override.replacement_target_type,
        "replacement_target_id": override.replacement_target_id,
        "replacement_title": title,
    }


@router.delete("/{schedule_id}/overrides/{override_id}")
def delete_override(schedule_id: int, override_id: int, db: Session = Depends(get_db)):
    override = (
        db.query(ScheduleOverride)
        .filter(ScheduleOverride.id == override_id, ScheduleOverride.schedule_id == schedule_id)
        .first()
    )
    if not override:
        raise HTTPException(status_code=404, detail="Override non trouvé")
    db.delete(override)
    db.commit()
    return {"message": "Override supprimé, l'occurrence redevient normale"}
