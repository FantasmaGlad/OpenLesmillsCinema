import os
import logging
import time
import logging.handlers
from pathlib import Path
from contextlib import asynccontextmanager

import aiofiles
from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import init_db, get_db
from app.models import AudioTrack, Background, Video
from app.playback_manager import get_all_playback_managers
from app.routers import videos, playback, timer, schedule, playlists, backgrounds, audio, audio_playlists, settings as settings_router, logs, canvas, import_jobs
from app.scheduler_manager import (
    start_scheduler,
    start_schedule_sync_listener,
    stop_scheduler,
    stop_schedule_sync_listener,
)
from app.utils.importer import reconcile_orphaned_media
from app.utils.redis_client import close_redis
from app.utils.watcher import start_watcher, stop_watcher
from app.utils.ws_manager import manager as ws_manager

# Log technique (réf. F8.2, Lot 9.6/UX3.18) : mêmes messages que la console
# de dev, en plus écrits dans un fichier consultable/téléchargeable depuis
# l'interface. Rotation par taille (réf. F8.3, tâche 13.3) : 5 Mo x 5 fichiers
# (25 Mo max sur disque) via RotatingFileHandler plutôt que logrotate système —
# autonome (aucune configuration OS à poser au Lot 14), identique en dev et en
# production, cohérent avec le reste de la config applicative centralisée.
# `/api/logs/technical*` (routers/logs.py) ne sert que le fichier courant
# (`technical.log`) ; les archives (`technical.log.1` etc.) restent accessibles
# directement sur le disque pour un diagnostic approfondi si besoin.
settings.technical_log_path.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.handlers.RotatingFileHandler(
            settings.technical_log_path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        ),
    ],
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup : Initialisation de la BDD, démarrage du watcher et du scheduler
    init_db()
    # Avant le watcher (réf. correctif "déplacement de fichier et commit en
    # base pas atomiques") : aucun import n'est possible tant que l'app n'a
    # pas fini de démarrer, donc tout fichier orphelin trouvé ici provient
    # forcément d'un arrêt brutal du service lors d'une exécution précédente.
    reconcile_orphaned_media()
    start_watcher()
    start_scheduler()
    # Bus d'état partagé Redis (réf. plan perf/concurrence Phase 1) : reprise
    # de l'état de lecture publié par un autre worker — POUR CHAQUE CANAL de
    # diffusion (réf. mission "tableaux de bord Câblé / Réseau") — puis
    # abonnement au canal de diffusion inter-workers.
    for playback_manager in get_all_playback_managers().values():
        await playback_manager.sync_from_redis()
    # Réf. correctif "le minuteur n'a aucune persistance Redis, contrairement
    # à PlaybackManager" : même reprise d'état / relance de tick que ci-dessus.
    await timer.timer_manager.sync_from_redis()
    await ws_manager.start_redis_listener()
    # Écouteur du canal minuteur (correctif "0 synchronisation") : jamais
    # démarré auparavant — les évènements minuteur étaient publiés dans Redis
    # mais aucun worker ne les relayait à ses clients WebSocket.
    await timer.timer_ws_manager.start_redis_listener()
    # Écouteur de synchronisation du planning (réf. correctif "la modification
    # d'un planning ne se propage qu'au worker qui a reçu la requête") : même
    # principe que les deux écouteurs ci-dessus, pour que les 4 workers
    # gardent un AsyncIOScheduler à jour après une création/modification/
    # suppression de programmation traitée par n'importe lequel d'entre eux.
    await start_schedule_sync_listener()
    for playback_manager in get_all_playback_managers().values():
        playback_manager.start_position_broadcast_loop()
    yield
    # Shutdown : Arrêt propre du scheduler, du watcher et de Redis
    stop_scheduler()
    stop_watcher()
    for playback_manager in get_all_playback_managers().values():
        playback_manager.stop_position_broadcast_loop()
    await ws_manager.stop_redis_listener()
    await timer.timer_ws_manager.stop_redis_listener()
    await stop_schedule_sync_listener()
    await close_redis()


app = FastAPI(title="OpenLesmillsCinema", lifespan=lifespan)

