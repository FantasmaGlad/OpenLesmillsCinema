import logging
import uuid
from pathlib import Path
from typing import Any, List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import CanvasLayout, CanvasLayoutType
from app.utils.activity_log import log_activity
from app.utils.canvas_defaults import DEFAULTS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/canvas", tags=["canvas"])

# Types d'éléments reconnus par l'éditeur et le rendu kiosk (réf. UX2.2/12.4) :
# logo importable, texte libre, horloge, bloc prochain cours, compte à
# rebours (temps restant, sans le nom), minuteur/chrono (réutilise le moteur
# du Lot 4), image de fond, fond animé.
ALLOWED_ELEMENT_TYPES = {
    "logo",
    "text",
    "clock",
    "next_course",
    "countdown",
    "timer",
    "background_image",
    "background_video",
}
ALLOWED_LAYOUT_TYPES = {t.value for t in CanvasLayoutType}
ALLOWED_ASSET_EXTENSIONS = {".png", ".svg", ".jpg", ".jpeg", ".webp"}


def _validate_definition(definition: dict) -> dict:
    if not isinstance(definition, dict) or not isinstance(definition.get("elements"), list):
        raise HTTPException(status_code=400, detail="Définition de composition invalide (attendu: {elements: [...]})")
    cleaned_elements = []
    for el in definition["elements"]:
        if not isinstance(el, dict):
            raise HTTPException(status_code=400, detail="Élément de composition invalide")
        el_type = el.get("type")
        if el_type not in ALLOWED_ELEMENT_TYPES:
            raise HTTPException(status_code=400, detail=f"Type d'élément inconnu: {el_type}")
        try:
            x, y = float(el.get("x", 0)), float(el.get("y", 0))
            width, height = float(el.get("width", 10)), float(el.get("height", 10))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Position/taille d'élément invalide")
        cleaned_elements.append({
            "id": el.get("id") or str(uuid.uuid4()),
            "type": el_type,
            "x": max(0.0, min(100.0, x)),
            "y": max(0.0, min(100.0, y)),
            "width": max(1.0, min(100.0, width)),
            "height": max(1.0, min(100.0, height)),
            "color": el.get("color"),
            "content": el.get("content"),
            "font_size": el.get("font_size"),
            "visible": bool(el.get("visible", True)),
            "z_index": int(el.get("z_index", 1)),
        })
    return {"elements": cleaned_elements}


class CanvasLayoutCreate(BaseModel):
    type: str
    name: str

    @field_validator("type")
    @classmethod
    def check_type(cls, v: str) -> str:
        if v not in ALLOWED_LAYOUT_TYPES:
            raise ValueError(f"Type de composition invalide (attendu: {ALLOWED_LAYOUT_TYPES})")
        return v


class CanvasLayoutUpdate(BaseModel):
    name: str | None = None
    definition: dict[str, Any] | None = None


class CanvasLayoutResponse(BaseModel):
    id: int
    type: str
    name: str
    definition: dict[str, Any]
    active: bool

    class Config:
        from_attributes = True


@router.get("/layouts", response_model=List[CanvasLayoutResponse])
def list_layouts(type: str | None = None, db: Session = Depends(get_db)):
    query = db.query(CanvasLayout)
    if type:
        query = query.filter(CanvasLayout.type == type)
    return query.order_by(CanvasLayout.id).all()


@router.get("/layouts/{layout_id}", response_model=CanvasLayoutResponse)
def get_layout(layout_id: int, db: Session = Depends(get_db)):
    layout = db.query(CanvasLayout).filter(CanvasLayout.id == layout_id).first()
    if not layout:
        raise HTTPException(status_code=404, detail="Composition non trouvée")
    return layout


@router.get("/active/{type}", response_model=CanvasLayoutResponse)
def get_active_layout(type: str, db: Session = Depends(get_db)):
    """Lu par le kiosk (Lot 12.2) : composition active pour ce type. Endpoint
    public au même titre que le reste de l'API (pas d'authentification, F6.3)."""
    if type not in ALLOWED_LAYOUT_TYPES:
        raise HTTPException(status_code=400, detail="Type de composition invalide")
    layout = db.query(CanvasLayout).filter(CanvasLayout.type == type, CanvasLayout.active == True).first()  # noqa: E712
    if not layout:
        raise HTTPException(status_code=404, detail="Aucune composition active pour ce type")
    return layout


