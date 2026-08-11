import logging
import time

from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from app.config import settings
from app.models import Base

logger = logging.getLogger(__name__)

_IS_SQLITE = settings.database_url.startswith("sqlite")

# sqlite engines require connect_args={"check_same_thread": False}
connect_args = {}
if _IS_SQLITE:
    connect_args["check_same_thread"] = False

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    # Avec plusieurs workers uvicorn (réf. plan perf/concurrence Phase 2, P3),
    # chaque processus tient son propre pool de connexions vers le même
    # fichier SQLite : un pool trop petit ferait attendre les requêtes pour
    # rien sur une machine qui a par ailleurs de la marge mémoire.
    pool_size=5,
    max_overflow=5,
    pool_timeout=30,
    pool_recycle=3600,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    """
    Mode WAL (Write-Ahead Logging) : autorise des lectures concurrentes
    pendant une écriture, indispensable dès qu'on a plusieurs workers sur le
    même fichier SQLite (réf. P3). busy_timeout fait patienter une connexion
    en conflit d'écriture jusqu'à 30s au lieu de lever immédiatement
    "database is locked" — la RetryingSession ci-dessous ne sert donc qu'en
    dernier recours, si ce délai est lui-même dépassé.
    """
    if not _IS_SQLITE:
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA cache_size=-64000")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


class RetryingSession(Session):
    """
    Filet de sécurité au-dessus de busy_timeout (réf. P3) : si une écriture
    échoue quand même avec "database is locked" (contention extrême, ou
    busy_timeout dépassé), on retente le commit avec un backoff exponentiel
    court plutôt que de renvoyer une erreur 500 au client pour un conflit
    transitoire. Un seul point d'implémentation pour tous les routers, plutôt
    qu'un décorateur à poser sur chaque endpoint qui commit.
    """

    _MAX_RETRIES = 3
    _BASE_DELAY_SECONDS = 0.2

    def commit(self):
        attempt = 0
        while True:
            try:
                return super().commit()
            except OperationalError as e:
                if not _IS_SQLITE or "locked" not in str(e).lower() or attempt >= self._MAX_RETRIES:
                    raise
                self.rollback()
                delay = self._BASE_DELAY_SECONDS * (2 ** attempt)
                logger.warning(
                    f"Base SQLite verrouillée, nouvelle tentative dans {delay:.1f}s "
                    f"(essai {attempt + 1}/{self._MAX_RETRIES})"
                )
                time.sleep(delay)
                attempt += 1


