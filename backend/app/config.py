import os
import tomllib
from pathlib import Path
from pydantic_settings import BaseSettings

# Repère du dossier racine du backend de l'application (racine de backend/)
ROOT_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # Base de données
    database_url: str = "sqlite:///data/database.db"

    # Chemins des médias et répertoires
    media_dir: str = "data/videos"
    watch_dir: str = "data/watched"
    thumbnails_dir: str = "data/thumbnails"

    # Fonds animés (Lot 7, réf. F9.1) : dossier dédié séparé des cours, avec
    # son propre dossier surveillé plutôt que de partager celui des vidéos —
    # sinon un fond animé déposé par erreur dans le mauvais dossier serait
    # indexé comme un cours (et vice versa).
    backgrounds_dir: str = "data/backgrounds"
    backgrounds_watch_dir: str = "data/backgrounds_watched"

    # Cours audio (Lot 8, réf. F10.1) : MP3 regroupés par cours, dossier
    # surveillé séparé (une sous-fixture par cours y est attendue : voir
    # utils/audio_importer.py).
    audio_dir: str = "data/audio"
    audio_watch_dir: str = "data/audio_watched"

    # Module Radio (réf. docs/cahier-des-charges-radio.md) : sous-système
    # musical indépendant, dossiers séparés des cours audio coach. `radio_dir`
    # = fichiers musique, `radio_covers_dir` = pochettes (extraites ID3 ou
    # uploadées), `radio_announcements_dir` = rappels, `radio_watch_dir` =
    # dossier surveillé d'import musique.
    radio_dir: str = "data/radio"
    radio_covers_dir: str = "data/radio_covers"
    radio_announcements_dir: str = "data/radio_announcements"
    radio_watch_dir: str = "data/radio_watched"

    # Logs (Lot 9.6/13, réf. F8.2/F8.3) : dossier dédié, séparé des données média.
    logs_dir: str = "data/logs"

    # Mode audio coach (Lot 8, réf. F10.3/UX4.8) : réglage par défaut de la
    # minuterie entre pistes en mode "auto + minuterie".
    audio_chain_timer_seconds: int = 20

    # Redis (bus d'état partagé entre workers uvicorn, réf. plan perf/concurrence
    # Phase 1) : synchronisation du PlaybackManager et diffusion WebSocket
    # inter-workers, verrou distribué pour les jobs planifiés.
    redis_url: str = "redis://localhost:6379/0"

    # Réseau & Serveur
    host: str = "0.0.0.0"
    port: int = 8000

    # Paramètres de lecture par défaut
    wait_time_between_courses: int = 10
    volume_default: int = 100

    # Réglages de lecture Radio (réf. docs/cahier-des-charges-radio.md, §9).
    # Consommés par les lots ultérieurs (moteur de lecture L3, crossfade L5,
    # rappels L6, auto-boot L7) ; déclarés ici pour centraliser la config.
    # La playlist d'ambiance par défaut n'est PAS un réglage : c'est la
    # RadioPlaylist marquée `is_default` (cf. models.py).
    radio_volume_default: int = 100
    radio_crossfade_seconds: int = 4
    radio_announcement_duck_level: int = 15   # volume musique (%) pendant un rappel en mode duck
    radio_announcement_fade_ms: int = 1500    # durée du fondu d'entrée/sortie du duck (ms)
    radio_autostart_on_boot: bool = True

    class Config:
        env_prefix = "OPENLESMILLS_"

    @property
    def technical_log_path(self) -> Path:
        return Path(self.logs_dir) / "technical.log"


