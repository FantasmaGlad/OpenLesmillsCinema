import os
import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import init_db, get_db
from app.models import AudioTrack, Background, Video
from app.routers import videos, playback, timer, schedule, playlists, backgrounds, audio, settings as settings_router, logs
from app.scheduler_manager import start_scheduler, stop_scheduler
from app.utils.watcher import start_watcher, stop_watcher

# Log technique (réf. F8.2, Lot 9.6/UX3.18) : mêmes messages que la console
# de dev, en plus écrits dans un fichier consultable/téléchargeable depuis
# l'interface. La rotation (F8.3) est un sujet dédié du Lot 13, pas traité ici.
settings.technical_log_path.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(settings.technical_log_path, encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup : Initialisation de la BDD, démarrage du watcher et du scheduler
    init_db()
    start_watcher()
    start_scheduler()
    yield
    # Shutdown : Arrêt propre du scheduler et du watcher
    stop_scheduler()
    stop_watcher()


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
app.include_router(settings_router.router)
app.include_router(logs.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


def _range_stream_response(file_path: Path, range: str | None, content_type: str) -> StreamingResponse:
    """
    Sert un fichier avec support HTTP Range (nécessaire pour la lecture directe
    et le saut dans la timeline). Partagé par tous les flux média (vidéos,
    fonds animés, pistes audio) : même logique de découpage par octets quel
    que soit le type de contenu.
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

    def file_generator():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                chunk = f.read(min(8192 * 16, remaining))  # chunks de 128KB
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
def stream_video(
    video_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")
    return _range_stream_response(Path(video.file_path), range, "video/mp4")


@app.get("/api/backgrounds/{background_id}/stream")
def stream_background(
    background_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    background = db.query(Background).filter(Background.id == background_id).first()
    if not background:
        raise HTTPException(status_code=404, detail="Fond animé non trouvé")
    content_type = "video/webm" if background.file_path.lower().endswith(".webm") else "video/mp4"
    return _range_stream_response(Path(background.file_path), range, content_type)


@app.get("/api/audio/tracks/{track_id}/stream")
def stream_audio_track(
    track_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    track = db.query(AudioTrack).filter(AudioTrack.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Piste audio non trouvée")
    return _range_stream_response(Path(track.file_path), range, "audio/mpeg")


# Montage des dossiers statiques requis
# Miniatures
thumbnails_path = Path(settings.thumbnails_dir)
thumbnails_path.mkdir(parents=True, exist_ok=True)
app.mount("/api/thumbnails", StaticFiles(directory=str(thumbnails_path)), name="thumbnails")

# Frontend Next.js statique (si compilé et présent dans out/)
frontend_out = Path(__file__).resolve().parent.parent.parent / "frontend" / "out"
if frontend_out.exists():
    logger.info(f"Montage du frontend statique depuis {frontend_out}")
    app.mount("/", StaticFiles(directory=str(frontend_out), html=True), name="frontend")
else:
    logger.warning("Dossier frontend/out introuvable. Le frontend ne sera pas servi par FastAPI (dev direct).")
