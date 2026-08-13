import asyncio
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings as runtime_settings
from app.database import get_db
from app.models import Setting
from app.playback_manager import get_playback_manager
from app.utils.activity_log import log_activity
from app.utils.ws_manager import manager as ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Noms exacts des unités systemd installées par install.sh (réf. audit
# plan-corrections-bugs, point 4) — à garder synchronisés avec ce fichier.
BACKEND_SERVICE_UNIT = "openlesmillscinema-backend.service"
KIOSK_SERVICE_UNIT = "openlesmillscinema-kiosk.service"

# Réglages ajustables depuis l'interface (réf. UX3.17), persistés dans la
# table `settings` (clé/valeur) et reflétés immédiatement dans le singleton
# `runtime_settings` en mémoire — le fichier config.toml reste la valeur de
# secours au tout premier démarrage (avant toute modification via l'UI).
_WRITABLE_NUMERIC_FIELDS = {"wait_time_between_courses", "volume_default", "audio_chain_timer_seconds"}
_WRITABLE_STRING_FIELDS = {"theme", "language"}
_DEFAULTS = {"theme": "les-mills-sombre", "language": "fr"}
# "les-mills-sombre" est la clé interne historique du thème "Sombre" (réf.
# mission thèmes cinéma) — inchangée pour ne rien casser sur les
# installations existantes, seul son libellé affiché change côté frontend.
_VALID_THEMES = {"les-mills-sombre", "clair", "lune", "menthe", "automne", "hiver", "chili", "ciel", "orchidee", "taupe", "charbon"}

# Sortie affichée par CANAL de diffusion (réf. mission "canaux de diffusion
# précis") : "câblé" (l'écran physiquement connecté au Wyse, en 127.0.0.1) et
# "réseau" (tout autre appareil du LAN qui ouvre /kiosk ou /cinema) sont
# désormais deux réglages INDÉPENDANTS — l'admin peut par exemple laisser le
# câblé en kiosk piloté pendant que le réseau bascule en libre-service
# cinéma, ou l'inverse. "kiosk" par défaut sur les deux canaux. Persisté en
# base sous deux clés distinctes : survit aux redémarrages.
_DISPLAY_OUTPUT_KEYS = {"cable": "display_output_cable", "network": "display_output_network"}
_DISPLAY_OUTPUTS = ("kiosk", "cinema")
_DISPLAY_CHANNELS = ("cable", "network")


class DisplayOutputUpdate(BaseModel):
    channel: str
    output: str


class SettingsUpdate(BaseModel):
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
        "wait_time_between_courses": runtime_settings.wait_time_between_courses,
        "volume_default": runtime_settings.volume_default,
        "audio_chain_timer_seconds": runtime_settings.audio_chain_timer_seconds,
        "theme": theme,
        "language": language,
        # Réglages du duck des rappels radio (réf. lot L6) : consommés par
        # /radio pour le fondu musique pendant une annonce — pas encore
        # éditables à chaud depuis cette API (valeurs de config.toml
        # uniquement pour l'instant, cf. _WRITABLE_NUMERIC_FIELDS).
        "radio_announcement_duck_level": runtime_settings.radio_announcement_duck_level,
        "radio_announcement_fade_ms": runtime_settings.radio_announcement_fade_ms,
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


# Dossiers de médias dont on additionne l'empreinte disque pour l'indicateur
# de stockage (réf. mission "un indicateur de la quantité de stockage restant
# pour monitorer la capacité de l'application") : ce que l'application
# consomme réellement, cours + fonds + audio + vignettes + logs + dossiers
# surveillés. Les chemins sont déjà résolus en absolu par app.config.
_STORAGE_TRACKED_DIRS = (
    "media_dir",
    "watch_dir",
    "thumbnails_dir",
    "backgrounds_dir",
    "backgrounds_watch_dir",
    "audio_dir",
    "audio_watch_dir",
    "radio_dir",
    "radio_covers_dir",
    "radio_announcements_dir",
    "radio_watch_dir",
    "logs_dir",
)


def _dir_size(path: Path) -> int:
    """Taille cumulée d'un dossier (récursif), tolérante aux erreurs d'accès
    et aux liens symboliques (non suivis, pour ne pas compter deux fois ni
    boucler). Renvoie 0 si le dossier n'existe pas encore."""
    total = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                    elif entry.is_dir(follow_symlinks=False):
                        total += _dir_size(Path(entry.path))
                except OSError:
                    continue
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return 0
    return total


@router.get("/storage")
def get_storage() -> dict[str, Any]:
    """
    Indicateur de capacité de stockage (réf. mission "monitorer la capacité de
    l'application") : espace disque du volume qui héberge les médias (total /
    utilisé / libre) et empreinte propre de l'application (somme des dossiers
    de médias). Permet à l'admin de voir combien de cours/fonds/audio il peut
    encore importer avant de saturer le disque du Wyse.
    """
    media_dir = Path(runtime_settings.media_dir)
    # Volume mesuré : le dossier des médias s'il existe, sinon son parent
    # (tout premier démarrage, avant le premier import) — jamais un chemin
    # inexistant qui ferait échouer shutil.disk_usage.
    probe = media_dir
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Impossible de lire l'espace disque : {e}")

    app_bytes = 0
    seen: set[str] = set()
    for attr in _STORAGE_TRACKED_DIRS:
        raw = getattr(runtime_settings, attr, None)
        if not raw:
            continue
        # Dédoublonnage : plusieurs réglages peuvent pointer le même dossier
        # (ou un sous-dossier) — on ne compte chaque chemin racine qu'une fois.
        resolved = str(Path(raw))
        if resolved in seen:
            continue
        seen.add(resolved)
        app_bytes += _dir_size(Path(raw))

    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "used_percent": round(usage.used / usage.total * 100, 1) if usage.total else 0.0,
        "app_bytes": app_bytes,
        "path": str(probe),
    }


