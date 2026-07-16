import enum
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class ImportSource(str, enum.Enum):
    upload = "upload"
    watched_folder = "watched_folder"


class ScheduleType(str, enum.Enum):
    once = "once"
    recurring = "recurring"


class ScheduleTargetType(str, enum.Enum):
    video = "video"
    playlist = "playlist"


class OverrideAction(str, enum.Enum):
    cancelled = "cancelled"
    replaced = "replaced"


class CanvasLayoutType(str, enum.Enum):
    waiting = "waiting"
    pause = "pause"


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    file_path: Mapped[str] = mapped_column(unique=True)
    title: Mapped[str]
    # Programme volontairement en texte libre (pas un enum figé) : §8 du cahier
    # des charges prévoit l'ajout de programmes au-delà de RPM/Sprint/The Trip.
    program: Mapped[str | None]
    release: Mapped[str | None]
    duration_seconds: Mapped[float | None]
    width: Mapped[int | None]
    height: Mapped[int | None]
    codec: Mapped[str | None]
    thumbnail_path: Mapped[str | None]
    imported_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))
    source: Mapped[ImportSource]

    playlist_items: Mapped[list["PlaylistItem"]] = relationship(back_populates="video")


class Background(Base):
    __tablename__ = "backgrounds"

    id: Mapped[int] = mapped_column(primary_key=True)
    file_path: Mapped[str] = mapped_column(unique=True)
    title: Mapped[str]
    duration_seconds: Mapped[float | None]
    thumbnail_path: Mapped[str | None]
    imported_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class AudioCourse(Base):
    __tablename__ = "audio_courses"

    id: Mapped[int] = mapped_column(primary_key=True)
    program: Mapped[str | None]
    release: Mapped[str | None]
    title: Mapped[str]
    background_id: Mapped[int | None] = mapped_column(ForeignKey("backgrounds.id"))
    imported_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))

    background: Mapped[Background | None] = relationship()
    tracks: Mapped[list["AudioTrack"]] = relationship(
        back_populates="course", order_by="AudioTrack.position", cascade="all, delete-orphan"
    )


class AudioTrack(Base):
    __tablename__ = "audio_tracks"

    id: Mapped[int] = mapped_column(primary_key=True)
    audio_course_id: Mapped[int] = mapped_column(ForeignKey("audio_courses.id"))
    number: Mapped[int | None]
    title: Mapped[str]
    file_path: Mapped[str] = mapped_column(unique=True)
    duration_seconds: Mapped[float | None]
    position: Mapped[int]

    course: Mapped[AudioCourse] = relationship(back_populates="tracks")


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))

    items: Mapped[list["PlaylistItem"]] = relationship(
        back_populates="playlist", order_by="PlaylistItem.position", cascade="all, delete-orphan"
    )


class PlaylistItem(Base):
    __tablename__ = "playlist_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id"))
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id"))
    position: Mapped[int]

    playlist: Mapped[Playlist] = relationship(back_populates="items")
    video: Mapped[Video] = relationship(back_populates="playlist_items")


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[ScheduleTargetType]
    target_id: Mapped[int]
    schedule_type: Mapped[ScheduleType]
    recurrence_rule: Mapped[str | None]
    run_at: Mapped[datetime | None]
    active: Mapped[bool] = mapped_column(default=True)

    overrides: Mapped[list["ScheduleOverride"]] = relationship(
        back_populates="schedule", cascade="all, delete-orphan"
    )


class ScheduleOverride(Base):
    __tablename__ = "schedule_overrides"

    id: Mapped[int] = mapped_column(primary_key=True)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("schedules.id"))
    occurrence_date: Mapped[datetime]
    action: Mapped[OverrideAction]
    replacement_target_type: Mapped[ScheduleTargetType | None]
    replacement_target_id: Mapped[int | None]

    schedule: Mapped[Schedule] = relationship(back_populates="overrides")


class PlaybackState(Base):
    """Mémorise une action différée en attente de reprise ou de relance
    manuelle depuis l'interface. Deux formes selon `cause` :
    - "schedule" (F5.3) : lecture manuelle interrompue par une programmation
      -> `video_id`/`position_seconds` renseignés, reprise à la position exacte.
    - "coach_priority" (F10.7) : programmation qui n'a PAS pu démarrer car le
      mode audio coach était actif -> `target_type`/`target_id` renseignés
      (cible jamais lancée, donc pas de position), relance depuis zéro.
    Une seule ligne à la fois quelle que soit la cause (la plus récente
    remplace la précédente non traitée), cf. scheduler_manager._launch_target.
    """
    __tablename__ = "playback_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int | None] = mapped_column(ForeignKey("videos.id"))
    position_seconds: Mapped[float | None]
    target_type: Mapped[str | None]
    target_id: Mapped[int | None]
    cause: Mapped[str | None]
    interrupted_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class CanvasLayout(Base):
    __tablename__ = "canvas_layouts"

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[CanvasLayoutType]
    name: Mapped[str]
    definition: Mapped[dict] = mapped_column(JSON)
    active: Mapped[bool] = mapped_column(default=False)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(primary_key=True)
    value: Mapped[str]


class ActivityLog(Base):
    __tablename__ = "activity_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))
    event_type: Mapped[str]
    detail: Mapped[str | None]