@router.post("/layouts", response_model=CanvasLayoutResponse)
def create_layout(payload: CanvasLayoutCreate, db: Session = Depends(get_db)):
    """Nouvelle composition vide (réf. 12.6 « compositions multiples enregistrables »),
    jamais active à la création — l'admin doit l'appliquer explicitement à l'écran."""
    layout = CanvasLayout(
        type=payload.type,
        name=payload.name.strip() or "Sans titre",
        definition={"elements": []},
        active=False,
    )
    db.add(layout)
    log_activity(db, "canvas_created", f"{layout.type}: {layout.name}")
    db.commit()
    db.refresh(layout)
    return layout


@router.put("/layouts/{layout_id}", response_model=CanvasLayoutResponse)
def update_layout(layout_id: int, payload: CanvasLayoutUpdate, db: Session = Depends(get_db)):
    layout = db.query(CanvasLayout).filter(CanvasLayout.id == layout_id).first()
    if not layout:
        raise HTTPException(status_code=404, detail="Composition non trouvée")
    if payload.name is not None and payload.name.strip():
        layout.name = payload.name.strip()
    if payload.definition is not None:
        layout.definition = _validate_definition(payload.definition)
    log_activity(db, "canvas_updated", f"{layout.type}: {layout.name}")
    db.commit()
    db.refresh(layout)
    return layout


@router.post("/layouts/{layout_id}/activate", response_model=CanvasLayoutResponse)
def activate_layout(layout_id: int, db: Session = Depends(get_db)):
    """« Appliquer à l'écran » (réf. 12.5/12.6) : le kiosk reprend cette
    composition au prochain sondage (poll ~10s, pas de canal temps réel dédié
    — une bascule d'habillage administrative n'a pas la contrainte <500ms
    de NF4, réservée aux commandes de lecture)."""
    layout = db.query(CanvasLayout).filter(CanvasLayout.id == layout_id).first()
    if not layout:
        raise HTTPException(status_code=404, detail="Composition non trouvée")
    db.query(CanvasLayout).filter(CanvasLayout.type == layout.type, CanvasLayout.id != layout.id).update(
        {"active": False}
    )
    layout.active = True
    log_activity(db, "canvas_activated", f"{layout.type}: {layout.name}")
    db.commit()
    db.refresh(layout)
    return layout


@router.post("/layouts/{layout_id}/reset", response_model=CanvasLayoutResponse)
def reset_layout(layout_id: int, db: Session = Depends(get_db)):
    """« Réinitialiser au défaut » (réf. 12.5) : remet la définition de CETTE
    composition à l'habillage standard (nom et statut actif inchangés)."""
    layout = db.query(CanvasLayout).filter(CanvasLayout.id == layout_id).first()
    if not layout:
        raise HTTPException(status_code=404, detail="Composition non trouvée")
    layout.definition = DEFAULTS[layout.type]()
    log_activity(db, "canvas_reset", f"{layout.type}: {layout.name}")
    db.commit()
    db.refresh(layout)
    return layout


@router.delete("/layouts/{layout_id}")
def delete_layout(layout_id: int, db: Session = Depends(get_db)):
    layout = db.query(CanvasLayout).filter(CanvasLayout.id == layout_id).first()
    if not layout:
        raise HTTPException(status_code=404, detail="Composition non trouvée")
    if layout.active:
        raise HTTPException(
            status_code=400,
            detail="Impossible de supprimer la composition active : appliquez-en une autre à l'écran d'abord",
        )
    siblings = db.query(CanvasLayout).filter(CanvasLayout.type == layout.type).count()
    if siblings <= 1:
        raise HTTPException(status_code=400, detail="Impossible de supprimer la dernière composition de ce type")
    log_activity(db, "canvas_deleted", f"{layout.type}: {layout.name}")
    db.delete(layout)
    db.commit()
    return {"message": "Composition supprimée avec succès"}


@router.post("/assets")
async def upload_asset(file: UploadFile = File(...)):
    """Upload d'un logo (PNG/SVG) ou d'une image de fond pour l'éditeur (réf. 12.4)."""
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_ASSET_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Format non supporté (attendu: {ALLOWED_ASSET_EXTENSIONS})")

    assets_dir = Path(settings.canvas_assets_dir)
    assets_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{suffix}"
    dest = assets_dir / filename
    try:
        contents = await file.read()
        with open(dest, "wb") as f:
            f.write(contents)
    except Exception as e:
        logger.error(f"Échec de l'upload d'asset canvas: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Échec de l'enregistrement du fichier")

    return {"url": f"/api/canvas_assets/{filename}"}
