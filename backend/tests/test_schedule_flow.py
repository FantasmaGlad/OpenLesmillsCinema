import asyncio
import os
import sys
import unittest
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

# Add backend directory to Python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Set test database
os.environ["OPENLESMILLS_DATABASE_URL"] = "sqlite:///data/test_schedule_database.db"

from fastapi import HTTPException

from app.config import settings
from app.database import init_db, SessionLocal
from app.models import (
    ImportSource,
    OverrideAction,
    PlaybackState,
    Playlist,
    PlaylistItem,
    Schedule,
    ScheduleOverride,
    ScheduleTargetType,
    ScheduleType,
    Video,
)
from app.playback_manager import init_playback_manager
from app.routers.playback import dismiss_interrupted_state, resume_interrupted_state
from app.routers.schedule import (
    OverrideInput,
    ScheduleInput,
    create_override,
    create_schedule,
    delete_schedule,
    get_next_schedule,
    get_schedule,
    list_schedules,
    update_schedule,
)
from app.scheduler_manager import expand_occurrences, fire_schedule, start_scheduler, stop_scheduler


class TestScheduleFlow(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

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

    def setUp(self):
        self.db = SessionLocal()
        self.video1 = Video(
            file_path="data/test_videos/schedule_video1.mp4",
            title="RPM 98",
            program="RPM",
            release="98",
            duration_seconds=2700.0,
            source=ImportSource.upload,
        )
        self.video2 = Video(
            file_path="data/test_videos/schedule_video2.mp4",
            title="Sprint 35",
            program="Sprint",
            release="35",
            duration_seconds=1800.0,
            source=ImportSource.upload,
        )
        self.db.add_all([self.video1, self.video2])
        self.db.commit()

        self.playlist = Playlist(name="Enchainement test")
        self.db.add(self.playlist)
        self.db.flush()
        self.db.add_all(
            [
                PlaylistItem(playlist_id=self.playlist.id, video_id=self.video1.id, position=0),
                PlaylistItem(playlist_id=self.playlist.id, video_id=self.video2.id, position=1),
            ]
        )
        self.db.commit()

    def tearDown(self):
        stop_scheduler()
        self.db.query(PlaybackState).delete()
        self.db.query(ScheduleOverride).delete()
        self.db.query(Schedule).delete()
        self.db.query(PlaylistItem).delete()
        self.db.query(Playlist).delete()
        self.db.query(Video).delete()
        self.db.commit()
        self.db.close()

    async def test_schedule_crud_and_validation(self):
        future = datetime.now(timezone.utc) + timedelta(days=3)
        once = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video1.id,
                schedule_type=ScheduleType.once,
                run_at=future,
            ),
            self.db,
        )
        self.assertIsNotNone(once["id"])
        self.assertEqual(once["target_title"], "RPM 98")
        self.assertTrue(once["active"])

        # Les overrides ne s'appliquent qu'aux programmations récurrentes.
        with self.assertRaises(HTTPException):
            create_override(
                once["id"],
                OverrideInput(occurrence_date="2026-08-04", action=OverrideAction.cancelled),
                self.db,
            )

        recurring = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.playlist,
                target_id=self.playlist.id,
                schedule_type=ScheduleType.recurring,
                days_of_week=[1, 3],
                time_of_day="18:30",
            ),
            self.db,
        )
        self.assertEqual(recurring["days_of_week"], [1, 3])
        self.assertEqual(recurring["time_of_day"], "18:30")
        self.assertEqual(recurring["target_title"], "Enchainement test")

        self.assertEqual(len(list_schedules(self.db)), 2)
        self.assertEqual(get_schedule(recurring["id"], self.db)["id"], recurring["id"])

        updated = update_schedule(
            recurring["id"],
            ScheduleInput(
                target_type=ScheduleTargetType.playlist,
                target_id=self.playlist.id,
                schedule_type=ScheduleType.recurring,
                days_of_week=[2],
                time_of_day="09:00",
            ),
            self.db,
        )
        self.assertEqual(updated["days_of_week"], [2])
        self.assertEqual(updated["time_of_day"], "09:00")

        # Validations
        with self.assertRaises(HTTPException):
            create_schedule(
                ScheduleInput(
                    target_type=ScheduleTargetType.video,
                    target_id=self.video1.id,
                    schedule_type=ScheduleType.once,
                    run_at=None,
                ),
                self.db,
            )
        with self.assertRaises(HTTPException):
            create_schedule(
                ScheduleInput(
                    target_type=ScheduleTargetType.video,
                    target_id=self.video1.id,
                    schedule_type=ScheduleType.once,
                    run_at=datetime.now(timezone.utc) - timedelta(hours=1),
                ),
                self.db,
            )
        with self.assertRaises(HTTPException):
            create_schedule(
                ScheduleInput(
                    target_type=ScheduleTargetType.video,
                    target_id=self.video1.id,
                    schedule_type=ScheduleType.recurring,
                    days_of_week=None,
                    time_of_day="10:00",
                ),
                self.db,
            )
        with self.assertRaises(HTTPException):
            create_schedule(
                ScheduleInput(
                    target_type=ScheduleTargetType.video,
                    target_id=self.video1.id,
                    schedule_type=ScheduleType.recurring,
                    days_of_week=[7],
                    time_of_day="10:00",
                ),
                self.db,
            )
        with self.assertRaises(HTTPException):
            create_schedule(
                ScheduleInput(
                    target_type=ScheduleTargetType.video,
                    target_id=self.video1.id,
                    schedule_type=ScheduleType.recurring,
                    days_of_week=[1],
                    time_of_day="9:00",
                ),
                self.db,
            )
        with self.assertRaises(HTTPException):
            create_schedule(
                ScheduleInput(
                    target_type=ScheduleTargetType.video,
                    target_id=999999,
                    schedule_type=ScheduleType.once,
                    run_at=future,
                ),
                self.db,
            )

        # Override + suppression en cascade
        override = create_override(
            recurring["id"],
            OverrideInput(occurrence_date="2026-08-04", action=OverrideAction.cancelled),
            self.db,
        )
        self.assertEqual(override["action"], OverrideAction.cancelled)

        delete_schedule(recurring["id"], self.db)
        self.assertIsNone(self.db.query(Schedule).filter_by(id=recurring["id"]).first())
        self.assertEqual(
            self.db.query(ScheduleOverride).filter_by(schedule_id=recurring["id"]).count(), 0
        )

        delete_schedule(once["id"], self.db)

    async def test_expand_occurrences_with_overrides(self):
        anchor = date(2026, 7, 16)  # jeudi (cohérent avec la date système de référence)
        created = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video1.id,
                schedule_type=ScheduleType.recurring,
                days_of_week=[anchor.weekday()],
                time_of_day="10:00",
            ),
            self.db,
        )
        schedule = self.db.query(Schedule).filter_by(id=created["id"]).first()

        occ2_date = (anchor + timedelta(days=7)).isoformat()
        occ3_date = (anchor + timedelta(days=14)).isoformat()
        create_override(
            created["id"], OverrideInput(occurrence_date=occ2_date, action=OverrideAction.cancelled), self.db
        )
        create_override(
            created["id"],
            OverrideInput(
                occurrence_date=occ3_date,
                action=OverrideAction.replaced,
                replacement_target_type=ScheduleTargetType.video,
                replacement_target_id=self.video2.id,
            ),
            self.db,
        )

        start = datetime.combine(anchor, time(0, 0), tzinfo=timezone.utc) - timedelta(days=1)
        end = start + timedelta(days=22)
        occurrences = expand_occurrences(self.db, [schedule], start, end)

        self.assertEqual(len(occurrences), 3)
        self.assertIsNone(occurrences[0]["override_action"])
        self.assertEqual(occurrences[0]["title"], "RPM 98")

        self.assertEqual(occurrences[1]["override_action"], OverrideAction.cancelled)
        self.assertEqual(occurrences[1]["title"], "RPM 98")  # titre d'origine conservé pour l'affichage barré

        self.assertEqual(occurrences[2]["override_action"], OverrideAction.replaced)
        self.assertEqual(occurrences[2]["title"], "Sprint 35")
        self.assertEqual(occurrences[2]["target_id"], self.video2.id)

    def test_next_schedule_skips_cancelled_occurrence(self):
        tomorrow = date.today() + timedelta(days=1)
        day_after = date.today() + timedelta(days=2)

        recurring = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video1.id,
                schedule_type=ScheduleType.recurring,
                days_of_week=[tomorrow.weekday()],
                time_of_day="12:00",
            ),
            self.db,
        )
        create_override(
            recurring["id"],
            OverrideInput(occurrence_date=tomorrow.isoformat(), action=OverrideAction.cancelled),
            self.db,
        )

        create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video2.id,
                schedule_type=ScheduleType.once,
                run_at=datetime.combine(day_after, time(9, 0), tzinfo=timezone.utc),
            ),
            self.db,
        )

        result = get_next_schedule(self.db)
        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Sprint 35")

    async def test_conflict_and_resume_flow(self):
        broadcasts = []

        async def mock_broadcast(payload):
            broadcasts.append(payload)

        manager = init_playback_manager(mock_broadcast)

        # Simule une lecture manuelle en cours (video1 à 42s).
        await manager.load(
            self.video1.id, self.video1.title, self.video1.duration_seconds, self.video1.program, skip_countdown=True
        )
        manager.state["position_seconds"] = 42.0

        scheduled = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video2.id,
                schedule_type=ScheduleType.once,
                run_at=datetime.now(timezone.utc) + timedelta(days=1),
            ),
            self.db,
        )

        await fire_schedule(scheduled["id"])

        # La programmation a pris la main (F5.3 : elle est prioritaire).
        self.assertEqual(manager.state["current_video"]["id"], self.video2.id)

        # La lecture manuelle interrompue est mémorisée pour reprise.
        interrupted = self.db.query(PlaybackState).order_by(PlaybackState.id.desc()).first()
        self.assertIsNotNone(interrupted)
        self.assertEqual(interrupted.video_id, self.video1.id)
        self.assertEqual(interrupted.position_seconds, 42.0)
        self.assertEqual(interrupted.cause, "schedule")

        # Reprise manuelle depuis l'interface.
        await resume_interrupted_state(self.db)
        self.assertEqual(manager.state["current_video"]["id"], self.video1.id)
        self.assertEqual(manager.state["position_seconds"], 42.0)
        self.assertIsNone(self.db.query(PlaybackState).order_by(PlaybackState.id.desc()).first())

    async def test_conflict_dismiss_without_resume(self):
        broadcasts = []

        async def mock_broadcast(payload):
            broadcasts.append(payload)

        manager = init_playback_manager(mock_broadcast)
        await manager.load(
            self.video1.id, self.video1.title, self.video1.duration_seconds, self.video1.program, skip_countdown=True
        )

        scheduled = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video2.id,
                schedule_type=ScheduleType.once,
                run_at=datetime.now(timezone.utc) + timedelta(days=1),
            ),
            self.db,
        )
        await fire_schedule(scheduled["id"])
        self.assertIsNotNone(self.db.query(PlaybackState).first())

        dismiss_interrupted_state(self.db)
        self.assertIsNone(self.db.query(PlaybackState).first())
        # L'abandon ne relance pas la vidéo interrompue.
        self.assertEqual(manager.state["current_video"]["id"], self.video2.id)

    async def test_fire_schedule_respects_cancelled_override(self):
        broadcasts = []

        async def mock_broadcast(payload):
            broadcasts.append(payload)

        manager = init_playback_manager(mock_broadcast)
        today = date.today()

        recurring = create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video1.id,
                schedule_type=ScheduleType.recurring,
                days_of_week=[today.weekday()],
                time_of_day="12:00",
            ),
            self.db,
        )
        create_override(
            recurring["id"],
            OverrideInput(occurrence_date=today.isoformat(), action=OverrideAction.cancelled),
            self.db,
        )

        await fire_schedule(recurring["id"])

        # L'occurrence du jour est annulée : rien n'est lancé.
        self.assertIsNone(manager.state["current_video"])
        self.assertEqual(len(broadcasts), 0)

    async def test_scheduler_real_timer_fires_job(self):
        broadcasts = []

        async def mock_broadcast(payload):
            broadcasts.append(payload)

        manager = init_playback_manager(mock_broadcast)

        start_scheduler()
        run_at = datetime.now(timezone.utc) + timedelta(seconds=1.5)
        create_schedule(
            ScheduleInput(
                target_type=ScheduleTargetType.video,
                target_id=self.video1.id,
                schedule_type=ScheduleType.once,
                run_at=run_at,
            ),
            self.db,
        )

        await asyncio.sleep(3)

        self.assertIsNotNone(manager.state["current_video"])
        self.assertEqual(manager.state["current_video"]["id"], self.video1.id)


if __name__ == "__main__":
    unittest.main()
