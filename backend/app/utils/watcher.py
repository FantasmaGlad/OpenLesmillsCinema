import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from app.config import settings
from app.models import ImportSource
from app.utils.importer import import_video, import_background, SUPPORTED_EXTENSIONS, BACKGROUND_SUPPORTED_EXTENSIONS
from app.utils.audio_importer import import_audio_course_from_watched_folder, wait_for_folder_to_stabilize

logger = logging.getLogger(__name__)

# Exécuteur mono-thread PARTAGÉ entre tous les dossiers surveillés (vidéos ET
# fonds animés) pour garantir qu'un seul ffmpeg tourne à la fois, quel que
# soit le dossier d'origine — c'est la contrainte CPU critique du Lot 2 sur
# le Wyse 5070, pas seulement une propriété du watcher vidéo.
executor = ThreadPoolExecutor(max_workers=1)


class _BaseWatchHandler(FileSystemEventHandler):
    """Détecte un fichier stable dans un dossier surveillé et le soumet à
    l'exécuteur d'import partagé. Sous-classé par type de média importé."""

    supported_extensions: set[str] = set()
    kind_label = "fichier"

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

        if path.name.startswith(".") or ext not in self.supported_extensions:
            return

        logger.info(f"Watcher : {self.kind_label} détecté dans le dossier surveillé : {path.name}")
        executor.submit(self._safe_import, str(path))

    def _safe_import(self, file_path: str):
        raise NotImplementedError


class VideoWatchHandler(_BaseWatchHandler):
    supported_extensions = SUPPORTED_EXTENSIONS
    kind_label = "Cours"

    def _safe_import(self, file_path: str):
        path = Path(file_path)
        if not path.exists():
            return
        try:
            logger.info(f"Watcher : Lancement de l'import pour {path.name}")
            import_video(file_path, path.name, ImportSource.watched_folder)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique pour {path.name} : {e}")


class BackgroundWatchHandler(_BaseWatchHandler):
    supported_extensions = BACKGROUND_SUPPORTED_EXTENSIONS
    kind_label = "Fond animé"

    def _safe_import(self, file_path: str):
        path = Path(file_path)
        if not path.exists():
            return
        try:
            logger.info(f"Watcher : Lancement de l'import du fond animé pour {path.name}")
            import_background(file_path, path.name, ImportSource.watched_folder)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique du fond {path.name} : {e}")


class AudioCourseWatchHandler(FileSystemEventHandler):
    """
    Cas particulier (réf. F10.1) : un cours audio est un GROUPE de fichiers,
    pas un fichier unique. Le dossier surveillé attend donc un SOUS-DOSSIER
    (un cours = un sous-dossier nommé d'après le cours, contenant ses MP3),
    pas des fichiers déposés directement à la racine.
    """

    def on_created(self, event):
        if not event.is_directory:
            return
        self._process_folder(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            return
        self._process_folder(event.dest_path)

    def _process_folder(self, dir_path: str):
        path = Path(dir_path)
        if path.name.startswith("."):
            return
        logger.info(f"Watcher : Dossier de cours audio détecté : {path.name}")
        executor.submit(self._safe_import, str(path))

    def _safe_import(self, dir_path: str):
        path = Path(dir_path)
        if not path.exists():
            return
        if not wait_for_folder_to_stabilize(dir_path):
            logger.error(f"Watcher : Le dossier de cours audio {path.name} ne s'est pas stabilisé à temps.")
            return
        try:
            logger.info(f"Watcher : Lancement de l'import du cours audio {path.name}")
            import_audio_course_from_watched_folder(dir_path)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique du cours audio {path.name} : {e}")


_observer = None


def start_watcher():
    global _observer
    _observer = Observer()

    for watch_dir, handler in (
        (settings.watch_dir, VideoWatchHandler()),
        (settings.backgrounds_watch_dir, BackgroundWatchHandler()),
        (settings.audio_watch_dir, AudioCourseWatchHandler()),
    ):
        watch_path = Path(watch_dir)
        watch_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"Watcher : Initialisation sur {watch_path.resolve()}")
        _observer.schedule(handler, str(watch_path), recursive=False)

    _observer.start()


def stop_watcher():
    global _observer
    if _observer:
        logger.info("Watcher : Arrêt de l'observateur...")
        _observer.stop()
        _observer.join()
        _observer = None
    executor.shutdown(wait=False)
