import os
import sys
import shutil
import unittest
import subprocess
from pathlib import Path

# Add backend directory to Python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Set test directories before importing config
os.environ["BOBINE_DATABASE_URL"] = "sqlite:///data/test_background_database.db"
os.environ["BOBINE_BACKGROUNDS_DIR"] = "data/test_backgrounds"
os.environ["BOBINE_BACKGROUNDS_WATCH_DIR"] = "data/test_backgrounds_watched"
os.environ["BOBINE_THUMBNAILS_DIR"] = "data/test_background_thumbnails"

from app.config import settings
from app.database import init_db, SessionLocal
from app.models import Background, ImportSource
from app.utils.importer import import_background
from app.playback_manager import PlaybackManager


class TestBackgroundFlow(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        Path(settings.backgrounds_dir).mkdir(parents=True, exist_ok=True)
        Path(settings.backgrounds_watch_dir).mkdir(parents=True, exist_ok=True)
        Path(settings.thumbnails_dir).mkdir(parents=True, exist_ok=True)

        cls.dummy_mp4_path = str(Path(settings.backgrounds_watch_dir) / "test_ambience.mp4")
        cls.dummy_mkv_path = str(Path(settings.backgrounds_watch_dir) / "test_ambience_mkv.mkv")

        cmd_mp4 = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
            cls.dummy_mp4_path,
        ]
        subprocess.run(cmd_mp4, capture_output=True, check=True)

        cmd_mkv = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
            cls.dummy_mkv_path,
        ]
        subprocess.run(cmd_mkv, capture_output=True, check=True)

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

        for d in [settings.backgrounds_dir, settings.backgrounds_watch_dir, settings.thumbnails_dir]:
            p = Path(d)
            if p.exists():
                shutil.rmtree(p)

    def setUp(self):
        init_db()
        self.db = SessionLocal()

    def tearDown(self):
        self.db.query(Background).delete()
        self.db.commit()
        self.db.close()

    def test_01_import_background_direct_play(self):
        temp_src = str(Path(settings.backgrounds_watch_dir) / "temp_ambience_import.mp4")
        shutil.copy(self.dummy_mp4_path, temp_src)

        bg = import_background(temp_src, "Ambience Loop.mp4", ImportSource.upload)
        self.assertIsNotNone(bg.id)
        self.assertEqual(bg.title, "Ambience Loop")
        self.assertTrue(os.path.exists(bg.file_path))
        self.assertTrue(os.path.exists(bg.thumbnail_path))
        self.assertTrue(bg.file_path.endswith(".mp4"))

    def test_02_import_background_mkv_normalized_to_mp4(self):
        temp_src = str(Path(settings.backgrounds_watch_dir) / "temp_ambience_mkv.mkv")
        shutil.copy(self.dummy_mkv_path, temp_src)

        bg = import_background(temp_src, "Ambience MKV.mkv", ImportSource.watched_folder)
        self.assertIsNotNone(bg.id)
        # Un conteneur MKV mal supporté doit être remuxé en MP4 (même règle que les cours, réf. F9.1/F3.5)
        self.assertTrue(bg.file_path.endswith(".mp4"))
        self.assertTrue(os.path.exists(bg.file_path))

    async def test_03_playback_manager_background_flow(self):
        broadcast_payloads = []

        async def mock_broadcast(data):
            broadcast_payloads.append(data)

        manager = PlaybackManager(mock_broadcast)

        # Lancer un fond animé : bascule immédiate, sans compte à rebours (réf. F9.2)
        await manager.load_background(1, "Ambience Loop")
        self.assertEqual(manager.state["state"], "background")
        self.assertEqual(manager.state["current_background"], {"id": 1, "title": "Ambience Loop", "is_image": False})
        self.assertIsNone(manager.state["current_video"])

        # Une programmation vidéo doit pouvoir prendre le relais sur un fond animé (F9.2 "prise de relais")
        await manager.load(video_id=42, title="RPM 100", duration_seconds=2700.0)
        # Bascule directe en lecture : le compte à rebours serveur a été retiré,
        # le pacing est désormais l'animation Lancement.mp4 côté kiosk (réf.
        # refactor "retrait du minuteur autonome").
        self.assertEqual(manager.state["state"], "playing")
        self.assertIsNone(manager.state["current_background"])
        self.assertEqual(manager.state["current_video"]["id"], 42)

        # Relancer le fond, puis vérifier que stop() nettoie bien current_background
        await manager.load_background(2, "Autre ambiance")
        self.assertEqual(manager.state["state"], "background")
        await manager.stop()
        self.assertEqual(manager.state["state"], "waiting")
        self.assertIsNone(manager.state["current_background"])

        # Play/pause doivent rester des no-op pendant un fond animé (pas de notion de pause, réf. F9.2)
        await manager.load_background(3, "Test play/pause no-op")
        await manager.play()
        self.assertEqual(manager.state["state"], "background")
        await manager.pause()
        self.assertEqual(manager.state["state"], "background")


if __name__ == "__main__":
    unittest.main()
