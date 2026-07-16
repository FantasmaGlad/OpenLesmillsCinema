import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings as runtime_settings
from app.database import get_db
from app.models import Setting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Réglages ajustables depuis l'interface (réf. UX3.17), persistés dans la
# table `settings` (clé/valeur) et reflétés immédiatement dans le singleton
# `runtime_settings` en mémoire — le fichier config.toml reste la valeur de
# secours au tout premier démarrage (avant toute modification via l'UI).
_WRITABLE_NUMERIC_FIELDS = {"countdown_seconds", "wait_time_between_courses", "volume_default", "audio_chain_timer_seconds"}
_WRITABLE_STRING_FIELDS = {"theme", "language"}
_DEFAULTS = {"theme": "les-mills-sombre", "language": "fr"}


class SettingsUpdate(BaseModel):
    countdown_seconds: int | None = None
    wait_time_between_courses: int | None = None
    volume_default: int | None = None
    audio_chain_timer_seconds: int | None = None
    theme: str | None = None
    language: str | None = None


def _get_db_value(db: Session, key: str) -> str | None:
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else None


@router.get("")
def get_settings(db: Session = Depends(get_db)) -> dict[str, Any]:
    theme = _get_db_value(db, "theme") or _DEFAULTS["theme"]
    language = _get_db_value(db, "language") or _DEFAULTS["language"]
    return {
        "countdown_seconds": runtime_settings.countdown_seconds,
        "wait_time_between_courses": runtime_settings.wait_time_between_courses,
        "volume_default": runtime_settings.volume_default,
        "audio_chain_timer_seconds": runtime_settings.audio_chain_timer_seconds,
        "theme": theme,
        "language": language,
        # Chemins en lecture seule (réf. UX3.17 "chemins d'information")
        "paths": {
            "database_url": runtime_settings.database_url,
            "media_dir": runtime_settings.media_dir,
            "watch_dir": runtime_settings.watch_dir,
            "thumbnails_dir": runtime_settings.thumbnails_dir,
            "backgrounds_dir": runtime_settings.backgrounds_dir,
            "backgrounds_watch_dir": runtime_settings.backgrounds_watch_dir,
            "audio_dir": runtime_settings.audio_dir,
            "audio_watch_dir": runtime_settings.audio_watch_dir,
        },
    }


@router.put("")
def update_settings(payload: SettingsUpdate, db: Session = Depends(get_db)) -> dict[str, Any]:
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="Aucun paramètre fourni")

    for key, value in updates.items():
        if key in _WRITABLE_NUMERIC_FIELDS and value is not None:
            if value < 0:
                raise HTTPException(status_code=400, detail=f"{key} doit être positif")
        elif key in _WRITABLE_STRING_FIELDS and value is not None:
            if key == "language" and value not in ("fr", "en"):
                raise HTTPException(status_code=400, detail="Langue invalide (attendu 'fr' ou 'en')")

        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = str(value)
        else:
            db.add(Setting(key=key, value=str(value)))

        # Effet immédiat sur le process en cours pour les champs numériques
        # (le singleton `runtime_settings` est un objet mutable partagé par
        # tout le backend : playback_manager, scheduler_manager, etc. lisent
        # ses attributs directement à chaque usage, pas seulement au démarrage).
        if key in _WRITABLE_NUMERIC_FIELDS:
            setattr(runtime_settings, key, int(value))

    db.commit()
    logger.info(f"Paramètres mis à jour : {updates}")
    return get_settings(db)