# Configuration CORS pour le développement
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Enregistrement des routeurs
app.include_router(videos.router)
app.include_router(playback.router)
app.include_router(playlists.router)
app.include_router(timer.router)
app.include_router(schedule.router)
app.include_router(backgrounds.router)
app.include_router(audio.router)
app.include_router(audio_playlists.router)
app.include_router(settings_router.router)
app.include_router(logs.router)
app.include_router(canvas.router)
app.include_router(import_jobs.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/time")
def get_server_time():
    """Retourne l'heure serveur en millisecondes Unix.

    Utilisé par les kiosks clients pour corriger la dérive d'horloge locale :
    le kiosk calcule delta = server_ts - Date.now() et applique ce décalage
    à tous ses affichages de l'heure (réf. correctif horloge TV kiosk).
    La précision réseau LAN (~0.5 ms) est largement suffisante pour un affichage
    à la seconde.
    """
    return {"server_ts": int(time.time() * 1000)}


async def _range_stream_response(file_path: Path, range: str | None, content_type: str) -> StreamingResponse:
    """
    Sert un fichier avec support HTTP Range (nécessaire pour la lecture directe
    et le saut dans la timeline). Partagé par tous les flux média (vidéos,
    fonds animés, pistes audio) : même logique de découpage par octets quel
    que soit le type de contenu.

    Utilise aiofiles pour une lecture disque non-bloquante : le thread de
    l'event loop reste disponible pour les autres requêtes pendant le streaming.
    """
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Fichier manquant sur le disque")

    file_size = file_path.stat().st_size
    start, end = 0, file_size - 1

    if range:
        try:
            # format attendu: "bytes=0-1048576"
            range_str = range.replace("bytes=", "").strip()
            parts = range_str.split("-")
            if parts[0]:
                start = int(parts[0])
            if len(parts) > 1 and parts[1]:
                end = int(parts[1])
        except Exception:
            raise HTTPException(status_code=400, detail="Header de Range invalide")

    # Clamping pour s'assurer que les index restent dans les limites du fichier
    start = max(0, min(start, file_size - 1))
    end = max(start, min(end, file_size - 1))
    chunk_size = end - start + 1

    async def file_generator():
        async with aiofiles.open(file_path, "rb") as f:
            await f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                chunk = await f.read(min(8192 * 16, remaining))  # chunks de 128KB
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
        "Content-Type": content_type,
    }
    return StreamingResponse(
        file_generator(), status_code=206 if range else 200, headers=headers
    )


@app.get("/api/videos/{video_id}/stream")
async def stream_video(
    video_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")
    return await _range_stream_response(Path(video.file_path), range, "video/mp4")


_IMAGE_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


@app.get("/api/backgrounds/{background_id}/stream")
async def stream_background(
    background_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    background = db.query(Background).filter(Background.id == background_id).first()
    if not background:
        raise HTTPException(status_code=404, detail="Fond animé non trouvé")
    suffix = Path(background.file_path).suffix.lower()
    # Fond figé (réf. mission "fond figé ou animé") : servi par le même
    # endpoint de streaming par plage que les vidéos — une image tient
    # largement en une seule plage, aucune adaptation du flux nécessaire.
    if suffix in _IMAGE_CONTENT_TYPES:
        return await _range_stream_response(Path(background.file_path), range, _IMAGE_CONTENT_TYPES[suffix])
    content_type = "video/webm" if suffix == ".webm" else "video/mp4"
    return await _range_stream_response(Path(background.file_path), range, content_type)


@app.get("/api/audio/tracks/{track_id}/stream")
async def stream_audio_track(
    track_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    track = db.query(AudioTrack).filter(AudioTrack.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Piste audio non trouvée")
    return await _range_stream_response(Path(track.file_path), range, "audio/mpeg")


# Montage des dossiers statiques requis
# Miniatures
thumbnails_path = Path(settings.thumbnails_dir)
thumbnails_path.mkdir(parents=True, exist_ok=True)
app.mount("/api/thumbnails", StaticFiles(directory=str(thumbnails_path)), name="thumbnails")

# Assets de l'éditeur de canvas (logos, images de fond importés, Lot 12)
canvas_assets_path = Path(settings.canvas_assets_dir)
canvas_assets_path.mkdir(parents=True, exist_ok=True)
app.mount("/api/canvas_assets", StaticFiles(directory=str(canvas_assets_path)), name="canvas_assets")

# Frontend Next.js statique (si compilé et présent dans out/)
frontend_out = Path(__file__).resolve().parent.parent.parent / "frontend" / "out"
if frontend_out.exists():
    logger.info(f"Montage du frontend statique depuis {frontend_out}")
    app.mount("/", StaticFiles(directory=str(frontend_out), html=True), name="frontend")
else:
    logger.warning("Dossier frontend/out introuvable. Le frontend ne sera pas servi par FastAPI (dev direct).")
