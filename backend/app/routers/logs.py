import logging
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import ActivityLog

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/logs", tags=["logs"])


class ActivityLogResponse(BaseModel):
    id: int
    timestamp: datetime
    event_type: str
    detail: str | None

    class Config:
        from_attributes = True


@router.get("/activity", response_model=List[ActivityLogResponse])
def list_activity_logs(
    event_type: str | None = None,
    limit: int = Query(200, le=1000),
    db: Session = Depends(get_db),
):
    """Log d'activité filtrable (réf. F8.1, UX3.18)."""
    query = db.query(ActivityLog).order_by(ActivityLog.id.desc())
    if event_type:
        query = query.filter(ActivityLog.event_type == event_type)
    return query.limit(limit).all()


@router.get("/activity/event-types", response_model=List[str])
def list_activity_event_types(db: Session = Depends(get_db)):
    rows = db.query(ActivityLog.event_type).distinct().all()
    return sorted({r[0] for r in rows})


@router.get("/technical", response_class=PlainTextResponse)
def get_technical_log(lines: int = Query(500, le=5000)):
    """Log technique brut (réf. F8.2, UX3.18) : erreurs backend, échecs de lecture, etc."""
    log_path = settings.technical_log_path
    if not log_path.exists():
        return ""
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.readlines()
    return "".join(content[-lines:])


@router.get("/technical/download")
def download_technical_log():
    """Téléchargement du log technique complet (réf. UX3.18)."""
    from fastapi.responses import FileResponse

    log_path = settings.technical_log_path
    if not log_path.exists():
        return PlainTextResponse("", media_type="text/plain")
    return FileResponse(log_path, filename="openlesmillscinema-technical.log", media_type="text/plain")
