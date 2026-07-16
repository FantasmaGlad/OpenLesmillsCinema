import os
import tomllib
from pathlib import Path
from pydantic_settings import BaseSettings

# Repère du dossier racine de l'application
ROOT_DIR = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    # Base de données
    database_url: str = "sqlite:///data/database.db"

    # Chemins des médias et répertoires
    media_dir: str = "data/videos"
    watch_dir: str = "data/watched"
    thumbnails_dir: str = "data/thumbnails"

    # Réseau & Serveur
    host: str = "0.0.0.0"
    port: int = 8000

    # Paramètres de lecture par défaut
    wait_time_between_courses: int = 10
    countdown_seconds: int = 5
    volume_default: int = 100

    class Config:
        env_prefix = "OPENLESMILLS_"


def load_settings() -> Settings:
    # Chemin potentiel local et global
    local_config = ROOT_DIR / "config.toml"
    global_config = Path("/etc/openlesmillscinema/config.toml")

    config_path = None
    if local_config.exists():
        config_path = local_config
    elif global_config.exists():
        config_path = global_config

    config_data = {}
    if config_path:
        try:
            with open(config_path, "rb") as f:
                config_data = tomllib.load(f)
        except Exception as e:
            print(f"Erreur lors du chargement de la configuration TOML: {e}")

    # Aplatir le fichier TOML imbriqué si nécessaire
    flat_config = {}
    for section_key, section_val in config_data.items():
        if isinstance(section_val, dict):
            for k, v in section_val.items():
                flat_config[k] = v
        else:
            flat_config[section_key] = section_val

    # Instancier Settings avec les valeurs du TOML
    settings = Settings(**flat_config)

    # Résoudre les chemins relatifs par rapport au ROOT_DIR pour le confort de dev
    # sauf si ce sont des chemins absolus
    for path_attr in ["media_dir", "watch_dir", "thumbnails_dir"]:
        path_str = getattr(settings, path_attr)
        path = Path(path_str)
        if not path.is_absolute():
            setattr(settings, path_attr, str((ROOT_DIR / path).resolve()))

    # Pour la base SQLite relative
    if settings.database_url.startswith("sqlite:///"):
        db_path_str = settings.database_url[len("sqlite:///"):]
        db_path = Path(db_path_str)
        if not db_path.is_absolute():
            settings.database_url = f"sqlite:///{(ROOT_DIR / db_path).resolve()}"

    return settings


settings = load_settings()
