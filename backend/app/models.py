import enum
from datetime import datetime, timezone

from sqlalchemy import Column, ForeignKey, Integer, Table
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
    # Réf. lot L7 : intégration Planning du module Radio — une fenêtre
    # (ou 24/7) remplace temporairement la playlist d'ambiance par défaut.
    radio_playlist = "radio_playlist"


class OverrideAction(str, enum.Enum):
    cancelled = "cancelled"
    replaced = "replaced"


class RadioCoverSource(str, enum.Enum):
    """Origine de la pochette d'un morceau radio (réf. cahier des charges Radio,
    D3 « auto ID3 + override manuel ») : `id3` = extraite du fichier à l'import,
    `manual` = image fournie/remplacée depuis l'admin, `none` = pas de pochette."""
    id3 = "id3"
    manual = "manual"
    none = "none"


class RadioAnnouncementRuleType(str, enum.Enum):
    """Type de déclenchement d'un rappel (réf. cahier des charges Radio, D11) :
    entre les morceaux (`every_n_tracks`), à intervalle régulier
    (`every_x_minutes`) ou à horaires fixes récurrents (`fixed_times`). Le
    déclenchement « manuel » n'est pas une règle persistée mais une action à la
    demande, il n'apparaît donc pas ici."""
    every_n_tracks = "every_n_tracks"
    every_x_minutes = "every_x_minutes"
    fixed_times = "fixed_times"


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


class AudioPlaylist(Base):
    """Playlist spéciale composée de pistes individuelles piochées dans
    n'importe quel cours audio (réf. mission "playlists spéciales... des
    musiques de plusieurs RPM différents, pas juste plusieurs RPM collés") :
    une "édition mixée" est une séquence de PISTES (pas de cours entiers
    enchaînés) — un mix peut donc combiner des morceaux de RPM 101, 103 et
    110 dans n'importe quel ordre."""
    __tablename__ = "audio_playlists"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))

    items: Mapped[list["AudioPlaylistItem"]] = relationship(
        back_populates="playlist", order_by="AudioPlaylistItem.position", cascade="all, delete-orphan"
    )


class AudioPlaylistItem(Base):
    __tablename__ = "audio_playlist_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("audio_playlists.id"))
    audio_track_id: Mapped[int] = mapped_column(ForeignKey("audio_tracks.id"))
    position: Mapped[int]
    # Fond d'ambiance propre à CETTE piste dans CETTE playlist (réf. mission
    # "associer un fond animé à chaque musique qui se jouera en arrière
    # plan") : rattaché à l'item plutôt qu'à la piste elle-même, une même
    # piste pouvant apparaître dans plusieurs playlists avec un fond
    # différent à chaque fois. Nul = pas de fond propre, le fond de la
    # playlist/du cours (défini au lancement) reste affiché pour cette piste.
    background_id: Mapped[int | None] = mapped_column(ForeignKey("backgrounds.id"))

    playlist: Mapped[AudioPlaylist] = relationship(back_populates="items")
    track: Mapped["AudioTrack"] = relationship()
    background: Mapped[Background | None] = relationship()


# ---------------------------------------------------------------------------
# Module Radio (réf. docs/cahier-des-charges-radio.md)
#
# Sous-système musical INDÉPENDANT (décision D1) : tables `radio_*` séparées des
# cours audio coach (`audio_*`), avec leurs propres métadonnées (artiste, album,
# genre, pochette) et un 3e canal de diffusion `radio` (décision D2). Les tables
# sont créées par `Base.metadata.create_all()` au démarrage — ce projet n'utilise
# pas Alembic (cf. database.py::_migrate_add_missing_columns).
# ---------------------------------------------------------------------------

# Association N-N morceaux <-> étiquettes (réf. D7 « tags/genres ») : une table
# de liaison simple sans données propres, contrairement aux `*_items` qui
# portent une position — un morceau peut avoir plusieurs tags, un tag plusieurs
# morceaux.
radio_track_tags = Table(
    "radio_track_tags",
    Base.metadata,
    Column("radio_track_id", Integer, ForeignKey("radio_tracks.id"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("radio_tags.id"), primary_key=True),
)


class RadioTrack(Base):
    """Un morceau de musique de la bibliothèque radio (réf. D1/D3/D7). Les
    champs de navigation (artiste/album/album_artist/genre) alimentent les vues
    « artiste/album » et « tags/genres » par regroupement dérivé — pas de tables
    Artiste/Album dédiées en v1."""
    __tablename__ = "radio_tracks"

    id: Mapped[int] = mapped_column(primary_key=True)
    file_path: Mapped[str] = mapped_column(unique=True)
    title: Mapped[str]
    artist: Mapped[str | None]
    album: Mapped[str | None]
    album_artist: Mapped[str | None]
    track_number: Mapped[int | None]
    disc_number: Mapped[int | None]
    year: Mapped[int | None]
    genre: Mapped[str | None]
    duration_seconds: Mapped[float | None]
    # Pochette : chemin du fichier image extrait (ID3) ou uploadé, `None` si
    # aucune. `cover_source` trace son origine pour ne pas réécraser une
    # pochette manuelle lors d'un ré-import (réf. D3).
    cover_path: Mapped[str | None]
    cover_source: Mapped[RadioCoverSource] = mapped_column(default=RadioCoverSource.none)
    source: Mapped[ImportSource]
    imported_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))

    tags: Mapped[list["RadioTag"]] = relationship(secondary=radio_track_tags, back_populates="tracks")


