import logging

from app.utils.redis_client import get_redis

logger = logging.getLogger(__name__)


async def acquire_tick_lock(key: str, ttl_ms: int) -> bool:
    """
    Verrou distribué Redis à grain fin pour une tâche périodique locale
    (attente entre deux vidéos d'une playlist, minuteur, chaînage audio —
    réf. correctif "aucune de ces tâches n'a l'équivalent du verrou de
    déclenchement Redis utilisé pour le planning").

    Contrairement au planning (un seul tir ponctuel par occurrence), ces
    tâches tournent en continu tant qu'un worker les fait vivre en mémoire —
    mais RIEN n'empêchait jusqu'ici deux workers d'avoir chacun une copie de
    la MÊME tâche active en même temps (ex. reprise d'une attente inter-cours
    après le crash du worker qui la faisait tourner) : chacun émettrait alors
    son propre tick à la même seconde, faisant défiler le décompte plusieurs
    fois trop vite. Un SET NX PX court
    (légèrement supérieur à l'intervalle réel entre deux ticks) garantit
    qu'un seul worker agit par tick ; les autres constatent le verrou déjà
    pris et s'abstiennent silencieusement pour CE tour — leur état local est
    de toute façon rattrapé par la diffusion du worker gagnant
    (apply_remote_state), pas besoin d'agir en double pour rester à jour.

    Si Redis est injoignable, on laisse passer (même compromis que le verrou
    de déclenchement du planning) : mieux vaut un tick en double occasionnel
    qu'un minuteur/une playlist qui ne progresse plus.
    """
    try:
        acquired = await get_redis().set(key, "1", nx=True, px=ttl_ms)
        return bool(acquired)
    except Exception as e:
        logger.warning(f"Verrou de tick Redis indisponible pour '{key}', exécution locale sans dédoublonnage : {e}")
        return True
