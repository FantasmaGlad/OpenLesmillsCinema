from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Playlist, Schedule, ScheduleTargetType, ScheduleType, Video

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


@router.get("/next")
def get_next_schedule(db: Session = Depends(get_db)):
    """
    Prochaine programmation ponctuelle active à venir, pour le bloc « prochain
    cours » de l'écran d'attente (Lot 4, réf. UX2.1/UX2.5). Ne résout pas les
    règles de récurrence ni les overrides : réservé au Lot 6 (planning).
    """
    now = datetime.now(timezone.utc)
    schedule = (
        db.query(Schedule)
        .filter(
            Schedule.active == True,  # noqa: E712
            Schedule.schedule_type == ScheduleType.once,
            Schedule.run_at.isnot(None),
            Schedule.run_at > now,
        )
        .order_by(Schedule.run_at.asc())
        .first()
    )
    if not schedule:
        return None

    title = None
    if schedule.target_type == ScheduleTargetType.video:
        video = db.query(Video).filter(Video.id == schedule.target_id).first()
        title = video.title if video else None
    elif schedule.target_type == ScheduleTargetType.playlist:
        playlist = db.query(Playlist).filter(Playlist.id == schedule.target_id).first()
        title = playlist.name if playlist else None

    return {"run_at": schedule.run_at.isoformat(), "title": title}