def load_settings() -> Settings:
    # Chemin potentiel local et global
    local_config = ROOT_DIR / "config.toml"
    global_config = Path("/etc/openlesmillscinema/config.toml")

    # La config de production (/etc) prime sur celle du dépôt (réf. F7.4) :
    # config.toml est versionné avec des valeurs de dev, donc toujours présent
    # après un clone — s'il primait, /etc/openlesmillscinema/config.toml ne
    # servirait jamais une fois le dépôt cloné sur la machine de production.
    config_path = None
    if global_config.exists():
        config_path = global_config
    elif local_config.exists():
        config_path = local_config

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

    # Une variable d'environnement OPENLESMILLS_<CHAMP> doit pouvoir surcharger
    # une valeur du TOML (utilisé par les tests pour isoler leurs données —
    # cf. tests/test_*.py). pydantic-settings ne le fait PAS automatiquement
    # ici : passer le TOML en kwargs explicites à Settings(**flat_config)
    # leur donne la priorité sur les variables d'environnement (comportement
    # par défaut de BaseSettings), ce qui rendait ces surcharges totalement
    # silencieuses en pratique — bug réel retrouvé le 16/07/2026, cause très
    # probable des disparitions de `data/database.db` documentées aux Lots
    # 4/5/6 (un test croyant nettoyer sa propre base isolée en tearDown
    # supprimait en fait la vraie base partagée, faute de surcharge effective
    # de OPENLESMILLS_DATABASE_URL). On retire donc du dict tout champ pour
    # lequel la variable d'environnement correspondante est définie, et on
    # laisse BaseSettings la lire nativement via env_prefix.
    for field_name in list(flat_config.keys()):
        if f"OPENLESMILLS_{field_name.upper()}" in os.environ:
            del flat_config[field_name]

    # Instancier Settings avec les valeurs du TOML (sauf celles surchargées par l'environnement)
    settings = Settings(**flat_config)

    # Résoudre les chemins relatifs par rapport au ROOT_DIR pour le confort de dev
    # sauf si ce sont des chemins absolus
    for path_attr in [
        "media_dir",
        "watch_dir",
        "thumbnails_dir",
        "backgrounds_dir",
        "backgrounds_watch_dir",
        "audio_dir",
        "audio_watch_dir",
        "radio_dir",
        "radio_covers_dir",
        "radio_announcements_dir",
        "radio_watch_dir",
        "logs_dir",
    ]:
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

    _apply_db_overrides(settings)
    return settings


# Réglages modifiables depuis la page Paramètres (Lot 9, réf. UX3.17),
# persistés dans la table `settings` (clé/valeur, cf. §7 cahier fonctionnel)
# au lieu de config.toml : ils doivent survivre à un redémarrage (F7.3) sans
# nécessiter de réécrire le fichier de config.
_DB_OVERRIDABLE_FIELDS = (
    "wait_time_between_courses",
    "volume_default",
    "audio_chain_timer_seconds",
    # Réglages Radio modifiables à chaud (entiers uniquement, cf. mécanisme
    # int() ci-dessous) ; `radio_autostart_on_boot` (bool) reste piloté par
    # config.toml, pas par la table settings.
    "radio_volume_default",
    "radio_crossfade_seconds",
    "radio_announcement_duck_level",
    "radio_announcement_fade_ms",
)


def _apply_db_overrides(settings: "Settings") -> None:
    """
    Relit les surcharges enregistrées via `PUT /api/settings` (table
    `settings`) et les applique par-dessus les valeurs de config.toml.
    Connexion SQLite directe (pas l'ORM) pour éviter un import circulaire
    avec database.py, qui importe déjà `settings` depuis ce module. Échec
    silencieux si la base n'existe pas encore (tout premier démarrage,
    avant le premier `init_db()`) : config.toml fait alors foi, comme prévu.
    """
    if not settings.database_url.startswith("sqlite:///"):
        return
    db_path = Path(settings.database_url[len("sqlite:///"):])
    if not db_path.exists():
        return

    import sqlite3

    try:
        conn = sqlite3.connect(str(db_path))
        try:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return

    overrides = {key: value for key, value in rows if key in _DB_OVERRIDABLE_FIELDS}
    for key, value in overrides.items():
        try:
            setattr(settings, key, int(value))
        except (TypeError, ValueError):
            pass


settings = load_settings()


def reload_settings() -> None:
    global settings
    new_settings = load_settings()
    for field in settings.model_fields:
        if hasattr(new_settings, field):
            setattr(settings, field, getattr(new_settings, field))