class RadioTag(Base):
    """Étiquette libre applicable aux morceaux radio (réf. D7 « tags/genres ») :
    ambiance, tempo, occasion… saisie/gérée depuis l'admin, indépendante du
    `genre` ID3 porté par le morceau."""
    __tablename__ = "radio_tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(unique=True)

    tracks: Mapped[list["RadioTrack"]] = relationship(secondary=radio_track_tags, back_populates="tags")


class RadioPlaylist(Base):
    """Playlist radio créée à la main (réf. D6/D7). `is_default` désigne la
    playlist d'ambiance qui tourne en boucle 24/7 (décision D9) : une seule à la
    fois, garantie applicativement (aucune contrainte SQL). `cover_path` est
    optionnel — sinon l'UI dérive la pochette du premier morceau."""
    __tablename__ = "radio_playlists"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    is_default: Mapped[bool] = mapped_column(default=False)
    cover_path: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))

    items: Mapped[list["RadioPlaylistItem"]] = relationship(
        back_populates="playlist", order_by="RadioPlaylistItem.position", cascade="all, delete-orphan"
    )


class RadioPlaylistItem(Base):
    __tablename__ = "radio_playlist_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("radio_playlists.id"))
    radio_track_id: Mapped[int] = mapped_column(ForeignKey("radio_tracks.id"))
    position: Mapped[int]

    playlist: Mapped[RadioPlaylist] = relationship(back_populates="items")
    track: Mapped[RadioTrack] = relationship()


class RadioAnnouncement(Base):
    """Rappel de bienséance intercalé dans la musique (réf. D11-D13) : fichier
    audio + `description` OBLIGATOIRE (le texte dit par l'annonce, pour gérer
    facilement le pool depuis l'admin). `enabled` retire un rappel du tirage
    sans le supprimer."""
    __tablename__ = "radio_announcements"

    id: Mapped[int] = mapped_column(primary_key=True)
    file_path: Mapped[str] = mapped_column(unique=True)
    description: Mapped[str]
    duration_seconds: Mapped[float | None]
    enabled: Mapped[bool] = mapped_column(default=True)
    imported_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class RadioAnnouncementRule(Base):
    """Règle de déclenchement des rappels (réf. D11-D12). Les règles définissent
    QUAND déclencher ; le rappel joué est tiré AU HASARD parmi les
    `radio_announcements` actifs (décision D13, pas de ciblage par règle en v1).
    Seul le champ correspondant au `rule_type` est renseigné :
    - `every_n_tracks`  -> `n_tracks`      (insertion à la fin du morceau)
    - `every_x_minutes` -> `interval_minutes` (fondu immédiat / duck)
    - `fixed_times`     -> `times_of_day`  (JSON ["09:00","09:30"], fondu immédiat)
    """
    __tablename__ = "radio_announcement_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_type: Mapped[RadioAnnouncementRuleType]
    n_tracks: Mapped[int | None]
    interval_minutes: Mapped[int | None]
    times_of_day: Mapped[str | None]
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[ScheduleTargetType]
    target_id: Mapped[int]
    schedule_type: Mapped[ScheduleType]
    recurrence_rule: Mapped[str | None]
    run_at: Mapped[datetime | None]
    active: Mapped[bool] = mapped_column(default=True)
    # Canal de diffusion ciblé par cette programmation (réf. mission
    # "tableaux de bord Câblé / Réseau") : "cable" ou "network" — chaque
    # canal a son planning propre, déclenché sur SON état de lecture.
    channel: Mapped[str] = mapped_column(default="cable", server_default="cable")

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
    # Canal dont la lecture a été interrompue/reportée (une action différée
    # en attente PAR canal, réf. mission "tableaux de bord Câblé / Réseau").
    channel: Mapped[str] = mapped_column(default="cable", server_default="cable")
    interrupted_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


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
