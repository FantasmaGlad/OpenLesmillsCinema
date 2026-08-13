import os
import sys
import shutil
import zipfile
import unittest
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ["BOBINE_DATABASE_URL"] = "sqlite:///data/test_audio_database.db"
os.environ["BOBINE_AUDIO_DIR"] = "data/test_audio"
os.environ["BOBINE_AUDIO_WATCH_DIR"] = "data/test_audio_watched"

from app.config import settings
from app.database import init_db, SessionLocal
from app.models import AudioCourse, AudioTrack, PlaybackState, Playlist, PlaylistItem, Schedule, ScheduleTargetType, ScheduleType, Video, ImportSource
from app.utils.audio_utils import parse_track_number_and_title
from app.utils.audio_importer import (
    import_audio_course_from_files,
    import_audio_course_from_zip,
    import_audio_course_from_watched_folder,
)
from app.playback_manager import PlaybackManager
from app.scheduler_manager import fire_schedule, sync_schedule_job


def _make_mp3(path: str, duration: float = 1.0):
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"sine=frequency=1000:duration={duration}",
        "-c:a", "libmp3lame",
        path,
    ]
    subprocess.run(cmd, capture_output=True, check=True)


class TestAudioFlow(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        Path(settings.audio_dir).mkdir(parents=True, exist_ok=True)
        Path(settings.audio_watch_dir).mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        from app.database import engine
        engine.dispose()
        db_path = Path(settings.database_url.replace("sqlite:///", ""))
        if db_path.exists():
            try:
                db_path.unlink()
            except PermissionError:
                pass
        for d in [settings.audio_dir, settings.audio_watch_dir]:
            p = Path(d)
            if p.exists():
                shutil.rmtree(p)

    def setUp(self):
        init_db()
        self.db = SessionLocal()
        self.scratch = Path(settings.audio_watch_dir) / "_scratch"
        self.scratch.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.db.query(PlaybackState).delete()
        self.db.query(AudioTrack).delete()
        self.db.query(AudioCourse).delete()
        self.db.query(PlaylistItem).delete()
        self.db.query(Playlist).delete()
        self.db.query(Video).delete()
        self.db.query(Schedule).delete()
        self.db.commit()
        self.db.close()
        if self.scratch.exists():
            shutil.rmtree(self.scratch, ignore_errors=True)

    def test_01_parse_track_number_and_title(self):
        self.assertEqual(parse_track_number_and_title("01 - Warm Up.mp3"), (1, "Warm Up"))
        self.assertEqual(parse_track_number_and_title("2. Climb.mp3"), (2, "Climb"))
        self.assertEqual(parse_track_number_and_title("Track 05 Sprint.mp3"), (5, "Sprint"))
        self.assertEqual(parse_track_number_and_title("09_Stretching.mp3"), (9, "Stretching"))
        number, title = parse_track_number_and_title("Cooldown.mp3")
        self.assertIsNone(number)
        self.assertEqual(title, "Cooldown")

    def test_02_import_from_files_ordering_and_metadata(self):
        _make_mp3(str(self.scratch / "02 - Climb.mp3"))
        _make_mp3(str(self.scratch / "01 - Warm Up.mp3"))
        _make_mp3(str(self.scratch / "03 - Sprint.mp3"))

        paths = [str(self.scratch / n) for n in ("02 - Climb.mp3", "01 - Warm Up.mp3", "03 - Sprint.mp3")]
        course = import_audio_course_from_files(paths, "RPM 110", program="RPM", release="110")

        self.assertEqual(course.title, "RPM 110")
        self.assertEqual(course.program, "RPM")
        self.assertEqual(len(course.tracks), 3)
        ordered = sorted(course.tracks, key=lambda t: t.position)
        self.assertEqual([t.title for t in ordered], ["Warm Up", "Climb", "Sprint"])
        self.assertEqual([t.number for t in ordered], [1, 2, 3])
        for t in ordered:
            self.assertIsNotNone(t.duration_seconds)
            self.assertTrue(os.path.exists(t.file_path))

    def test_03_import_from_zip(self):
        zip_dir = self.scratch / "zip_src"
        zip_dir.mkdir()
        _make_mp3(str(zip_dir / "01 - Intro.mp3"))
        _make_mp3(str(zip_dir / "02 - Outro.mp3"))

        zip_path = str(self.scratch / "RPM_111.zip")
        with zipfile.ZipFile(zip_path, "w") as zf:
            for f in zip_dir.iterdir():
                zf.write(f, arcname=f.name)

        course = import_audio_course_from_zip(zip_path, "RPM 111")
        self.assertEqual(len(course.tracks), 2)
        self.assertFalse(Path(zip_path).exists())  # nettoyé après extraction

    def test_04_import_from_watched_folder_uses_dirname_as_title(self):
        course_dir = Path(settings.audio_watch_dir) / "Sprint 40"
        course_dir.mkdir()
        _make_mp3(str(course_dir / "01 - Track A.mp3"))
        _make_mp3(str(course_dir / "02 - Track B.mp3"))

        course = import_audio_course_from_watched_folder(str(course_dir))
        self.assertEqual(course.title, "Sprint 40")
        self.assertEqual(len(course.tracks), 2)
        self.assertFalse(course_dir.exists())  # dossier source nettoyé après import

    async def test_05_coach_mode_playback_manager_flow(self):
        broadcast_payloads = []

        async def mock_broadcast(data):
            broadcast_payloads.append(data)

        manager = PlaybackManager(mock_broadcast)
        tracks = [
            {"id": 1, "number": 1, "title": "Warm Up", "duration_seconds": 300.0},
            {"id": 2, "number": 2, "title": "Climb", "duration_seconds": 400.0},
            {"id": 3, "number": 3, "title": "Sprint", "duration_seconds": 350.0},
        ]

        # Lancement en 2 taps : le choix du cours suffit à démarrer la lecture (réf. F10.4)
        await manager.load_audio_course(1, "RPM 110", "RPM", None, tracks)
        self.assertEqual(manager.state["state"], "coach_mode")
        self.assertTrue(manager.state["audio_playing"])
        self.assertEqual(manager.state["audio_track_index"], 0)

        # play/pause pilotent la piste audio en mode coach (même bouton que la vidéo, réf. UX5.1)
        await manager.pause()
        self.assertFalse(manager.state["audio_playing"])
        await manager.play()
        self.assertTrue(manager.state["audio_playing"])

        # Navigation suivant/précédent
        await manager.audio_next_track()
        self.assertEqual(manager.state["audio_track_index"], 1)
        self.assertEqual(manager.state["audio_position_seconds"], 0.0)
        await manager.audio_previous_track()
        self.assertEqual(manager.state["audio_track_index"], 0)

        # Relancer la piste au début (réf. UX4.6)
        manager.state["audio_position_seconds"] = 120.0
        await manager.audio_restart_track()
        self.assertEqual(manager.state["audio_position_seconds"], 0.0)
        self.assertTrue(manager.state["audio_playing"])

        # Saut direct à une piste (bottom sheet, réf. UX4.7)
        await manager.audio_jump_to_track(2)
        self.assertEqual(manager.state["audio_track_index"], 2)

        # Mode manuel : la piste s'arrête à sa fin, pas d'enchaînement automatique
        await manager.audio_set_chain_mode("manual")
        await manager.audio_track_ended()
        self.assertFalse(manager.state["audio_playing"])
        self.assertEqual(manager.state["audio_track_index"], 2)  # reste sur la dernière piste

        # Mode auto : enchaînement immédiat
        await manager.audio_jump_to_track(0)
        await manager.audio_set_chain_mode("auto")
        await manager.audio_track_ended()
        self.assertEqual(manager.state["audio_track_index"], 1)
        self.assertTrue(manager.state["audio_playing"])

        # Fin du cours en mode auto (dernière piste) : reste affiché, en pause
        await manager.audio_jump_to_track(2)
        await manager.audio_track_ended()
        self.assertFalse(manager.state["audio_playing"])
        self.assertIsNotNone(manager.state["current_audio_course"])  # mode coach toujours actif

        # Une vidéo classique doit pouvoir prendre le relais sur le mode coach (action manuelle, pas une programmation)
        await manager.load(video_id=99, title="RPM 100", duration_seconds=2700.0)
        self.assertIsNone(manager.state["current_audio_course"])
        # Bascule directe en lecture (plus de compte à rebours serveur, réf.
        # refactor "retrait du minuteur autonome").
        self.assertEqual(manager.state["state"], "playing")

    async def test_06_priority_rule_f10_7_defers_schedule_during_coach_mode(self):
        # Vidéo cible d'une programmation qui va se déclencher pendant le mode coach
        video = Video(
            file_path="data/test_audio_videos/rpm.mp4",
            title="RPM 100",
            program="RPM",
            duration_seconds=2700.0,
            source=ImportSource.upload,
        )
        self.db.add(video)
        self.db.commit()

        schedule = Schedule(
            target_type=ScheduleTargetType.video,
            target_id=video.id,
            schedule_type=ScheduleType.once,
            run_at=None,
            active=True,
        )
        self.db.add(schedule)
        self.db.commit()

        broadcast_payloads = []

        async def mock_broadcast(data):
            broadcast_payloads.append(data)

        from app import playback_manager as playback_manager_module
        playback_manager_module.init_playback_managers(mock_broadcast)
        manager = playback_manager_module.get_playback_manager()

        tracks = [{"id": 1, "number": 1, "title": "Warm Up", "duration_seconds": 300.0}]
        await manager.load_audio_course(1, "RPM 110", "RPM", None, tracks)
        self.assertEqual(manager.state["state"], "coach_mode")

        # Déclenchement direct de la programmation (simule l'heure H sans attendre APScheduler)
        await fire_schedule(schedule.id)

        # Le mode coach ne doit PAS avoir été interrompu (réf. F10.7)
        self.assertEqual(manager.state["state"], "coach_mode")
        self.assertEqual(manager.state["current_audio_course"]["id"], 1)

        # La programmation doit être mémorisée comme "reportée", relançable depuis l'UI
        pending = self.db.query(PlaybackState).order_by(PlaybackState.id.desc()).first()
        self.assertIsNotNone(pending)
        self.assertEqual(pending.cause, "coach_priority")
        self.assertEqual(pending.target_type, "video")
        self.assertEqual(pending.target_id, video.id)

        # La programmation ponctuelle passée doit tout de même se désactiver (comportement F5.1 existant)
        self.db.refresh(schedule)
        self.assertFalse(schedule.active)


if __name__ == "__main__":
    unittest.main()
