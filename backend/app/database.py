from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings
from app.models import Base

# sqlite engines require connect_args={"check_same_thread": False}
connect_args = {}
if settings.database_url.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(
    settings.database_url, connect_args=connect_args
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    # Make sure all directories exist (media_dir, watch_dir, thumbnails_dir)
    from pathlib import Path
    for path_str in [settings.media_dir, settings.watch_dir, settings.thumbnails_dir]:
        Path(path_str).mkdir(parents=True, exist_ok=True)
    
    # Create SQLite database file directory if needed
    if settings.database_url.startswith("sqlite:///"):
        db_path = Path(settings.database_url[len("sqlite:///"):])
        db_path.parent.mkdir(parents=True, exist_ok=True)

    Base.metadata.create_all(bind=engine)