@router.put("")
async def update_settings(payload: SettingsUpdate, db: Session = Depends(get_db)) -> dict[str, Any]:
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
            if key == "theme" and value not in _VALID_THEMES:
                raise HTTPException(status_code=400, detail=f"Thème invalide (attendu l'un de : {', '.join(sorted(_VALID_THEMES))})")

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
    result = get_settings(db)

    # Diffusion temps réel (correctif "thème ne se synchronise pas sur
    # l'écran cinéma") : AppSettingsProvider ne chargeait le thème/langue
    # qu'une fois au montage — un changement décidé depuis l'admin pendant
    # que /cinema ou un autre écran était déjà ouvert n'y apparaissait donc
    # jamais sans rechargement manuel. Diffusé uniquement si l'un des deux a
    # effectivement changé, pour ne pas générer de trafic WebSocket inutile
    # à chaque réglage numérique (countdown, volume...).
    if "theme" in updates or "language" in updates:
        await ws_manager.broadcast({
            "event": "settings_change",
            "theme": result["theme"],
            "language": result["language"],
        })

    return result


def get_display_output_value(db: Session, channel: str = "cable") -> str:
    """Valeur de sortie active pour un canal, réutilisable hors endpoint
    (réf. verrouillage cinéma dans routers/playback.py)."""
    value = _get_db_value(db, _DISPLAY_OUTPUT_KEYS[channel])
    return value if value in _DISPLAY_OUTPUTS else "kiosk"


@router.get("/display-output")
def get_display_output(db: Session = Depends(get_db)) -> dict[str, str]:
    """Sortie active des deux canaux : câblé (écran du Wyse) et réseau (tout
    autre appareil du LAN)."""
    return {
        "cable": get_display_output_value(db, "cable"),
        "network": get_display_output_value(db, "network"),
    }


@router.put("/display-output")
async def set_display_output(payload: DisplayOutputUpdate, db: Session = Depends(get_db)) -> dict[str, str]:
    """
    Bascule un canal (câblé ou réseau) entre kiosk et cinéma, indépendamment
    de l'autre. L'application est instantanée : l'évènement est diffusé à
    tous les clients WebSocket, et la page concernée (l'écran câblé pour le
    canal "cable", tout autre /kiosk ou /cinema du réseau pour "network")
    navigue d'elle-même vers l'autre page en le recevant.
    """
    if payload.channel not in _DISPLAY_CHANNELS:
        raise HTTPException(status_code=400, detail="Canal invalide (attendu 'cable' ou 'network')")
    if payload.output not in _DISPLAY_OUTPUTS:
        raise HTTPException(status_code=400, detail="Sortie invalide (attendu 'kiosk' ou 'cinema')")

    key = _DISPLAY_OUTPUT_KEYS[payload.channel]
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = payload.output
    else:
        db.add(Setting(key=key, value=payload.output))
    db.commit()

    # Bascule vers cinéma : coupe ce qui jouait côté kiosk sur CE canal plutôt
    # que de le laisser tourner en arrière-plan sans écran pour l'afficher —
    # sans ça l'état serveur restait "en cours" (position qui continue
    # d'avancer, "En direct" affiché côté admin) et pouvait reprendre en
    # l'état si on rebasculait sur kiosk plus tard, en conflit avec ce que
    # l'utilisateur regarde alors en cinéma (réf. retour utilisateur
    # "couper et retirer la vidéo qui se jouait sur le kiosk").
    if payload.output == "cinema":
        manager = get_playback_manager(payload.channel)
        current = manager.snapshot()
        if current["current_video"] or current["current_background"] or current["current_audio_course"]:
            title = (
                (current["current_video"] or {}).get("title")
                or (current["current_background"] or {}).get("title")
                or (current["current_audio_course"] or {}).get("title")
            )
            log_activity(db, "playback_stopped", title)
        await manager.stop()

    await ws_manager.broadcast({"event": "display_output", "channel": payload.channel, "output": payload.output})
    logger.info(f"Sortie {payload.channel} basculée sur /{payload.output}")
    return {
        "cable": get_display_output_value(db, "cable"),
        "network": get_display_output_value(db, "network"),
    }


