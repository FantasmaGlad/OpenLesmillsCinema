import os
import sys
import unittest
from pathlib import Path

# Add backend directory to Python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Set test database
os.environ["OPENLESMILLS_DATABASE_URL"] = "sqlite:///data/test_playlist_database.db"

from app.config import settings
from app.database import init_db, SessionLocal
from app.models import Video, Playlist, PlaylistItem, ImportSource
from app.playback_manager import PlaybackManager
from app.routers.playlists import create_playlist, list_playlists, get_playlist, duplicate_playlist, delete_playlist, update_playlist
from app.routers.playlists import PlaylistInput, PlaylistItemInput



class TestPlaylistFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Set database
        init_db()

    @classmethod
    def tearDownClass(cls):
        # Clean up database file
        db_path = Path(settings.database_url.replace("sqlite:///", ""))
        if db_path.exists():
            db_path.unlink()

    def setUp(self):
        self.db = SessionLocal()
        # Seed dummy videos
        self.video1 = Video(
            file_path="data/test_videos/video1.mp4",
            title="RPM 98",
            program="RPM",
            release="98",
            duration_seconds=2700.0,
            source=ImportSource.upload
        )
        self.video2 = Video(
            file_path="data/test_videos/video2.mp4",
            title="Sprint 35",
            program="Sprint",
            release="35",
            duration_seconds=1800.0,
            source=ImportSource.upload
        )
        self.db.add_all([self.video1, self.video2])
        self.db.commit()

    def tearDown(self):
        self.db.query(PlaylistItem).delete()
        self.db.query(Playlist).delete()
        self.db.query(Video).delete()
        self.db.commit()
        self.db.close()

    def test_playlist_crud_and_duplicate(self):
        # 1. Create Playlist
        item1 = PlaylistItemInput(video_id=self.video1.id, position=0)
        item2 = PlaylistItemInput(video_id=self.video2.id, position=1)
        payload = PlaylistInput(name="Ma super playlist", items=[item1, item2])
        
        pl = create_playlist(payload, self.db)
        self.assertIsNotNone(pl.id)
        self.assertEqual(pl.name, "Ma super playlist")
        self.assertEqual(len(pl.items), 2)
        self.assertEqual(pl.items[0].video_id, self.video1.id)
        self.assertEqual(pl.items[1].video_id, self.video2.id)

        # Total duration checks (2700 + 1800 = 4500)
        self.assertEqual(sum(item.video.duration_seconds for item in pl.items), 4500.0)

        # 2. Get playlists list
        pl_list = list_playlists(self.db)
        self.assertEqual(len(pl_list), 1)
        self.assertEqual(pl_list[0]["item_count"], 2)
        self.assertEqual(pl_list[0]["total_duration_seconds"], 4500.0)

        # 3. Update Playlist (reorder & rename)
        item2_new = PlaylistItemInput(video_id=self.video2.id, position=0)
        item1_new = PlaylistItemInput(video_id=self.video1.id, position=1)
        update_payload = PlaylistInput(name="Playlist Renommée", items=[item2_new, item1_new])
        
        updated_pl = update_playlist(pl.id, update_payload, self.db)
        self.assertEqual(updated_pl.name, "Playlist Renommée")
        self.assertEqual(updated_pl.items[0].video_id, self.video2.id)
        self.assertEqual(updated_pl.items[1].video_id, self.video1.id)

        # 4. Duplicate Playlist
        duplicated_pl = duplicate_playlist(pl.id, self.db)
        self.assertNotEqual(duplicated_pl.id, pl.id)
        self.assertEqual(duplicated_pl.name, "Playlist Renommée (Copie)")
        self.assertEqual(len(duplicated_pl.items), 2)
        self.assertEqual(duplicated_pl.items[0].video_id, self.video2.id)

        # 5. Delete Playlist and Cascade Check
        delete_playlist(pl.id, self.db)
        self.assertIsNone(self.db.query(Playlist).filter_by(id=pl.id).first())
        # The items of pl should have been deleted, but the duplicated playlist's items should remain
        self.assertEqual(self.db.query(PlaylistItem).filter_by(playlist_id=pl.id).count(), 0)
        self.assertEqual(self.db.query(PlaylistItem).filter_by(playlist_id=duplicated_pl.id).count(), 2)

    def test_playback_manager_playlist_flow(self):
        # Create a playlist for manager tests
        item1 = PlaylistItemInput(video_id=self.video1.id, position=0)
        item2 = PlaylistItemInput(video_id=self.video2.id, position=1)
        payload = PlaylistInput(name="Flow Playlist", items=[item1, item2])
        pl = create_playlist(payload, self.db)

        # Instantiate playback manager (using wait time 5s)
        manager = PlaybackManager()
        
        # Load playlist
        manager.load_playlist(pl.id, self.db)
        
        # Check initial state: should start countdown for first video
        self.assertEqual(manager.state, "countdown")
        self.assertEqual(manager.current_video.id, self.video1.id)
        self.assertEqual(manager.playlist_name, "Flow Playlist")
        self.assertEqual(manager.playlist_index, 0)

        # Simulate countdown finish, tick and video end
        manager.state = "playing"
        manager.position_seconds = 2700.0
        
        # Video ended event
        manager.video_ended()
        
        # Should switch to playlist_waiting state because there is a next video
        self.assertEqual(manager.state, "playlist_waiting")
        self.assertIsNotNone(manager.playlist_waiting_remaining)
        
        # Simulate ticking the waiting state down
        manager.tick(3.0)
        self.assertEqual(manager.state, "playlist_waiting")
        self.assertAlmostEqual(manager.playlist_waiting_remaining, settings.wait_time_between_courses - 3.0)

        # Skip waiting
        manager.skip_waiting()
        
        # Should now load the second video immediately (bypassing the 5s launch countdown)
        self.assertEqual(manager.state, "playing")
        self.assertEqual(manager.current_video.id, self.video2.id)
        self.assertEqual(manager.playlist_index, 1)

        # Video ended event again
        manager.position_seconds = 1800.0
        manager.video_ended()

        # Since it is the end of the playlist, state should return to waiting
        self.assertEqual(manager.state, "waiting")
        self.assertIsNone(manager.current_video)
        self.assertIsNone(manager.playlist_name)


if __name__ == "__main__":
    unittest.main()
