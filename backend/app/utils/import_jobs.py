import json
import logging
import time
import uuid

import redis as redis_sync

from app.config import settings

logger = logging.getLogger(__name__)

# Suivi de file d'import (réf. mission "voir en direct les importations et
# l'estimation d'où elles en sont") : les imports (upload web ET dossier
# surveillé) tournent sur des exécuteurs partagés par tous les workers
# uvicorn (app.utils.executors) — un état en mémoire Python ne serait visible
# QUE du worker qui a reçu la requête d'upload, alors que la page qui affiche
# la file peut interroger n'importe lequel des 4 workers. Même stratégie que
# les verrous ffmpeg/tick déjà présents dans l'app : Redis comme état
# partagé, client SYNCHRONE (ces fonctions sont appelées depuis les threads
# des exécuteurs, pas depuis une coroutine async).
JOB_INDEX_KEY = "import_jobs:index"
JOB_KEY_PREFIX = "import_job:"

# Le réencodage le plus long observé en production a dépassé 15 min (cf.
# FFMPEG_NORMALIZE_TIMEOUT_SECONDS = 1800 dans video_utils.py) : la tâche doit
# rester visible en Redis largement au-delà, sans quoi elle "disparaîtrait"
# de la file en cours de traitement.
ACTIVE_TTL_SECONDS = 3600
# Une tâche terminée (succès ou erreur) reste visible quelques minutes pour
# que l'utilisateur voie le résultat, puis s'efface d'elle-même — pas besoin
# de nettoyage explicite.
DONE_TTL_SECONDS = 300

_STAGE_LABELS = {
    "queued": "En attente",
    "probing": "Analyse du fichier",
    "normalizing": "Réencodage",
    "copying": "Déplacement du fichier",
    "thumbnail": "Génération de la miniature",
    "extracting": "Extraction de l'archive",
    "saving": "Enregistrement",
    "done": "Terminé",
    "error": "Échec",
}

_client: "redis_sync.Redis | None" = None


def _get_client() -> "redis_sync.Redis":
    global _client
    if _client is None:
        _client = redis_sync.Redis.from_url(settings.redis_url, decode_responses=True)
    return _client


def create_job(kind: str, filename: str, title: str | None = None, source: str = "upload") -> str:
    """Enregistre une nouvelle tâche d'import (stage initial "queued") et
    retourne son identifiant. Appelé AVANT de soumettre le travail réel à
    l'exécuteur, pour que la tâche apparaisse dans la file dès son
    acceptation plutôt qu'à son démarrage effectif."""
    job_id = uuid.uuid4().hex
    now = time.time()
    job = {
        "id": job_id,
        "kind": kind,  # "video" | "background" | "audio"
        "source": source,  # "upload" | "watched_folder"
        "filename": filename,
        "title": title,
        "stage": "queued",
        "stage_label": _STAGE_LABELS["queued"],
        "error": None,
        "result_id": None,
        "created_at": now,
        "updated_at": now,
    }
    _save(job_id, job, ttl=ACTIVE_TTL_SECONDS)
    try:
        _get_client().zadd(JOB_INDEX_KEY, {job_id: now})
    except Exception as e:
        logger.warning(f"Suivi de file d'import indisponible (Redis) pour {job_id}: {e}")
    return job_id


def update_job(job_id: str | None, **fields) -> None:
    """Met à jour les champs fournis d'une tâche existante (no-op silencieux
    si `job_id` est None — permet aux fonctions d'import de rester utilisables
    sans job à suivre, ex. import déclenché depuis les tests) et sans jamais
    lever (un accroc Redis ici ne doit pas faire échouer l'import lui-même,
    même compromis que les verrous ffmpeg/tick)."""
    if not job_id:
        return
    job = get_job(job_id)
    if job is None:
        return
    job.update(fields)
    if "stage" in fields:
        job["stage_label"] = _STAGE_LABELS.get(fields["stage"], fields["stage"])
    job["updated_at"] = time.time()
    ttl = DONE_TTL_SECONDS if job.get("stage") in ("done", "error") else ACTIVE_TTL_SECONDS
    _save(job_id, job, ttl=ttl)


def get_job(job_id: str) -> dict | None:
    try:
        raw = _get_client().get(JOB_KEY_PREFIX + job_id)
    except Exception as e:
        logger.warning(f"Lecture de la tâche d'import {job_id} indisponible (Redis) : {e}")
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def list_jobs() -> list[dict]:
    """Tâches d'import récentes (en cours, ou terminées depuis moins de
    DONE_TTL_SECONDS), triées par ordre de création. Calcule aussi une
    `queue_position` (réf. mission "estimation d'où elles en sont") : nombre
    de tâches non terminées créées avant celle-ci — une ESTIMATION, pas la
    position exacte dans le verrou global ffmpeg (qui arbitre le vrai tour de
    rôle entre workers, cf. video_utils._global_ffmpeg_lock)."""
    try:
        client = _get_client()
        job_ids = client.zrange(JOB_INDEX_KEY, 0, -1)
    except Exception as e:
        logger.warning(f"Liste des tâches d'import indisponible (Redis) : {e}")
        return []

    jobs = []
    stale_ids = []
    for job_id in job_ids:
        job = get_job(job_id)
        if job is None:
            # Expiré (TTL écoulé) ou jamais écrit correctement : purge de l'index.
            stale_ids.append(job_id)
            continue
        jobs.append(job)
    if stale_ids:
        try:
            client.zrem(JOB_INDEX_KEY, *stale_ids)
        except Exception:
            pass

    pending = [j for j in jobs if j["stage"] not in ("done", "error")]
    for idx, job in enumerate(pending):
        job["queue_position"] = idx

    return jobs


def _save(job_id: str, job: dict, ttl: int) -> None:
    try:
        _get_client().set(JOB_KEY_PREFIX + job_id, json.dumps(job), ex=ttl)
    except Exception as e:
        logger.warning(f"Écriture de la tâche d'import {job_id} indisponible (Redis) : {e}")
