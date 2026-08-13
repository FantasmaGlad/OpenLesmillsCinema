"""Router des rappels Radio (réf. docs/cahier-des-charges-radio.md §7, lot L6).

Annonces de bienséance intercalées dans la musique : import (fichier +
description obligatoire), activation/retrait, règles de déclenchement (toutes
les N musiques / toutes les X minutes / à heures fixes), et déclenchement
manuel (« jouer maintenant »). Le tirage et l'insertion réels vivent dans
`RadioPlaybackManager.play_announcement` (état) + `radio_announcement_scheduler`
(règles temporelles) + `routers/playback.py::_handle_radio_command` (règle
« toutes les N musiques », à la fin de chaque piste).
"""
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import RadioAnnouncement, RadioAnnouncementRule, RadioAnnouncementRuleType
from app.utils.activity_log import log_activity
from app.utils.executors import io_executor
from app.utils.import_jobs import create_job, update_job
from app.utils.radio_importer import import_radio_announcement, import_radio_announcements_from_files

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/radio", tags=["radio-announcements"])


# ---------------------------------------------------------------------------
# Schémas
# ---------------------------------------------------------------------------
class RadioAnnouncementResponse(BaseModel):
    id: int
    description: str
    duration_seconds: float | None
    enabled: bool


class RadioAnnouncementUpdate(BaseModel):
    description: str | None = None
    enabled: bool | None = None


class PlayNowInput(BaseModel):
    announcement_id: int | None = None


class ImportJobAccepted(BaseModel):
    job_id: str


class RadioAnnouncementRuleResponse(BaseModel):
    id: int
    rule_type: RadioAnnouncementRuleType
    n_tracks: int | None
    interval_minutes: int | None
    times_of_day: List[str] | None
    enabled: bool


class RadioAnnouncementRuleInput(BaseModel):
    rule_type: RadioAnnouncementRuleType
    n_tracks: int | None = None
    interval_minutes: int | None = None
    times_of_day: List[str] | None = None
    enabled: bool = True

    @field_validator("times_of_day")
    @classmethod
    def _validate_times(cls, value: List[str] | None) -> List[str] | None:
        if not value:
            return value
        for t in value:
            parts = t.split(":")
            if len(parts) != 2 or not all(p.isdigit() for p in parts):
                raise ValueError(f"Horaire invalide : {t!r} (attendu HH:MM)")
            h, m = int(parts[0]), int(parts[1])
            if not (0 <= h < 24 and 0 <= m < 60):
                raise ValueError(f"Horaire invalide : {t!r}")
        return value


def _rule_response(rule: RadioAnnouncementRule) -> dict:
    return {
        "id": rule.id,
        "rule_type": rule.rule_type,
        "n_tracks": rule.n_tracks,
        "interval_minutes": rule.interval_minutes,
        "times_of_day": json.loads(rule.times_of_day) if rule.times_of_day else None,
        "enabled": rule.enabled,
    }


def _validate_rule_fields(data: RadioAnnouncementRuleInput) -> None:
    if data.rule_type == RadioAnnouncementRuleType.every_n_tracks and not data.n_tracks:
        raise HTTPException(status_code=400, detail="n_tracks est requis pour une règle « toutes les N musiques »")
    if data.rule_type == RadioAnnouncementRuleType.every_x_minutes and not data.interval_minutes:
        raise HTTPException(status_code=400, detail="interval_minutes est requis pour une règle « toutes les X minutes »")
    if data.rule_type == RadioAnnouncementRuleType.fixed_times and not data.times_of_day:
        raise HTTPException(status_code=400, detail="times_of_day est requis pour une règle « à heures fixes »")


# ---------------------------------------------------------------------------
# Rappels — bibliothèque
# ---------------------------------------------------------------------------
@router.get("/announcements", response_model=List[RadioAnnouncementResponse])
def list_announcements(db: Session = Depends(get_db)):
    return db.query(RadioAnnouncement).order_by(RadioAnnouncement.imported_at.desc()).all()


