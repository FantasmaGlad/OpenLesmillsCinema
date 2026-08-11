# OpenLesmillsCinema

Diffusion, planification et pilotage de vidéos de cours en salle, sur mini PC dédié. Serveur multi-worker FastAPI + Redis + SQLite, kiosque Chromium X11, interface d'administration et télécommande mobile Next.js.

Ce document est écrit pour quiconque souhaite **comprendre, exploiter, modifier ou déployer** le système OpenLesmillsCinema : il décrit l'architecture réellement en place (pas une intention), le contrat réseau, le modèle de données inter-workers, ainsi que la configuration d'exploitation sur mini PC dédié.

---

## Sommaire

1. [Stack et démarrage](#1-stack-et-démarrage)
2. [Architecture générale (Multi-worker & Bus Redis)](#2-architecture-générale)
3. [Modèle de données & Persistance SQLite](#3-modèle-de-données--persistance-sqlite)
4. [Canaux de diffusion & Gestionnaire de lecture](#4-canaux-de-diffusion--gestionnaire-de-lecture)
5. [Mode Audio Coach & Fonds animés](#5-mode-audio-coach--fonds-animés)
6. [Script d'installation & Services systemd](#6-script-dinstallation--services-systemd)
7. [Référence API HTTP & WebSockets](#7-référence-api-http--websockets)
8. [Exploitation & Découverte Réseau (Wyse)](#8-exploitation--découverte-réseau-wyse)
9. [Licence](#9-licence)

---

## 1. Stack et démarrage

### Stack technique

- **Backend** : Python 3.11+, [FastAPI](https://fastapi.tiangolo.com/) + `uvicorn` (4 workers), [SQLAlchemy](https://www.sqlalchemy.org/) + `alembic` (migrations), SQLite (`data/database.db`), Redis (bus d'état Pub/Sub, verrous distribués), `APScheduler` (planification), `watchdog` (surveillance des dossiers d'import), `ffmpeg` / VAAPI (décodage matériel Intel).
- **Frontend** : [Next.js](https://nextjs.org/) 16 (App Router), React 19, TypeScript, CSS Vanilla (CSS Modules + Design Tokens), PWA (`manifest.json`), WebSockets.
- **Exploitation & Kiosque** : Debian 13 (Trixie), Chromium en mode kiosque (X11 / `xinit`), `systemd` (services backend, kiosque, garde audio), `avahi-daemon` (découverte mDNS).

### Développements locaux

**Préréquis** : Node.js ≥ 20, Python ≥ 3.11, Redis local actif.

```bash
# 1. Backend (FastAPI + Redis)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
redis-server &          # requis : bus d'état partagé
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 2. Frontend (Next.js)
cd frontend
npm install
npm run dev             # accessible sur http://localhost:3000
```

**Validation rapide avant commit** :

```bash
# Vérification de syntaxe Python (AST)
backend/.venv/bin/python -c "import ast; ast.parse(open('backend/app/main.py').read())"

# Vérification du typage Frontend (TypeScript)
cd frontend && npx tsc --noEmit
```

### Configuration (`config.toml`)

La configuration est chargée selon l'ordre de priorité suivant :
1. Variables d'environnement préfixées `OPENLESMILLS_` (priorité maximale).
2. `/etc/openlesmillscinema/config.toml` (production, écrit par `install.sh`).
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

Le backend tourne en plusieurs workers `uvicorn` sous le même processus maître. Redis sert de **bus d'état partagé** (position de lecture, minuteurs, verrous de tick `tick_lock.py`, synchronisation de planning) et de canal de diffusion Pub/Sub pour les WebSockets. Un client web reste parfaitement synchronisé quel que soit le worker traitant la requête HTTP.

### Arborescence backend (`backend/app/`)

- `main.py` : Entrée de l'application FastAPI, initialisation des routes, des événements de démarrage (`boot_state.py`) et du serveur d'assets statiques.
- `playback_manager.py` : Moteur de lecture multi-canal (gestion de l'état `PLAYING`, `PAUSED`, `IDLE`, minutage et reprise).
- `scheduler_manager.py` : Gestionnaire `APScheduler` de la programmation horaire (récurrences, détections de conflits, décalages).
- `timer_manager.py` : Minuteur de décompte inter-cours et enchaînement audio coach.
- `models.py` : Déclarations SQLAlchemy ORM.
- `config.py` : Gestionnaire de configuration dynamique.
- `routers/` : Endpoints HTTP groupés par domaine (`videos`, `backgrounds`, `playlists`, `audio`, `audio_playlists`, `schedule`, `playback`, `timer`, `settings`, `logs`, `import_jobs`).

---

## 3. Modèle de données & Persistance SQLite

Le schéma de données est géré par **SQLAlchemy** et migré via **Alembic**. Le stockage s'effectue dans un fichier SQLite unique (`data/database.db`).

### Entités principales

- `videos` / `backgrounds` : Métadonnées des médias (durée, résolution, codec, vignettes générées dans `data/thumbnails`).
- `playlists` & `playlist_items` : Playlists de cours vidéo ordonnées.
- `audio_courses` & `audio_tracks` : Cours audio importés et leurs pistes associées.
- `audio_playlists` & `audio_playlist_items` : Éditions mixées audio coach avec attribution de fond visuel par piste.
- `schedules` & `schedule_overrides` : Programmations récurrentes ou ponctuelles, avec gestion des exceptions d'occurrences (annulation, remplacement).
- `playback_state` : État de lecture persisté par canal (*Câblé* et *Réseau*), incluant la sauvegarde des actions interrompues pour la reprise automatique.
- `settings` : Clés/valeurs des paramètres modifiables à chaud depuis l'interface admin.
- `activity_log` : Journal des événements fonctionnels et techniques du système.

---

## 4. Canaux de diffusion & Gestionnaire de lecture

Le système pilote deux canaux de diffusion **strictement indépendants** :

1. **Canal Câblé (`channel=cable`)** : Canal d'affichage principal relié à la sortie vidéo physique du mini PC (écran salle / kiosque).
2. **Canal Réseau (`channel=network`)** : Canal secondaire destiné à la diffusion réseau ou aux écrans auxiliaires.

### Reprise après interruption (Resilience Rule)

Lorsqu'une programmation automatique (`scheduler`) doit démarrer alors qu'une lecture manuelle est en cours :
1. Le `playback_manager` interrompt la lecture manuelle et sauvegarde la position exacte et l'identifiant du média dans `playback_state`.
2. Le cours programmé s'exécute.
3. À la fin de la programmation, l'interface propose automatiquement la **reprise à la seconde près** du cours interrompu.

---

## 5. Mode Audio Coach & Fonds animés

Le mode **Audio Coach** permet de diffuser des cours audio (pistes vocales / musique) sur l'équipement sonore de la salle tout en affichant un fond visuel dynamique sur l'écran.

- **Importation** : Support des fichiers MP3 individuellement ou par paquets ZIP.
- **Fonds animés** : Boucles vidéo stockées dans `backend/data/backgrounds`, jouées en boucle infinie sans coupure.
- **Minuteur d'enchaînement (`audio_chain_timer_seconds`)** : Délai de transition configurable entre deux pistes audio (modifiable depuis `/api/settings`).

---

## 6. Script d'installation & Services systemd

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
| `--skip-packages` | Mise à jour du projet (post `git pull`) sans réinstaller les paquets `apt` |
| `--skip-build` | Ne reconstruit pas le frontend Next.js |
| `--uninstall [--purge] [--purge-data]` | Désinstallation progressive du système |

### Services Systemd créés

- `openlesmillscinema-backend.service` : API FastAPI Uvicorn sur le port 8000.
- `openlesmillscinema-kiosk.service` : Mode Kiosque Chromium plein écran sur `xinit` (X11).
- `openlesmillscinema-guard.service` : Watchdog de surveillance du système et de l'audio.

---

## 7. Référence API HTTP & WebSockets

### Endpoints HTTP (`/api`)

| Domaine | Préfixe | Description |
|---|---|---|
| **Vidéos** | `/api/videos` | Import, liste, détail, normalisation et suppression |
| **Playlists Vidéo** | `/api/playlists` | Gestion des playlists vidéo (CRUD, relecture) |
| **Fonds Animés** | `/api/backgrounds` | Gestion de la bibliothèque de boucles visuelles |
| **Audio Coach** | `/api/audio` | Import de cours audio (MP3/ZIP), gestion des pistes |
| **Playlists Audio** | `/api/audio-playlists` | Playlists mixtes audio coach avec fonds |
| **Planning** | `/api/schedule` | Programmateurs, occurrences et exceptions |
| **Lecture** | `/api/playback` | Contrôle de la lecture (play, pause, seek, stop, reprise) |
| **Minuteur** | `/api/timer` | État et contrôle du décompte inter-cours |
| **Paramètres** | `/api/settings` | Configuration dynamique du système et de la sortie vidéo |
| **Imports** | `/api/import-jobs` | Suivi des tâches d'importation en arrière-plan |
| **Logs** | `/api/logs` | Consultation et téléchargement des journaux système |

### WebSockets

- `/ws/playback` : Diffusion en temps réel de l'état de lecture par canal (*position*, *durée*, *média courant*).
- `/ws/timer` : Synchronisation temps réel du minuteur d'inter-cours.

---

## 8. Exploitation & Découverte Réseau (Wyse)

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
ssh fanta@<WYSE_IP> "systemctl status openlesmillscinema-backend openlesmillscinema-kiosk"

# Mettre à jour et redémarrer la Wyse
ssh fanta@<WYSE_IP> "cd /home/fanta/OpenLesmillsCinema && git pull && sudo ./install.sh --skip-packages"
```

---

## 9. Licence

Ce projet est distribué sous licence Open Source **MIT**.
