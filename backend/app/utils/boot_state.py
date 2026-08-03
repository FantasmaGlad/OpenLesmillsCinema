import os


def current_boot_id() -> str:
    """
    Identifiant stable du superviseur uvicorn courant : PID du processus
    parent + son instant de démarrage (champ 22 de /proc/<pid>/stat, en ticks
    d'horloge depuis le boot) pour se prémunir d'une réutilisation de PID.
    Tous les workers d'un même `systemctl start` partagent ce même parent ;
    après un restart du service, le parent change, donc l'identifiant aussi.

    Partagé entre PlaybackManager et TimerManager (réf. correctif "le
    minuteur n'a aucune persistance Redis, contrairement à PlaybackManager") :
    les deux ont besoin de la même distinction "redémarrage complet du
    service" (état temporaire à purger) vs "un seul worker relancé par le
    superviseur au sein du même lancement" (état à reprendre tel quel).
    """
    ppid = os.getppid()
    starttime = "0"
    try:
        with open(f"/proc/{ppid}/stat") as f:
            # Le nom du processus (champ 2) peut contenir espaces/parenthèses :
            # on repart de la dernière ')' avant de découper les champs suivants.
            fields = f.read().rsplit(")", 1)[1].split()
        starttime = fields[19]
    except (OSError, IndexError):
        pass
    return f"{ppid}:{starttime}"


# Clé Redis partagée marquant le dernier boot_id connu (réf. current_boot_id
# ci-dessus) : quiconque (PlaybackManager ou TimerManager, sur n'importe quel
# worker) la trouve différente de la sienne est le premier à détecter un
# nouveau lancement de service, la met à jour, et purge SON PROPRE état
# temporaire — l'opération est idempotente si plusieurs managers/workers s'en
# aperçoivent en même temps.
BOOT_ID_REDIS_KEY = "playback:boot_id"
