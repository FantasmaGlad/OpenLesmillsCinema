import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from app.config import settings
from app.models import ImportSource
from app.utils.importer import import_video, import_background, SUPPORTED_EXTENSIONS, BACKGROUND_SUPPORTED_EXTENSIONS
from app.utils.audio_importer import import_audio_course_from_watched_folder, wait_for_folder_to_stabilize
from app.utils.executors import ffmpeg_executor as _ffmpeg_executor, io_executor as _io_executor
from app.utils.import_jobs import create_job, update_job

logger = logging.getLogger(__name__)

# _ffmpeg_executor / _io_executor viennent maintenant de app.utils.executors
# (réf. audit plan-corrections-bugs, point 5) : ce module et les routers
# d'upload web partagent désormais le même exécuteur mono-thread ffmpeg,
# plutôt que le watcher en ayant un à lui tout seul pendant que l'upload web
# lançait ffmpeg sans aucune coordination. Ré-exportés sous ces noms pour ne
# pas casser les imports existants (`from app.utils.watcher import ...
# _ffmpeg_executor, _io_executor`, utilisé par les tests).


class _BaseWatchHandler(FileSystemEventHandler):
    """Détecte un fichier stable dans un dossier surveillé et le soumet à
    l'exécuteur d'import de la sous-classe. Sous-classé par type de média importé."""

    supported_extensions: set[str] = set()
    kind_label = "fichier"
    executor: ThreadPoolExecutor = _ffmpeg_executor

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
        self.executor.submit(self._safe_import, str(path))

    def _safe_import(self, file_path: str):
        raise NotImplementedError


class VideoWatchHandler(_BaseWatchHandler):
    supported_extensions = SUPPORTED_EXTENSIONS
    kind_label = "Cours"

    def _safe_import(self, file_path: str):
        path = Path(file_path)
        if not path.exists():
            return
        # Suivi de file (réf. mission "voir en direct les importations") :
        # les imports dossier surveillé passent par le même exécuteur ffmpeg
        # partagé que les uploads web, autant les rendre visibles dans la
        # même file plutôt que de les laisser invisibles à l'admin.
        job_id = create_job("video", path.name, source="watched_folder")
        try:
            logger.info(f"Watcher : Lancement de l'import pour {path.name}")
            video = import_video(file_path, path.name, ImportSource.watched_folder, job_id=job_id)
            update_job(job_id, stage="done", result_id=video.id)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique pour {path.name} : {e}")
            update_job(job_id, stage="error", error=str(e))


class BackgroundWatchHandler(_BaseWatchHandler):
    supported_extensions = BACKGROUND_SUPPORTED_EXTENSIONS
    kind_label = "Fond animé"

    def _safe_import(self, file_path: str):
        path = Path(file_path)
        if not path.exists():
            return
        job_id = create_job("background", path.name, source="watched_folder")
        try:
            logger.info(f"Watcher : Lancement de l'import du fond animé pour {path.name}")
            background = import_background(file_path, path.name, ImportSource.watched_folder, job_id=job_id)
            update_job(job_id, stage="done", result_id=background.id)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique du fond {path.name} : {e}")
            update_job(job_id, stage="error", error=str(e))


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
        # Pas de ffmpeg ici (seulement ffprobe pour la durée, cf. audio_utils) :
        # va sur l'exécuteur I/O plutôt que de faire la queue derrière un
        # import vidéo/fond en cours (réf. Phase 4).
        _io_executor.submit(self._safe_import, str(path))

    def _safe_import(self, dir_path: str):
        path = Path(dir_path)
        if not path.exists():
            return
        if not wait_for_folder_to_stabilize(dir_path):
            logger.error(f"Watcher : Le dossier de cours audio {path.name} ne s'est pas stabilisé à temps.")
            return
        job_id = create_job("audio", path.name, source="watched_folder")
        try:
            logger.info(f"Watcher : Lancement de l'import du cours audio {path.name}")
            course = import_audio_course_from_watched_folder(dir_path, job_id=job_id)
            update_job(job_id, stage="done", result_id=course.id)
        except Exception as e:
            logger.error(f"Watcher : Échec de l'import automatique du cours audio {path.name} : {e}")
            update_job(job_id, stage="error", error=str(e))


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
    # Ne pas fermer les exécuteurs ici car ils sont globaux et réutilisés dans les tests.
    # Python s'occupe de les fermer à la fin du processus.

