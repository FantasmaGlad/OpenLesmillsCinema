from concurrent.futures import ThreadPoolExecutor

# Exécuteur mono-thread PARTAGÉ entre TOUS les chemins d'import qui appellent
# ffmpeg pour de vrai — dossier surveillé ET upload web, vidéos et fonds
# animés confondus (réf. audit plan-corrections-bugs, point 5 : l'upload web
# appelait auparavant ffmpeg directement dans le thread de la requête, hors
# de tout contrôle, avec le risque qu'un upload et un import watcher lancent
# deux `ffmpeg` en parallèle sur le CPU modeste du Wyse 5070). Un seul point
# de définition pour toute l'application : `watcher.py` et les routers
# d'upload importent tous ce module plutôt que de créer leur propre exécuteur.
ffmpeg_executor = ThreadPoolExecutor(max_workers=1)

# Exécuteur séparé pour les imports qui n'appellent pas ffmpeg pour
# transcoder (ffprobe seul, quasi instantané) — dominé par l'I/O disque, pas
# par le CPU, donc sans intérêt à passer par l'exécuteur mono-thread ci-dessus.
io_executor = ThreadPoolExecutor(max_workers=2)
