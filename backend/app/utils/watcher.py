import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from app.config import settings
from app.models import ImportSource
from app.utils.importer import import_video, SUPPORTED_EXTENSIONS

logger = logging.getLogger(__name__)

# Exécuteur mono-thread pour traiter les vidéos les unes après les autres
# afin d'éviter de saturer le processeur avec plusieurs ffmpeg simultanés
executor = ThreadPoolExecutor(max_workers=1)


class VideoWatchHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        self._process_file(event.src_path)

    def on_moved(self, event):
        if event.is_directory:
            return
        self._process_file(event.dest_path)

    def _process_file(self, file_path: str):
        path = Path(file_path)
        ext = path.suffix.lower()

        # Ignorer les fichiers masqués/temporaires et les extensions non supportées
        if path.name.startswith(".") or ext not in SUPPORTED_EXTENSIONS:
            return

        logger.info(f"Watcher : Fichier détecté dans le dossier surveillé : {path.name}")
        # Ajouter le fichier à la file d'attente d'importation séquentielle
        executor.submit(self._safe_import, str(path))

    def _safe_import(self, file_path: str):
        path = Path(file_path)
        if not path.exists():
            return
        try:
            logger.info(f"Watcher : Lancement de l'import pour {path.name}")
            import_video(file_path, path.name, ImportSource.watched_folder)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique pour {path.name} : {e}")


_observer = None


def start_watcher():
    global _observer
    watch_path = Path(settings.watch_dir)
    watch_path.mkdir(parents=True, exist_ok=True)

    logger.info(f"Watcher : Initialisation sur {watch_path.resolve()}")

    event_handler = VideoWatchHandler()
    _observer = Observer()
    _observer.schedule(event_handler, str(watch_path), recursive=False)
    _observer.start()


def stop_watcher():
    global _observer
    if _observer:
        logger.info("Watcher : Arrêt de l'observateur...")
        _observer.stop()
        _observer.join()
        _observer = None
    executor.shutdown(wait=False)
