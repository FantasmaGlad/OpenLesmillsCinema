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
from app.models import Video
from app.routers import videos, playback, timer, schedule, playlists
from app.utils.watcher import start_watcher, stop_watcher

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup : Initialisation de la BDD et démarrage du watcher
    init_db()
    start_watcher()
    yield
    # Shutdown : Arrêt propre du watcher
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


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/videos/{video_id}/stream")
def stream_video(
    video_id: int,
    range: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """
    Sert le flux vidéo avec le support HTTP Range (nécessaire pour la lecture directe et le saut dans la timeline).
    """
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Vidéo non trouvée")

    file_path = Path(video.file_path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Fichier vidéo manquant sur le disque")

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
        "Content-Type": "video/mp4",
    }
    return StreamingResponse(
        file_generator(), status_code=206 if range else 200, headers=headers
    )


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
