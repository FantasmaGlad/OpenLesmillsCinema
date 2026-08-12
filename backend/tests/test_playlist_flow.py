import os
import sys
import unittest
import asyncio
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


class TestPlaylistFlow(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Set database
        init_db()

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

    async def test_playlist_crud_and_duplicate(self):
        # 1. Create Playlist
        item1 = PlaylistItemInput(video_id=self.video1.id, position=0)
        item2 = PlaylistItemInput(video_id=self.video2.id, position=1)
        payload = PlaylistInput(name="Ma super playlist", items=[item1, item2])
        
        pl = create_playlist(payload, self.db)
        self.assertIsNotNone(pl["id"])
        self.assertEqual(pl["name"], "Ma super playlist")
        self.assertEqual(len(pl["items"]), 2)
        self.assertEqual(pl["items"][0].video.id, self.video1.id)
        self.assertEqual(pl["items"][1].video.id, self.video2.id)

        # Total duration checks (2700 + 1800 = 4500)
        self.assertEqual(pl["total_duration_seconds"], 4500.0)

        # 2. Get playlists list
        pl_list = list_playlists(self.db)
        self.assertEqual(len(pl_list), 1)
        self.assertEqual(pl_list[0]["item_count"], 2)
        self.assertEqual(pl_list[0]["total_duration_seconds"], 4500.0)

        # 3. Update Playlist (reorder & rename)
        item2_new = PlaylistItemInput(video_id=self.video2.id, position=0)
        item1_new = PlaylistItemInput(video_id=self.video1.id, position=1)
        update_payload = PlaylistInput(name="Playlist Renommée", items=[item2_new, item1_new])
        
        updated_pl = update_playlist(pl["id"], update_payload, self.db)
        self.assertEqual(updated_pl["name"], "Playlist Renommée")
        self.assertEqual(updated_pl["items"][0].video.id, self.video2.id)
        self.assertEqual(updated_pl["items"][1].video.id, self.video1.id)

        # 4. Duplicate Playlist
        duplicated_pl = duplicate_playlist(pl["id"], self.db)
        self.assertNotEqual(duplicated_pl["id"], pl["id"])
        self.assertEqual(duplicated_pl["name"], "Playlist Renommée (copie)")
        self.assertEqual(len(duplicated_pl["items"]), 2)
        self.assertEqual(duplicated_pl["items"][0].video.id, self.video2.id)

        # 5. Delete Playlist and Cascade Check
        delete_playlist(pl["id"], self.db)
        self.assertIsNone(self.db.query(Playlist).filter_by(id=pl["id"]).first())
        # The items of pl should have been deleted, but the duplicated playlist's items should remain
        self.assertEqual(self.db.query(PlaylistItem).filter_by(playlist_id=pl["id"]).count(), 0)
        self.assertEqual(self.db.query(PlaylistItem).filter_by(playlist_id=duplicated_pl["id"]).count(), 2)

    async def test_playback_manager_playlist_flow(self):
        # Create a playlist for manager tests
        item1 = PlaylistItemInput(video_id=self.video1.id, position=0)
        item2 = PlaylistItemInput(video_id=self.video2.id, position=1)
        payload = PlaylistInput(name="Flow Playlist", items=[item1, item2])
        pl = create_playlist(payload, self.db)

        # Set up a broadcast mock
        broadcast_payloads = []
        async def mock_broadcast(data):
            broadcast_payloads.append(data)

        # Instantiate playback manager
        manager = PlaybackManager(mock_broadcast)
        
        # Load playlist
        items_data = [
            {"id": self.video1.id, "title": self.video1.title, "duration_seconds": self.video1.duration_seconds, "program": self.video1.program},
            {"id": self.video2.id, "title": self.video2.title, "duration_seconds": self.video2.duration_seconds, "program": self.video2.program},
        ]
        await manager.load_playlist(pl["id"], pl["name"], items_data)
        
        # Check initial state: bascule directe en lecture du premier cours
        # (le pacing du lancement est désormais l'animation Lancement.mp4 côté
        # kiosk, plus d'état serveur "countdown" intermédiaire).
        self.assertEqual(manager.state["state"], "playing")
        self.assertEqual(manager.state["current_video"]["id"], self.video1.id)
        self.assertEqual(manager.state["playlist_name"], "Flow Playlist")
        self.assertEqual(manager.state["playlist_index"], 0)

        # Simulate countdown end and video start
        manager.state["state"] = "playing"
        manager.state["position_seconds"] = 2700.0
        
        # Video ended event
        await manager.video_ended()
        
        # Should switch to playlist_waiting state because there is a next video
        self.assertEqual(manager.state["state"], "playlist_waiting")
        self.assertIsNotNone(manager.state["playlist_waiting_remaining"])
        
        # Simulate ticking the waiting state down
        # Instead of waiting task sleep, we can just manually adjust remaining or tick if manager had it
        # PlaybackManager does tick countdown via task, but we can call skip_waiting directly
        await manager.skip_waiting()
        
        # Should now load the second video immediately (bypassing the 5s launch countdown)
        self.assertEqual(manager.state["state"], "playing")
        self.assertEqual(manager.state["current_video"]["id"], self.video2.id)
        self.assertEqual(manager.state["playlist_index"], 1)

        # Video ended event again
        manager.state["position_seconds"] = 1800.0
        await manager.video_ended()

        # Since it is the end of the playlist, state should return to waiting
        self.assertEqual(manager.state["state"], "waiting")
        self.assertIsNone(manager.state["current_video"])
        self.assertIsNone(manager.state["playlist_name"])

    async def test_playlist_waiting_period_auto_advances(self):
        """Correctifs "playlist bloquée sur 0" et "le décompte ne dure pas 1 s
        par seconde" : au lieu de contourner l'attente via skip_waiting (ce que
        fait le test ci-dessus), on laisse la tâche _run_waiting_period se
        dérouler RÉELLEMENT et on vérifie qu'elle décompte à ~1 s/tick puis
        enchaîne toute seule le cours suivant — sans rester figée sur « 0 »."""
        import time as _time

        item1 = PlaylistItemInput(video_id=self.video1.id, position=0)
        item2 = PlaylistItemInput(video_id=self.video2.id, position=1)
        payload = PlaylistInput(name="Auto-advance Playlist", items=[item1, item2])
        pl = create_playlist(payload, self.db)

        ticks = []
        events = []

        async def mock_broadcast(data):
            events.append((data.get("cause"), data.get("data")))
            if data.get("cause") == "playlist_waiting_tick":
                ticks.append(data["data"]["playlist_waiting_remaining"])

        manager = PlaybackManager(mock_broadcast)
        items_data = [
            {"id": self.video1.id, "title": self.video1.title, "duration_seconds": self.video1.duration_seconds, "program": self.video1.program},
            {"id": self.video2.id, "title": self.video2.title, "duration_seconds": self.video2.duration_seconds, "program": self.video2.program},
        ]
        await manager.load_playlist(pl["id"], pl["name"], items_data)
        manager.state["state"] = "playing"

        # Attente courte pour un test rapide mais assez longue pour distinguer
        # un décompte 1 s/tick (~2 s) d'un décompte 2× trop lent (~4 s).
        original_wait = settings.wait_time_between_courses
        settings.wait_time_between_courses = 2
        try:
            start = _time.monotonic()
            await manager.video_ended()
            self.assertEqual(manager.state["state"], "playlist_waiting")
            # Laisse la vraie tâche d'attente se dérouler jusqu'à l'enchaînement.
            await asyncio.wait_for(manager._waiting_task, timeout=8)
            elapsed = _time.monotonic() - start
        finally:
            settings.wait_time_between_courses = original_wait

        # Correctif "bloquée sur 0" : le cours suivant a bien été lancé.
        self.assertEqual(manager.state["state"], "playing")
        self.assertEqual(manager.state["current_video"]["id"], self.video2.id)
        self.assertEqual(manager.state["playlist_index"], 1)
        # Correctif vitesse : 2 s d'attente doivent prendre ~2 s réelles, pas ~4.
        self.assertLess(elapsed, 3.6, f"Décompte trop lent ({elapsed:.1f}s pour 2s d'attente)")
        # Le décompte est bien passé par 0 (dernier tick émis).
        self.assertIn(0.0, ticks)
        # Correctif "timer bloqué à 0 en prod" (self-cancel du task d'attente) :
        # l'évènement "load" du cours suivant doit avoir été réellement DIFFUSÉ
        # (pas seulement l'état mémoire mis à jour) — sinon la CancelledError
        # interrompt le broadcast et le kiosk reste figé sur « 0 ».
        load_events = [d for (cause, d) in events if cause == "load"]
        self.assertTrue(load_events, "aucun évènement 'load' diffusé pour le cours suivant")
        self.assertEqual(load_events[-1]["current_video"]["id"], self.video2.id)
        self.assertEqual(load_events[-1]["state"], "playing")


if __name__ == "__main__":
    unittest.main()