async def _run_full_reset():
    """
    Diffuse un rechargement à tous les navigateurs connectés (PC/mobile/coach)
    puis redémarre le service kiosk (relance Chromium) et enfin le service
    backend (réf. audit plan-corrections-bugs, point 4 — bouton de
    réinitialisation complète). Exécuté en tâche de fond APRÈS l'envoi de la
    réponse HTTP : le redémarrage du backend termine le processus courant, il
    ne peut donc pas avoir lieu pendant le traitement de la requête elle-même.

    Hors de l'environnement cible (règle sudoers/unités systemd installées par
    install.sh absentes, ex. poste de dev), les appels `systemctl` échouent
    proprement et sont juste loggés — seule la diffusion `force_reload` a un
    effet observable en dev.
    """
    try:
        await ws_manager.broadcast_force_reload()
    except Exception as e:
        logger.warning(f"Échec de la diffusion force_reload : {e}")

    # Laisse le temps au message de partir avant de couper les connexions.
    await asyncio.sleep(1.0)

    for unit in (KIOSK_SERVICE_UNIT, BACKEND_SERVICE_UNIT):
        try:
            subprocess.run(["sudo", "systemctl", "restart", unit], check=True, timeout=15)
            logger.info(f"Service {unit} redémarré (réinitialisation complète)")
        except Exception as e:
            logger.error(f"Échec du redémarrage de {unit} (hors environnement cible ?) : {e}")


@router.post("/system/reset")
async def reset_system(background_tasks: BackgroundTasks) -> dict[str, str]:
    """
    Réinitialisation complète (réf. audit plan-corrections-bugs, point 4) :
    force le rechargement de tous les écrans connectés puis redémarre le
    kiosk et le backend. Action volontairement lourde/perturbatrice — le
    bouton correspondant côté UI doit demander confirmation avant d'appeler
    cet endpoint.
    """
    background_tasks.add_task(_run_full_reset)
    return {"message": "Réinitialisation en cours : tous les écrans vont se recharger."}


# ---------------------------------------------------------------------------
# Désinstallation complète (bouton « Désinstaller » — remise à zéro machine)
# ---------------------------------------------------------------------------
UNINSTALL_WRAPPER = Path("/usr/local/sbin/openlesmillscinema-uninstall")
SUDOERS_FILE = Path("/etc/sudoers.d/openlesmillscinema")


class UninstallRequest(BaseModel):
    confirm: str


async def _run_uninstall():
    """Laisse la réponse HTTP partir, puis déclenche l'enveloppe de
    désinstallation en root (règle sudoers dédiée posée par install.sh).
    L'enveloppe détache l'opération via systemd-run : le backend sera arrêté
    pendant la remise à zéro, mais l'unité transitoire lui survit."""
    await asyncio.sleep(1.0)
    try:
        subprocess.Popen(["sudo", str(UNINSTALL_WRAPPER)], start_new_session=True)
        logger.info("Désinstallation déclenchée (enveloppe systemd-run détachée).")
    except Exception as e:
        logger.error(f"Échec du lancement de la désinstallation : {e}")


@router.post("/system/uninstall")
async def uninstall_system(payload: UninstallRequest, background_tasks: BackgroundTasks) -> dict[str, str]:
    """Remise à zéro complète de la machine (réf. bouton « Désinstaller ») :
    services systemd + config /etc + application + venv + TOUTES les données,
    via l'enveloppe /usr/local/sbin/openlesmillscinema-uninstall (appelée en
    root sans mot de passe grâce à la règle sudoers dédiée). Les paquets apt
    partagés ne sont PAS retirés. Action IRRÉVERSIBLE — l'UI exige une phrase
    de confirmation avant cet appel.

    Hors d'une installation cible (enveloppe/sudoers absents, ex. poste de
    dev), renvoie 400 avec la marche à suivre manuelle plutôt que d'échouer
    silencieusement."""
    phrase = payload.confirm.strip().upper().replace("É", "E")
    if phrase != "DESINSTALLER":
        raise HTTPException(status_code=400, detail="Phrase de confirmation incorrecte.")
    if not UNINSTALL_WRAPPER.exists() or not SUDOERS_FILE.exists():
        raise HTTPException(
            status_code=400,
            detail=(
                "Cette machine n'est pas une installation gérée (désinstalleur système absent). "
                "Depuis un poste de dev, lancez à la main : sudo ./install.sh --uninstall --purge --purge-data"
            ),
        )
    background_tasks.add_task(_run_uninstall)
    return {"message": "Désinstallation lancée : la machine se remet à zéro, le service va s'arrêter et l'interface deviendra injoignable."}
