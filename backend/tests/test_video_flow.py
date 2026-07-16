import os
import sys
import shutil
import unittest
import subprocess
from pathlib import Path

# Add backend directory to Python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Set test directories before importing config
os.environ["OPENLESMILLS_DATABASE_URL"] = "sqlite:///data/test_database.db"
os.environ["OPENLESMILLS_MEDIA_DIR"] = "data/test_videos"
os.environ["OPENLESMILLS_WATCH_DIR"] = "data/test_watched"
os.environ["OPENLESMILLS_THUMBNAILS_DIR"] = "data/test_thumbnails"

from app.config import settings
from app.database import init_db, SessionLocal, get_db
from app.models import Video, ImportSource
from app.utils.video_utils import extract_metadata, check_compatibility, generate_thumbnail
from app.utils.importer import import_video
from app.routers.videos import VideoUpdate, update_video


class TestVideoFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Create directories if they do not exist
        Path(settings.media_dir).mkdir(parents=True, exist_ok=True)
        Path(settings.watch_dir).mkdir(parents=True, exist_ok=True)
        Path(settings.thumbnails_dir).mkdir(parents=True, exist_ok=True)

        cls.dummy_compatible_path = str(Path(settings.watch_dir) / "test_RPM_98_compatible.mp4")
        cls.dummy_incompatible_path = str(Path(settings.watch_dir) / "test_Sprint_35_incompatible.mkv")

        print("Generating compatible test video with ffmpeg...")
        # H264 + AAC MP4 (Direct Play compatible)
        cmd_comp = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
            "-c:v", "libx264", "-c:a", "aac",
            "-pix_fmt", "yuv420p",
            cls.dummy_compatible_path
        ]
        subprocess.run(cmd_comp, capture_output=True, check=True)

        print("Generating incompatible test video with ffmpeg...")
        # H264 + AC-3 MKV (Needs normalization)
        cmd_incomp = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
            "-c:v", "libx264", "-c:a", "ac3",
            "-pix_fmt", "yuv420p",
            cls.dummy_incompatible_path
        ]
        subprocess.run(cmd_incomp, capture_output=True, check=True)

    @classmethod
    def tearDownClass(cls):
        # Dispose engine to release file locks
        from app.database import engine
        engine.dispose()
        # Clean up database file
        db_path = Path(settings.database_url.replace("sqlite:///", ""))
        if db_path.exists():
            try:
                db_path.unlink()
            except PermissionError:
                pass


        # Clean up directories
        for d in [settings.media_dir, settings.watch_dir, settings.thumbnails_dir]:
            p = Path(d)
            if p.exists():
                shutil.rmtree(p)

    def setUp(self):
        # Initialize Database schema
        init_db()
        self.db = SessionLocal()

    def tearDown(self):
        self.db.query(Video).delete()
        self.db.commit()
        self.db.close()

    def test_01_extract_metadata_compatible(self):
        meta = extract_metadata(self.dummy_compatible_path)
        self.assertIsNotNone(meta["duration_seconds"])
        self.assertEqual(meta["width"], 320)
        self.assertEqual(meta["height"], 240)
        self.assertEqual(meta["codec"], "h264")
        self.assertEqual(meta["audio_codec"], "aac")
        self.assertFalse(meta["is_drm"])

        compat = check_compatibility(meta, self.dummy_compatible_path)
        self.assertTrue(compat["is_compatible"])
        self.assertFalse(compat["needs_normalization"])

    def test_02_extract_metadata_incompatible(self):
        meta = extract_metadata(self.dummy_incompatible_path)
        self.assertIsNotNone(meta["duration_seconds"])
        self.assertEqual(meta["codec"], "h264")
        self.assertEqual(meta["audio_codec"], "ac3")
        self.assertFalse(meta["is_drm"])

        compat = check_compatibility(meta, self.dummy_incompatible_path)
        self.assertFalse(compat["is_compatible"])
        self.assertTrue(compat["needs_normalization"])
        self.assertIn("recode_audio", compat["actions"])
        self.assertIn("recode_container", compat["actions"])

    def test_03_generate_thumbnail(self):
        thumb_path = generate_thumbnail(
            self.dummy_compatible_path,
            settings.thumbnails_dir,
            1.0
        )
        self.assertTrue(os.path.exists(thumb_path))
        self.assertTrue(Path(thumb_path).is_file())

    def test_04_import_video_direct_play(self):
        # Create a temp copy of compatible to import (since importer moves/deletes source)
        temp_src = str(Path(settings.watch_dir) / "temp_compatible_import.mp4")
        shutil.copy(self.dummy_compatible_path, temp_src)

        video = import_video(temp_src, "RPM 98 Compatible.mp4", ImportSource.upload)
        self.assertIsNotNone(video.id)
        self.assertEqual(video.program, "RPM")
        self.assertEqual(video.release, "98")
        self.assertTrue(os.path.exists(video.file_path))
        self.assertTrue(os.path.exists(video.thumbnail_path))

    def test_05_import_video_with_normalization(self):
        # Create a temp copy of incompatible to import
        temp_src = str(Path(settings.watch_dir) / "temp_incompatible_import.mkv")
        shutil.copy(self.dummy_incompatible_path, temp_src)

        video = import_video(temp_src, "Sprint 35 Incompatible.mkv", ImportSource.watched_folder)
        self.assertIsNotNone(video.id)
        self.assertEqual(video.program, "Sprint")
        self.assertEqual(video.release, "35")
        self.assertTrue(os.path.exists(video.file_path))
        self.assertTrue(video.file_path.endswith(".mp4"))
        self.assertTrue(os.path.exists(video.thumbnail_path))

        # Check metadata of final file - should be H.264 / AAC / MP4
        meta = extract_metadata(video.file_path)
        self.assertEqual(meta["audio_codec"], "aac")
        self.assertEqual(meta["codec"], "h264")

    def test_06_video_metadata_rename_flow(self):
        temp_src = str(Path(settings.watch_dir) / "temp_rename_test.mp4")
        shutil.copy(self.dummy_compatible_path, temp_src)

        video = import_video(temp_src, "Initial Title.mp4", ImportSource.upload)
        old_file_path = video.file_path
        self.assertTrue(os.path.exists(old_file_path))

        # Trigger metadata update with new title
        payload = VideoUpdate(title="Updated Title RPM 99", program="RPM", release="99")
        updated_video = update_video(video.id, payload, self.db)

        # Check DB title updated
        self.assertEqual(updated_video.title, "Updated Title RPM 99")
        self.assertEqual(updated_video.release, "99")

        # Check physical file is renamed
        new_file_path = updated_video.file_path
        self.assertNotEqual(old_file_path, new_file_path)
        self.assertFalse(os.path.exists(old_file_path))
        self.assertTrue(os.path.exists(new_file_path))
        self.assertIn("Updated_Title_RPM_99", new_file_path)


if __name__ == "__main__":
    unittest.main()