SessionLocal = sessionmaker(
    autocommit=False, autoflush=False, bind=engine,
    class_=RetryingSession,
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    # Make sure all directories exist (media_dir, watch_dir, thumbnails_dir, ...)
    from pathlib import Path
    for path_str in [
        settings.media_dir,
        settings.watch_dir,
        settings.thumbnails_dir,
        settings.backgrounds_dir,
        settings.backgrounds_watch_dir,
        settings.audio_dir,
        settings.audio_watch_dir,
        settings.logs_dir,
    ]:
        Path(path_str).mkdir(parents=True, exist_ok=True)

    # Create SQLite database file directory if needed
    if settings.database_url.startswith("sqlite:///"):
        db_path = Path(settings.database_url[len("sqlite:///"):])
        db_path.parent.mkdir(parents=True, exist_ok=True)

    _migrate_audio_playlist_items_to_tracks()
    Base.metadata.create_all(bind=engine)
    _migrate_add_missing_columns()


def _migrate_audio_playlist_items_to_tracks():
    """
    `audio_playlist_items` a changé de grain : chaque ligne référençait un
    COURS entier (`audio_course_id`) avant la mission "playlists spéciales
    piste par piste, pas juste des cours entiers collés bout à bout"; le
    modèle référence désormais une PISTE (`audio_track_id`). `create_all` ne
    modifiant jamais une table déjà existante, une base créée avant ce
    changement garde l'ancienne colonne `audio_course_id` (NOT NULL, sans
    `audio_track_id`) et casse tout INSERT/SELECT du nouveau code. Pas de
    mapping automatique possible (un cours correspond à plusieurs pistes) :
    si la table est vide on la recrée avec le nouveau schéma (via
    `create_all` juste après), sinon on n'y touche pas et on log un
    avertissement plutôt que de perdre des données silencieusement.
    """
    from sqlalchemy import text

    if not _IS_SQLITE:
        return

    with engine.connect() as conn:
        tables = {row[0] for row in conn.execute(text(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='audio_playlist_items'"
        ))}
        if "audio_playlist_items" not in tables:
            return

        columns = {row[1] for row in conn.execute(text("PRAGMA table_info(audio_playlist_items)"))}
        if "audio_track_id" in columns:
            return

        count = conn.execute(text("SELECT COUNT(*) FROM audio_playlist_items")).scalar()
        if count:
            logger.warning(
                f"Migration audio_playlist_items impossible : {count} ligne(s) existante(s) "
                "avec l'ancien schéma (audio_course_id) et aucune correspondance automatique "
                "vers audio_track_id — laissées telles quelles."
            )
            return

        conn.execute(text("DROP TABLE audio_playlist_items"))
        conn.commit()
        logger.info("Migration : table audio_playlist_items recréée avec le schéma piste par piste")


def _migrate_add_missing_columns():
    """
    Micro-migration en place (pas d'Alembic actif dans ce projet) :
    `create_all` ne modifie jamais une table existante, donc les colonnes
    ajoutées après coup au schéma doivent être créées par ALTER TABLE sur les
    bases déjà en production. Idempotent : ne fait rien si la colonne existe.

    Le check-then-act ci-dessous (PRAGMA table_info puis ALTER TABLE) n'est
    PAS atomique : avec plusieurs workers uvicorn qui démarrent en même temps
    (réf. constat en production, `--workers 4`) et appellent chacun cette
    fonction, deux workers peuvent tous les deux constater l'absence d'une
    colonne avant qu'aucun des deux n'ait eu le temps de l'ajouter — le second
    ALTER TABLE échoue alors avec "duplicate column name" et fait planter tout
    son worker au démarrage (`Application startup failed. Exiting.`). Chaque
    ALTER TABLE est donc protégé individuellement : une collision concurrente
    signifie qu'un AUTRE worker a gagné la course et a déjà ajouté la même
    colonne — inoffensif, on l'ignore silencieusement plutôt que de laisser
    planter le worker perdant.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    if not _IS_SQLITE:
        return

    # (table, colonne, définition SQL) — canal de diffusion par programmation
    # et par action différée (réf. mission "tableaux de bord Câblé / Réseau").
    wanted = [
        ("schedules", "channel", "VARCHAR NOT NULL DEFAULT 'cable'"),
        ("playback_state", "channel", "VARCHAR NOT NULL DEFAULT 'cable'"),
        # target_type/target_id (cause "coach_priority", réf. F10.7 mode audio
        # coach) présents dans le modèle depuis le Lot 6 mais absents de cette
        # liste jusqu'ici : sur toute base créée avant leur ajout au modèle,
        # `create_all` ne les ajoute jamais (il ne modifie pas les tables
        # existantes), ce qui cassait silencieusement toute lecture de
        # PlaybackState avec "no such column: playback_state.target_type".
        ("playback_state", "target_type", "VARCHAR"),
        ("playback_state", "target_id", "INTEGER"),
        # Fond d'ambiance par piste de playlist audio (réf. mission "associer
        # un fond animé à chaque musique qui se jouera en arrière plan").
        ("audio_playlist_items", "background_id", "INTEGER REFERENCES backgrounds(id)"),
    ]
    with engine.connect() as conn:
        for table, column, ddl in wanted:
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column in existing:
                continue
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                conn.commit()
                logger.info(f"Migration : colonne {table}.{column} ajoutée")
            except OperationalError as e:
                conn.rollback()
                if "duplicate column name" not in str(e).lower():
                    raise
                logger.info(
                    f"Migration : colonne {table}.{column} déjà ajoutée par un autre worker, ignoré"
                )


def reset_database_connection(new_url: str):
    """
    Permet de réinitialiser dynamiquement la connexion SQL (principalement pour
    isoler les bases SQLite de chaque suite de tests au sein du même processus pytest).
    """
    import os
    from app.config import reload_settings, settings
    os.environ["OPENLESMILLS_DATABASE_URL"] = new_url
    reload_settings()

    global engine, SessionLocal, _IS_SQLITE
    resolved_url = settings.database_url
    _IS_SQLITE = resolved_url.startswith("sqlite")
    connect_args = {}
    if _IS_SQLITE:
        connect_args["check_same_thread"] = False

    engine = create_engine(
        resolved_url,
        connect_args=connect_args,
        pool_size=5,
        max_overflow=5,
        pool_timeout=30,
        pool_recycle=3600,
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        if not _IS_SQLITE:
            return
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-64000")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    SessionLocal.configure(
        bind=engine
    )

