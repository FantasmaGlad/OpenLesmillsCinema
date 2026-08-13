# Bobine

Diffusion, planification et pilotage de vidéos de cours en salle, sur mini PC dédié. Serveur multi-worker FastAPI + Redis + SQLite, kiosque Chromium X11, interface d'administration et télécommande mobile Next.js.

Ce document est écrit pour quiconque souhaite **comprendre, exploiter, modifier ou déployer** le système Bobine : il décrit l'architecture réellement en place (pas une intention), le contrat réseau, le modèle de données inter-workers, ainsi que la configuration d'exploitation sur mini PC dédié.

---

## Sommaire

1. [Stack et démarrage](#1-stack-et-démarrage)
2. [Architecture générale (Multi-worker & Bus Redis)](#2-architecture-générale)
3. [Modèle de données & Persistance SQLite](#3-modèle-de-données--persistance-sqlite)
4. [Canaux de diffusion & Gestionnaire de lecture](#4-canaux-de-diffusion--gestionnaire-de-lecture)
5. [Module Radio](#5-module-radio)
6. [Mode Audio Coach & Fonds animés](#6-mode-audio-coach--fonds-animés)
7. [Script d'installation & Services systemd](#7-script-dinstallation--services-systemd)
8. [Référence API HTTP & WebSockets](#8-référence-api-http--websockets)
9. [Exploitation & Découverte Réseau (Wyse)](#9-exploitation--découverte-réseau-wyse)
10. [Licence](#10-licence)

---

## 1. Stack et démarrage

### Stack technique

- **Backend** : Python 3.11+, [FastAPI](https://fastapi.tiangolo.com/) + `uvicorn` (4 workers), [SQLAlchemy](https://www.sqlalchemy.org/), SQLite (`data/database.db`), Redis (bus d'état Pub/Sub, verrous distribués), `APScheduler` (planification), `watchdog` (surveillance des dossiers d'import), `ffmpeg` / VAAPI (décodage matériel Intel), Web Audio API (crossfade radio, côté navigateur).
- **Frontend** : [Next.js](https://nextjs.org/) 16 (App Router, export statique servi par le backend en production), React 19, TypeScript, CSS Vanilla (global + design tokens, **13 thèmes de couleurs** commutables à chaud via `:root[data-theme=…]`), PWA (`manifest.json`), WebSockets, glisser-déposer natif (HTML5), Web Audio API.
- **Exploitation & Kiosque** : Debian 13 (Trixie), Chromium en mode kiosque (X11 / `xinit`), `systemd` (services backend, kiosque, garde audio), `avahi-daemon` (découverte mDNS).

### Développements locaux

**Préréquis** : Node.js ≥ 20, Python ≥ 3.11, Redis local actif.

```bash
# 1. Backend (FastAPI + Redis) — port 8001 en dev (voir note ci-dessous)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
redis-server &          # requis : bus d'état partagé
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001

# 2. Frontend (Next.js)
cd frontend
npm install
npm run dev             # accessible sur http://localhost:3000
```

> **Quirk de dev (port)** : servi par `next dev` sur `:3000`, le frontend route ses appels API/WebSocket vers `localhost:8001` (cf. `getApiUrl`/`getWsUrl`) — d'où le backend sur **8001** en développement. Alternative sans ce décalage, pratique pour vérifier le rendu réel : `cd frontend && npm run build` (export statique dans `frontend/out`) puis lancer le backend sur `:8000` — il sert lui-même `frontend/out` à `/` (même origine `/api`), il suffit alors de naviguer sur `http://localhost:8000/<route>/`.

**Validation rapide avant commit** :

```bash
# Vérification de syntaxe Python (AST)
backend/.venv/bin/python -c "import ast; ast.parse(open('backend/app/main.py').read())"

# Vérification du typage Frontend (TypeScript)
cd frontend && npx tsc --noEmit
```

### Configuration (`config.toml`)

La configuration est chargée selon l'ordre de priorité suivant :
1. Variables d'environnement préfixées `BOBINE_` (priorité maximale).
2. `/etc/bobine/config.toml` (production, écrit par `install.sh`).
3. `config.toml` à la racine du dépôt (développement).

| Clé | Défaut | Rôle |
|---|---|---|
| `database.database_url` | `sqlite:///data/database.db` | URL de connexion SQLite |
| `redis.redis_url` | `redis://localhost:6379/0` | URL du bus d'état Redis |
| `media.media_dir` | `data/videos` | Stockage des vidéos importées |
| `media.watch_dir` | `data/watched` | Dossier surveillé pour import automatique |
| `server.host` / `port` | `0.0.0.0:8000` | Écoute HTTP du backend |
| `playback.wait_time_between_courses` | `10` | Délai d'inter-cours (s) |
| `playback.volume_default` | `100` | Volume par défaut (0-100) |

> **Fichiers temporaires d'upload** : le backend force `tempfile.tempdir` sur `data/tmp` (à côté des médias) au démarrage, au lieu de `/tmp`. Sur le Wyse, `/tmp` est un tmpfs en RAM (~3,8 Go) qu'un gros import vidéo/audio saturait (`OSError: No space left on device`, remonté côté client en « There was an error parsing the body ») alors que le disque média a des dizaines de Go libres.

---

## 2. Architecture générale

```
┌─────────────┐      HTTP / WebSockets      ┌─────────────────────────────────┐
│  Frontend   │ ───────────────────────────►│        Backend FastAPI          │
│  Next.js    │                             │    (uvicorn, 4 workers)         │
│ (Kiosque /  │◀─────────────────────────── │  app/routers/* → playback_mgr   │
│  Admin /    │                             └─────────────────────────────────┘
│ Mobile Remote)│                                    │               │
└─────────────┘                                    │               │
                                                   ▼               ▼
                                          ┌──────────────┐ ┌──────────────┐
                                          │    SQLite    │ │    Redis     │
                                          │ (database.db)│ │ (Pub/Sub &   │
                                          └──────────────┘ │  State Bus)  │
                                                           └──────────────┘
```

Le backend tourne en plusieurs workers `uvicorn` sous le même processus maître. Redis sert de **bus d'état partagé** (position de lecture, décompte inter-cours, verrous de tick `tick_lock.py`, synchronisation de planning) et de canal de diffusion Pub/Sub pour les WebSockets. Un client web reste parfaitement synchronisé quel que soit le worker traitant la requête HTTP.

### Arborescence backend (`backend/app/`)

- `main.py` : Entrée de l'application FastAPI, initialisation des routes, des événements de démarrage (`boot_state.py`) et du serveur d'assets statiques.
- `playback_manager.py` : Moteur de lecture multi-canal câblé/réseau (gestion de l'état `PLAYING`, `PAUSED`, `IDLE`, minutage et reprise).
- `radio_manager.py` : Moteur de lecture du canal Radio (§5) — état INDÉPENDANT de `playback_manager.py` (playlist de morceaux, pas vidéo/cours), même connexion WebSocket.
- `scheduler_manager.py` : Gestionnaire `APScheduler` de la programmation horaire (récurrences, détections de conflits, décalages, fenêtres radio).
- `models.py` : Déclarations SQLAlchemy ORM.
- `config.py` : Gestionnaire de configuration dynamique.
- `routers/` : Endpoints HTTP groupés par domaine (`videos`, `backgrounds`, `playlists`, `audio`, `audio_playlists`, `schedule`, `playback`, `settings`, `logs`, `import_jobs`, `radio`, `radio_playlists`, `radio_announcements`).

---

## 3. Modèle de données & Persistance SQLite

Le schéma de données est géré par **SQLAlchemy**. Il n'y a **pas d'Alembic actif** dans ce projet (dossier `alembic/versions/` vide) : les tables sont créées par `Base.metadata.create_all()` au démarrage, et l'ajout de colonnes sur des tables existantes passe par des micro-migrations idempotentes dans `database.py::_migrate_add_missing_columns`. Stockage dans un fichier SQLite unique (`data/database.db`).

### Entités principales

- `videos` / `backgrounds` : Métadonnées des médias (durée, résolution, codec, vignettes générées dans `data/thumbnails`).
- `playlists` & `playlist_items` : Playlists de cours vidéo ordonnées.
- `audio_courses` & `audio_tracks` : Cours audio importés et leurs pistes associées.
- `audio_playlists` & `audio_playlist_items` : Éditions mixées audio coach avec attribution de fond visuel par piste.
- `schedules` & `schedule_overrides` : Programmations récurrentes ou ponctuelles, avec gestion des exceptions d'occurrences (annulation, remplacement).
- `playback_state` : État de lecture persisté par canal (*Câblé* et *Réseau*), incluant la sauvegarde des actions interrompues pour la reprise automatique.
- `settings` : Clés/valeurs des paramètres modifiables à chaud depuis l'interface admin.
- `activity_log` : Journal des événements fonctionnels et techniques du système.
- `radio_tracks`, `radio_tags`, `radio_playlists` & `radio_playlist_items` : Bibliothèque musicale et playlists du module Radio (§5) — sous-système indépendant des cours vidéo/audio coach.
- `radio_announcements` & `radio_announcement_rules` : Rappels de bienséance (annonces) et leurs règles de déclenchement.

---

## 4. Canaux de diffusion & Gestionnaire de lecture

Le système pilote deux canaux de diffusion vidéo **strictement indépendants**, plus un 3ᵉ canal musical (§5) :

1. **Canal Câblé (`channel=cable`)** : Canal d'affichage principal relié à la sortie vidéo physique du mini PC (écran salle / kiosque).
2. **Canal Réseau (`channel=network`)** : Canal secondaire destiné à la diffusion réseau ou aux écrans auxiliaires.
3. **Canal Radio (`channel=radio`)** : 3ᵉ canal, totalement indépendant des deux premiers (aucune interaction) — diffusion musicale continue sur un poste dédié. Géré par un gestionnaire d'état séparé (`radio_manager.py`), pas le `playback_manager` ci-dessous.

Chaque écran affiche `/kiosk` ou `/cinema` selon la sortie choisie par l'admin (`/api/settings/display-output`, ex. câble → `cinema`, réseau → `kiosk`). L'écran câblé (`127.0.0.1`, détecté par `isWiredDisplay()`) suit toujours sa sortie stockée. **Bibliothèque vide** : `/cinema` affiche un écran d'attente plein écran (grand logo + heure + « Aucun cours disponible ») au lieu d'un écran noir ; `/kiosk` a son propre écran d'attente (horloge + prochain cours). Les **catégories de cours** sont des libellés **libres** (plus de RPM/Sprint/The Trip figés) : saisie avec suggestions des catégories déjà utilisées, filtre et regroupement dynamiques.

### Reprise après interruption (Resilience Rule)

Lorsqu'une programmation automatique (`scheduler`) doit démarrer alors qu'une lecture manuelle est en cours :
1. Le `playback_manager` interrompt la lecture manuelle et sauvegarde la position exacte et l'identifiant du média dans `playback_state`.
2. Le cours programmé s'exécute.
3. À la fin de la programmation, l'interface propose automatiquement la **reprise à la seconde près** du cours interrompu.

---

## 5. Module Radio

Sous-système musical « type Spotify » **totalement indépendant** des cours vidéo/audio coach (canal `radio` dédié, tables `radio_*`, gestionnaire d'état `radio_manager.py`) — bibliothèque, playlists, lecture continue, crossfade et rappels sonores. Cahier des charges complet, décisions et découpage en lots : [`docs/cahier-des-charges-radio.md`](docs/cahier-des-charges-radio.md).

- **Surfaces** : `/radio` (écran du poste dédié — affichage + contrôles, ouvert à la main dans un navigateur, pas de service kiosk systemd), onglet admin « Radio » (télécommande à distance sur `/radio-remote`), « Piste Audio Radio » (bibliothèque sur `/radio-library`), « Rappels » (annonces sur `/radio-announcements`), et un 3ᵉ onglet « Radio » sur la page Planning (`/schedule/?channel=radio`). Hors diffusion (écran d'attente + overlay « Démarrer la radio »), le poste affiche un **grand logo plein écran** (fond opaque du thème) ; déverrouiller le poste **ne lance aucune musique** tant qu'aucune radio n'est réellement active (état `idle`), pour ne pas désynchroniser l'interface admin.
- **Bibliothèque** : import tous formats audio (transcodage automatique de ce que le navigateur ne lit pas), pochettes extraites (ID3) ou manuelles, navigation par artiste/album/tags. L'écran admin « Piste Audio Radio » (`/radio-library`) est une **vue d'ensemble** : barre latérale de filtres (playlists / tags / genres / artistes), grille à sélection multiple avec actions groupées (taguer, ajouter à une playlist), tags éditables en chips, éditeur de playlist en glisser-déposer.
- **Lecture** : continue, file d'attente, lecture aléatoire, répétition (piste/playlist), **crossfade** (Web Audio API — deux `<audio>` routés dans un graphe `MediaElementAudioSourceNode → GainNode → destination`, fondu démarré côté client en avance sur la confirmation serveur).
- **Rappels** : annonces de bienséance avec description, règles de déclenchement (toutes les N musiques / toutes les X minutes / à heures fixes / manuel), insertion en attente de fin de piste ou par fondu immédiat (« duck » — réutilise le même graphe Web Audio que le crossfade). Chaque rappel est **normalisé en loudness à l'import** (`ffmpeg loudnorm` EBU R128, 2 passes, cible -10 LUFS) pour s'entendre au moins aussi fort que la musique. Écran d'admin dédié (`/radio-announcements`) : import, activation, règles, déclenchement manuel.
- **24/7 & Planning** : une playlist marquée par défaut tourne en boucle en permanence ; auto-démarrage au boot (`radio_autostart_on_boot`) ; le Planning peut y superposer des fenêtres horaires récurrentes (option 24/7) qui reviennent automatiquement à l'ambiance par défaut en fin de fenêtre.
- **Config** (`radio_dir`, `radio_covers_dir`, `radio_announcements_dir`, `radio_watch_dir`, `radio_volume_default`, `radio_crossfade_seconds`, `radio_announcement_duck_level`, `radio_announcement_fade_ms`, `radio_autostart_on_boot`) : voir `config.py` — dossiers unifiés sous `${REPO_DIR}/data` par `install.sh` comme le reste des médias.

---

## 6. Mode Audio Coach & Fonds animés

Le mode **Audio Coach** permet de diffuser des cours audio (pistes vocales / musique) sur l'équipement sonore de la salle tout en affichant un fond visuel dynamique sur l'écran.

- **Importation** : Support des fichiers MP3 individuellement ou par paquets ZIP.
- **Fonds animés** : Boucles vidéo stockées dans `data/backgrounds` (arbre média unifié sous `${REPO_DIR}/data`), jouées en boucle infinie sans coupure.
- **Minuteur d'enchaînement (`audio_chain_timer_seconds`)** : Délai de transition configurable entre deux pistes audio (modifiable depuis `/api/settings`).
- **Lancement** : une playlist audio coach se lance depuis la page « Cours Audio » (`/audio`, actif uniquement quand le câblé est **déjà** en mode coach — sinon on passe d'abord par « Passer en mode coach » / `/coach`) ou directement depuis l'écran mobile `/coach`. Le raccourci autrefois présent sur le tableau de bord câblé a été déplacé ici.

---

## 7. Script d'installation & Services systemd

L'installation de production s'effectue via le script shell idempotent `install.sh` sur Debian 13 (Trixie).

```bash
# Installation complète sur la machine cible
sudo ./install.sh
```

### Options d'installation (`sudo ./install.sh --help`)

| Option | Description |
|---|---|
| `--no-kiosk` | Installation du backend seul (sans Chromium X11 / audio) |
| `--dry-run` | Prévisualisation des actions sans modification |
| `--check` | Diagnostic de l'installation existante |
| `--skip-packages` | Mise à jour du projet (après déploiement du code, §9) sans réinstaller les paquets `apt` |
| `--skip-build` | Ne reconstruit pas le frontend Next.js |
| `--uninstall [--purge] [--purge-data]` | Désinstallation progressive du système |

### Services Systemd créés

- `bobine-backend.service` : API FastAPI Uvicorn sur le port 8000 (4 workers).
- `bobine-kiosk.service` : Mode Kiosque Chromium plein écran sur `xinit` (X11).
- `bobine-audio-guard.service` : Watchdog de surveillance du système et de l'audio (silence hors session kiosque).
- `bobine-redirect.service` : Redirection nftables du port 80 vers 8000.

Pas de service dédié pour le canal Radio (arbitrage A5, cf. §5) : `/radio` s'ouvre à la main dans un navigateur, sur le même backend.

### Autorisation sudo restreinte & désinstallation depuis l'interface

`install.sh` écrit `/etc/sudoers.d/bobine` autorisant **sans mot de passe, et uniquement**, deux actions déclenchées depuis l'admin :

- le **redémarrage** des services (`systemctl restart`) — bouton « Synchronisation des écrans » (Paramètres → Maintenance) : chaque écran connecté **vide son cache navigateur** puis se recharge (re-télécharge les nouveaux assets), et le backend + le kiosque sont relancés. À utiliser après une mise à jour des médias ou en cas de comportement bloqué ;
- l'enveloppe de **désinstallation** `/usr/local/sbin/bobine-uninstall` — bouton « Désinstaller » (Paramètres → **Zone de danger**). L'enveloppe détache la remise à zéro via `systemd-run` (pour survivre à l'arrêt du service backend) puis exécute `install.sh --uninstall --purge --purge-data -y` : arrêt/suppression des services + config `/etc` + application + venv + **toutes les données** (les paquets `apt` partagés sont conservés). L'UI exige de recopier la phrase « DÉSINSTALLER » ; hors machine installée (poste de dev), l'endpoint refuse proprement.

---

## 8. Référence API HTTP & WebSockets

### Endpoints HTTP (`/api`)

| Domaine | Préfixe | Description |
|---|---|---|
| **Vidéos** | `/api/videos` | Import, liste, détail, normalisation, suppression et catégories distinctes (`/videos/programs`) |
| **Playlists Vidéo** | `/api/playlists` | Gestion des playlists vidéo (CRUD, relecture) |
| **Fonds Animés** | `/api/backgrounds` | Gestion de la bibliothèque de boucles visuelles |
| **Audio Coach** | `/api/audio` | Import de cours audio (MP3/ZIP), gestion des pistes |
| **Playlists Audio** | `/api/audio-playlists` | Playlists mixtes audio coach avec fonds |
| **Planning** | `/api/schedule` | Programmateurs, occurrences et exceptions |
| **Lecture** | `/api/playback` | Contrôle de la lecture (play, pause, seek, stop, reprise) |
| **Paramètres** | `/api/settings` | Configuration dynamique (lecture/thème/langue), sortie vidéo, espace de stockage (`/settings/storage`), synchronisation des écrans (`POST /settings/system/reset` — vidage des caches + rechargement + relance des services) et désinstallation machine (`POST /settings/system/uninstall`, phrase de confirmation requise) |
| **Imports** | `/api/import-jobs` | Suivi des tâches d'importation en arrière-plan |
| **Logs** | `/api/logs` | Consultation et téléchargement des journaux système |
| **Radio — Bibliothèque** | `/api/radio` | Morceaux (CRUD, artistes/albums/tags), playlists radio, état du canal (`/api/radio/state`) |
| **Radio — Rappels** | `/api/radio/announcements`, `/api/radio/announcement-rules` | Annonces (import + description), règles de déclenchement, déclenchement manuel |

### WebSockets

- `/ws/playback` : Diffusion en temps réel de l'état de lecture par canal — câblé, réseau **et radio** (`channel=radio`, même connexion, vocabulaire de commandes `radio_*` propre au canal musical) — *position*, *durée*, *média courant*, décompte inter-cours.

---

## 9. Exploitation & Découverte Réseau (Wyse)

Sur le réseau local, la machine Wyse de production (`pavilion-malefique` / Dell Wyse 5070) reçoit son adresse IP via **DHCP**.

### Protocole de Découverte Réseau (Si l'IP change)

1. **Test sur l'adresse courante ou le nom mDNS** :
   ```bash
   curl -s --connect-timeout 2 http://10.0.0.30:8000/api/settings
   curl -s --connect-timeout 2 http://pavilion-malefique.local:8000/api/settings
   ```
2. **Scan Nmap automatique du sous-réseau** (si l'IP n'est pas joignable) :
   ```bash
   SUBNET=$(ip route | grep default | awk '{print $3}' | cut -d. -f1-3).0/24
   nmap -p 8000 --open "$SUBNET" -oG - | grep "8000/open"
   ```

### Commandes d'Exploitation à Distance (SSH)

```bash
# Vérifier l'état des services systemd sur la Wyse
ssh fanta@<WYSE_IP> "systemctl status bobine-backend bobine-kiosk"
```

### Déploiement sur la Wyse

⚠️ **`git pull` ne fonctionne PAS sur la Wyse** : son réseau bloque GitHub entièrement (ports 22 **et** 443 vers github.com). Le dépôt `/home/fanta/Bobine` sur la Wyse **n'est pas un clone git** — le déploiement se fait par copie (`rsync`) depuis un poste de dev sur le même réseau local, jamais par `git pull` sur la machine cible elle-même.

```bash
# 1. Depuis le poste de dev, sur le même LAN que la Wyse — toujours en
#    --dry-run d'abord, vérifier qu'aucune ligne "deleting" ne touche data/ :
rsync -a --delete --dry-run \
  --exclude='.git/' --exclude='data/' --exclude='backend/data/' --exclude='backend/.venv/' \
  --exclude='frontend/node_modules/' --exclude='frontend/.next/' --exclude='frontend/out/' \
  --exclude='__pycache__/' --exclude='*.pyc' --exclude='*.db*' --exclude='*.log' \
  --exclude='backend/.pytest_cache/' --exclude='VideoTest/' \
  --exclude='.claude/' --exclude='.agents/' --exclude='.gemini/' \
  --exclude='AGENTS.md' --exclude='CLAUDE.md' \
  ./ fanta@<WYSE_IP>:/home/fanta/Bobine/
# (puis sans --dry-run une fois vérifié)

# 2. Sur la Wyse : si le déploiement ajoute/modifie des dossiers média, des
#    réglages de config.toml ou des services systemd, relancer l'installateur
#    (idempotent, ne touche jamais data/ hors --uninstall --purge-data) :
ssh fanta@<WYSE_IP> "cd /home/fanta/Bobine && sudo ./install.sh --skip-packages -y"
# Pour un changement de CODE SEUL (aucun nouveau dossier/réglage/service),
# un simple rebuild suffit à la place de l'étape ci-dessus :
#   ssh fanta@<WYSE_IP> "cd /home/fanta/Bobine/frontend && npm run build"

# 3. install.sh ne redémarre PAS un service déjà actif : redémarrage explicite
#    pour charger le nouveau code (ces deux commandes sont NOPASSWD) :
ssh fanta@<WYSE_IP> "sudo -n systemctl restart bobine-backend.service && sudo -n systemctl restart bobine-kiosk.service"

# 4. Vérifier : santé de l'API, services actifs, espace disque de data/ inchangé
ssh fanta@<WYSE_IP> "curl -s localhost:8000/api/health; systemctl is-active bobine-backend bobine-kiosk; du -sh /home/fanta/Bobine/data"
```

Les commits restent locaux jusqu'à ce qu'une machine avec accès GitHub (hors LAN de la Wyse) les pousse sur `origin/main` — le déploiement ne dépend jamais de ce push.

---

## 10. Licence

Ce projet est distribué sous licence Open Source **MIT**.
