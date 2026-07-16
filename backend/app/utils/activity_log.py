import logging

from sqlalchemy.orm import Session

from app.models import ActivityLog

logger = logging.getLogger(__name__)


def log_activity(db: Session, event_type: str, detail: str | None = None) -> None:
    """
    Enregistre un évènement dans le log d'activité (réf. F8.1), consultable
    depuis l'interface (Lot 9.6/UX3.18) : téléversements, imports, lectures,
    playlists, programmations, overrides. Ne doit jamais faire échouer
    l'opération qu'il accompagne — une erreur d'écriture du log est avalée et
    seulement tracée dans le log technique.
    """
    try:
        db.add(ActivityLog(event_type=event_type, detail=detail))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"Échec de l'écriture du log d'activité ({event_type}): {e}")
