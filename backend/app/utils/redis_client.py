import asyncio
import logging

import redis.asyncio as redis

from app.config import settings

logger = logging.getLogger(__name__)

_redis: redis.Redis | None = None
_redis_loop: asyncio.AbstractEventLoop | None = None


def get_redis() -> redis.Redis:
    """
    Client Redis async partagé entre tous les modules d'un même worker.
    Connexion paresseuse : le pool de connexions de redis-py se (re)connecte
    tout seul à la demande, pas besoin de logique de reconnexion manuelle ici.

    Le client est recréé si la boucle asyncio courante a changé depuis sa
    création : ses connexions y sont attachées et deviennent inutilisables
    ("Event loop is closed") sinon. En production (un seul worker uvicorn =
    une seule boucle pour toute la durée de vie du processus) ceci ne se
    déclenche jamais ; ça évite en revanche un client mort dans les tests,
    qui démarrent une nouvelle boucle asyncio par méthode de test.

    `get_running_loop()` plutôt que le `get_event_loop()` déprécié (obsolète
    depuis Python 3.10, qui en crée une silencieusement hors contexte async
    au lieu de lever une erreur claire) : cette fonction n'est appelée que
    depuis des méthodes async (aucun appel synchrone dans le code — vérifié),
    une boucle est donc toujours déjà en cours d'exécution ici.
    """
    global _redis, _redis_loop
    current_loop = asyncio.get_running_loop()
    if _redis is not None and _redis_loop is not current_loop:
        _redis = None
    if _redis is None:
        _redis = redis.Redis.from_url(settings.redis_url, decode_responses=True)
        _redis_loop = current_loop
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