@router.post("/announcements/upload", response_model=RadioAnnouncementResponse, status_code=201)
def upload_announcement(
    file: UploadFile = File(...), description: str = Form(...), db: Session = Depends(get_db),
):
    """Import synchrone (un seul fichier + description obligatoire, réf. D13) :
    pas de job d'arrière-plan, contrairement aux morceaux — le traitement
    ffprobe/ffmpeg d'un unique fichier reste rapide."""
    description = description.strip()
    if not description:
        raise HTTPException(status_code=400, detail="La description est obligatoire")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "").suffix)
    try:
        shutil.copyfileobj(file.file, tmp)
        tmp.close()
        announcement = import_radio_announcement(tmp.name, description, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Import de rappel échoué : {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Import impossible : {e}")
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass
    return announcement


def _run_announcements_import_job(job_id: str, tmp_dir: Path, temp_paths: list[str]) -> None:
    try:
        announcements = import_radio_announcements_from_files(temp_paths, job_id=job_id)
        update_job(job_id, stage="done", result_id=announcements[0].id if announcements else None)
    except Exception as e:
        logger.error(f"Import de rappels (job {job_id}) échoué : {e}", exc_info=True)
        update_job(job_id, stage="error", error=str(e))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/announcements/upload-batch", response_model=ImportJobAccepted, status_code=202)
def upload_announcements_batch(files: List[UploadFile] = File(...)):
    """Import groupé (plusieurs fichiers ou dossier entier, réf. correctif
    "import de dossiers pour les rappels") : traité en arrière-plan comme les
    morceaux — voir GET /api/import-jobs. Description dérivée automatiquement
    du nom de chaque fichier (décision actée), pas de champ description ici."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="olmc_announcement_upload_"))
    temp_paths = []
    try:
        for f in files:
            dest = tmp_dir / Path(f.filename).name
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out)
            temp_paths.append(str(dest))
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(e))

    label = Path(files[0].filename).name if files else "rappels"
    job_id = create_job("radio_announcement", label, label)
    io_executor.submit(_run_announcements_import_job, job_id, tmp_dir, temp_paths)
    return {"job_id": job_id}


@router.put("/announcements/{announcement_id}", response_model=RadioAnnouncementResponse)
def update_announcement(announcement_id: int, payload: RadioAnnouncementUpdate, db: Session = Depends(get_db)):
    announcement = db.query(RadioAnnouncement).filter(RadioAnnouncement.id == announcement_id).first()
    if not announcement:
        raise HTTPException(status_code=404, detail="Rappel non trouvé")

    fields_set = payload.model_fields_set
    if "description" in fields_set:
        description = (payload.description or "").strip()
        if not description:
            raise HTTPException(status_code=400, detail="La description ne peut pas être vide")
        announcement.description = description
    if "enabled" in fields_set:
        announcement.enabled = bool(payload.enabled)

    db.commit()
    db.refresh(announcement)
    return announcement


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: int, db: Session = Depends(get_db)):
    announcement = db.query(RadioAnnouncement).filter(RadioAnnouncement.id == announcement_id).first()
    if not announcement:
        raise HTTPException(status_code=404, detail="Rappel non trouvé")

    file_path = announcement.file_path
    db.delete(announcement)
    db.commit()

    if file_path and Path(file_path).exists():
        try:
            os.remove(file_path)
        except OSError as e:
            logger.error(f"Suppression de fichier rappel impossible ({file_path}) : {e}")
    return {"message": "Rappel supprimé"}


@router.post("/announcements/play-now")
async def play_announcement_now(payload: PlayNowInput, db: Session = Depends(get_db)):
    """Déclenchement manuel (réf. D11 « manuel ») — toujours en mode « duck »
    (D12 : fondu immédiat, la musique continue). `announcement_id` nul = tirage
    aléatoire parmi les rappels actifs (D13)."""
    from app.radio_manager import get_radio_manager

    query = db.query(RadioAnnouncement).filter(RadioAnnouncement.enabled == True)  # noqa: E712
    announcement = (
        query.filter(RadioAnnouncement.id == payload.announcement_id).first()
        if payload.announcement_id
        else query.order_by(func.random()).first()
    )
    if not announcement:
        raise HTTPException(status_code=404, detail="Aucun rappel disponible")

    await get_radio_manager().play_announcement(
        {"id": announcement.id, "description": announcement.description}, mode="duck",
    )
    log_activity(db, "radio_announcement_played", announcement.description)
    return {"id": announcement.id, "description": announcement.description}


# ---------------------------------------------------------------------------
# Règles de déclenchement (réf. D11-D12)
# ---------------------------------------------------------------------------
@router.get("/announcement-rules", response_model=List[RadioAnnouncementRuleResponse])
def list_rules(db: Session = Depends(get_db)):
    rules = db.query(RadioAnnouncementRule).order_by(RadioAnnouncementRule.created_at.asc()).all()
    return [_rule_response(r) for r in rules]


@router.post("/announcement-rules", response_model=RadioAnnouncementRuleResponse, status_code=201)
def create_rule(payload: RadioAnnouncementRuleInput, db: Session = Depends(get_db)):
    _validate_rule_fields(payload)
    rule = RadioAnnouncementRule(
        rule_type=payload.rule_type,
        n_tracks=payload.n_tracks,
        interval_minutes=payload.interval_minutes,
        times_of_day=json.dumps(payload.times_of_day) if payload.times_of_day else None,
        enabled=payload.enabled,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return _rule_response(rule)


@router.put("/announcement-rules/{rule_id}", response_model=RadioAnnouncementRuleResponse)
def update_rule(rule_id: int, payload: RadioAnnouncementRuleInput, db: Session = Depends(get_db)):
    rule = db.query(RadioAnnouncementRule).filter(RadioAnnouncementRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Règle non trouvée")
    _validate_rule_fields(payload)
    rule.rule_type = payload.rule_type
    rule.n_tracks = payload.n_tracks
    rule.interval_minutes = payload.interval_minutes
    rule.times_of_day = json.dumps(payload.times_of_day) if payload.times_of_day else None
    rule.enabled = payload.enabled
    db.commit()
    db.refresh(rule)
    return _rule_response(rule)


@router.delete("/announcement-rules/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    rule = db.query(RadioAnnouncementRule).filter(RadioAnnouncementRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Règle non trouvée")
    db.delete(rule)
    db.commit()
    return {"message": "Règle supprimée"}
