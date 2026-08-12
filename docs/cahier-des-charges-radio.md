# Cahier des charges — Module Radio

> Ajout d'un sous-système **Radio** à OpenLesmillsCinema : diffusion musicale
> d'ambiance « type Spotify » sur un poste dédié, avec bibliothèque musicale,
> playlists, pochettes, rappels de bienséance intercalés, fonctionnement 24/7
> et pilotage à distance depuis l'admin (mobile + PC).
>
> Ce document est le **cahier des charges validé** avant développement. Il
> décrit les décisions arrêtées, l'architecture cible et le découpage en lots.
> Statut : **validé** (13 décisions D1–D13 + 6 arbitrages A1–A6) — prêt pour
> l'implémentation, à démarrer par le lot L0.

---

## Sommaire

1. [Contexte & objectif](#1-contexte--objectif)
2. [Décisions validées](#2-décisions-validées)
3. [Périmètre](#3-périmètre)
4. [Surfaces & routing](#4-surfaces--routing)
5. [Architecture backend](#5-architecture-backend)
6. [Architecture frontend](#6-architecture-frontend)
7. [Rappels (annonces de bienséance)](#7-rappels-annonces-de-bienséance)
8. [24/7, auto-boot & Planning](#8-247-auto-boot--planning)
9. [Nouveaux paramètres](#9-nouveaux-paramètres)
10. [Impacts sur l'existant & risques](#10-impacts-sur-lexistant--risques)
11. [Découpage en lots](#11-découpage-en-lots)
12. [Points ouverts à valider](#12-points-ouverts-à-valider)

---

## 1. Contexte & objectif

Le système pilote aujourd'hui deux canaux vidéo/audio indépendants (**Câblé** et
**Réseau**) et dispose déjà d'un **mode Audio Coach** (`/coach`) très proche du
besoin Radio : lecture audio synchronisée par WebSocket, contrôles
play/pause/piste suivante/volume, affichage kiosk « now playing » avec barre de
progression, sélection d'un fond visuel, et télécommande mobile.

La Radio est un **jumeau « musique »** de ce mode Coach, orienté ambiance de
salle plutôt que cours chorégraphiés :

| Existant (Audio Coach) | Nouveau (Radio) |
|---|---|
| `/coach` (contrôle) + `/kiosk` (affichage) | `/radio` (écran PC dédié : affichage **+** contrôles) |
| Cours/pistes RPM + **fonds animés** | Morceaux musique + **pochette d'album** |
| Onglets « Cours audio » / « Playlists audio » | Onglets « **Radio** » (télécommande) / « **Piste Audio Radio** » (bibliothèque) / « **Rappels** » |
| Canaux `cable` / `network` | 3ᵉ canal `radio`, indépendant |

**Objectif** : conserver le thème dynamique de l'app, offrir une interface admin
de contrôle radio (mobile + PC) et un écran kiosk « type Spotify » (grande
pochette, now playing) sur le poste de diffusion dédié, le tout hors-ligne.

---

## 2. Décisions validées

| # | Décision | Choix validé |
|---|---|---|
| D1 | Modèle de données | **Sous-système indépendant** : nouvelles tables `radio_*`, séparées des cours audio coach. |
| D2 | Canal de diffusion | **3ᵉ canal `radio`**, joue en parallèle du Câblé et du Réseau. |
| D3 | Pochettes | **Auto ID3 à l'import + remplacement manuel.** |
| D4 | Sources d'import | **Fichiers locaux uniquement** (MP3 / ZIP + dossier surveillé), hors-ligne. |
| D5 | Surfaces | **`/radio` = affichage + contrôles** (écran PC dédié) **+** onglet admin « Radio » = télécommande (mobile/PC), même canal. |
| D6 | Comportements de lecture | **Les 4** : lecture continue + file d'attente, shuffle, repeat (piste/playlist), **crossfade** (fondu enchaîné). |
| D7 | Organisation bibliothèque | **Les 3 vues**, séparées visuellement : morceaux + playlists, tags/genres, navigation artiste/album. |
| D8 | Conflit son entre canaux | **Indépendance totale** — postes physiquement séparés (pièces + enceintes distinctes). Aucune logique inter-canaux. |
| D9 | Comportement 24/7 | **Playlist d'ambiance par défaut en boucle** dès le boot ; le Planning ne fait que la remplacer temporairement, puis retour au défaut. |
| D10 | Planning | **Auto-démarrage au boot + programmable via l'onglet Planning + capacité 24/7.** |
| D11 | Rappels — déclenchement | **Les 4** : toutes les N musiques, toutes les X minutes, à heures fixes, manuel (« jouer maintenant »). |
| D12 | Rappels — insertion | **Selon le mode** : « toutes les N musiques » attend la fin du morceau ; « X min / heures fixes / manuel » applique un fondu immédiat (duck). |
| D13 | Rappels — sélection | **Aléatoire** parmi les rappels actifs. Chaque rappel porte une **description** (texte de l'annonce) saisie à l'import. |

---

## 3. Périmètre

### Dans le périmètre (v1)

- Bibliothèque musicale dédiée : import de **tous les formats audio courants**
  (MP3, AAC/M4A, FLAC, OGG/Opus, WAV…) via upload/ZIP + dossier surveillé,
  métadonnées ID3/tags, pochettes auto + manuelles.
- 3 vues de navigation : morceaux/playlists, tags/genres, artiste/album.
- Playlists radio créées/éditées à la main (dont une **playlist d'ambiance par
  défaut** pour le 24/7).
- Canal `radio` indépendant, lecture continue avec file d'attente, shuffle,
  repeat, **crossfade**.
- Écran `/radio` (poste dédié) : mise en page Spotify + contrôles intégrés.
- Onglet admin « Radio » : télécommande (mobile + PC).
- Module **Rappels** : import + description, activation/retrait, règles de
  déclenchement (N morceaux / X min / heures fixes / manuel), insertion et
  sélection aléatoire.
- 24/7 : playlist par défaut en boucle, auto-démarrage au boot.
- Intégration Planning : fenêtres horaires remplaçant temporairement le défaut.

### Hors périmètre (v1)

- Intégration Spotify / services de streaming externes (D4).
- Flux webradio internet par URL (D4).
- Logique d'auto-pause / ducking entre canaux (D8 : indépendance totale).
- Plusieurs écrans `/radio` simultanés (un seul poste dédié ; un éventuel
  second écran serait « miroir » best-effort, sans garantie de crossfade sync).
- Reprise de la position exacte après reboot (D9 : on repart de la playlist
  par défaut).
- **Auto-démarrage du *son* sans intervention après reboot** : le poste `/radio`
  est ouvert à la main dans un navigateur standard (pas de service kiosk dédié,
  cf. §10.2) ; la politique d'autoplay du navigateur exige un premier clic pour
  émettre du son. Le backend restaure bien l'état de lecture au boot, mais un
  clic sur `/radio` reste nécessaire pour débloquer l'audio (overlay
  « Démarrer » prévu).

---

## 4. Surfaces & routing

Quatre surfaces frontend, un seul canal `radio` côté serveur.

| Route / Onglet | Rôle | Analogue existant |
|---|---|---|
| `/radio` | **Écran du poste dédié** : mise en page Spotify (grande pochette, titre/artiste, progression, file d'attente) **avec contrôles intégrés** (play/pause, suivant/précédent, volume, shuffle, repeat, rappel manuel). Pensé écran tactile/souris. | `/kiosk` + `/coach` fusionnés |
| Onglet « **Radio** » (sidebar) | **Télécommande admin** (mobile + PC) pilotant le canal `radio` à distance. | `DashboardScreen` / `MobileRemote` / `/coach` |
| Onglet « **Piste Audio Radio** » (sidebar) | **Bibliothèque** : import, édition métadonnées/pochettes, 3 vues (morceaux, artiste/album, tags/genres), gestion des playlists. | `/audio` + `/audio-playlists` |
| Onglet « **Rappels** » (sidebar) | Import des annonces + **description**, activation/retrait, règles de déclenchement. | *(nouveau)* |

`/radio` et l'onglet admin « Radio » partagent le **même état serveur** via
WebSocket (`channel=radio`) : ce que l'un déclenche, l'autre le reflète, comme
`/coach` ↔ `/kiosk` aujourd'hui.

Ajout des entrées dans `frontend/src/lib/navLinks.ts` (3 nouveaux onglets ;
`/radio` reste hors sidebar, comme `/kiosk`, ouvert directement sur le poste).

---

## 5. Architecture backend

### 5.1 Nouveau canal `radio`

Le `playback_manager` gère aujourd'hui `cable` et `network`. On ajoute
`radio` comme troisième canal, avec son **propre état** dans Redis (bus d'état
partagé, cf. §2 du README). Aucune interaction avec les autres canaux (D8).

L'état radio (Redis, sérialisé, diffusé par `/ws/playback` filtré sur le
canal) comprend :

```
state            : idle | playing | paused | announcing
playlist_id      : id de la playlist en cours (ou null = lecture libre)
playlist_name
order            : ordre résolu des pistes (après shuffle éventuel)
index            : position courante dans `order`
current_track    : { id, title, artist, album, duration, cover_url }
position_seconds
volume
shuffle          : bool
repeat           : off | track | playlist
queue            : file d'attente « à suivre » (surcharge manuelle)
crossfade_seconds
current_announcement : { id, description, remaining } | null
tracks_since_announcement : compteur (pour la règle « toutes les N musiques »)
```

Le poste `/radio` est le **lecteur primaire** (source de la position rapportée,
pilote du crossfade) — même rôle « primaire/miroir » que le kiosk actuel
(`isPrimaryRef`). L'admin est une télécommande : il envoie des commandes et
affiche l'état, il ne lit pas d'audio.

### 5.2 Modèle de données (ORM proposé)

Nouvelles tables dans `backend/app/models.py`, **créées par
`Base.metadata.create_all()` au démarrage** — ce projet **n'utilise pas Alembic**
(le dossier `alembic/versions/` est vide ; les ajouts de colonnes sur des tables
existantes passent par les micro-migrations idempotentes de
`database.py::_migrate_add_missing_columns`) :

```python
class RadioTrack(Base):                 # __tablename__ = "radio_tracks"
    id, file_path (unique), title
    artist, album, album_artist
    track_number, disc_number, year
    genre                               # depuis ID3
    duration_seconds
    cover_path                          # nullable
    cover_source: Enum(id3|manual|none)
    source: Enum(upload|watched_folder)
    imported_at

class RadioTag(Base):                    # étiquettes libres (ambiance, tempo…)
    id, name (unique)

class RadioTrackTag(Base):               # m2m radio_tracks <-> radio_tags
    track_id, tag_id

class RadioPlaylist(Base):               # __tablename__ = "radio_playlists"
    id, name, created_at
    is_default: bool                     # la playlist d'ambiance 24/7 (une seule)
    cover_path                           # nullable (sinon dérivée du 1er titre)

class RadioPlaylistItem(Base):
    id, playlist_id, radio_track_id, position

class RadioAnnouncement(Base):           # rappels — __tablename__ = "radio_announcements"
    id, file_path (unique)
    description                          # OBLIGATOIRE : texte dit par l'annonce
    duration_seconds
    enabled: bool
    imported_at

class RadioAnnouncementRule(Base):       # règles de déclenchement
    id
    rule_type: Enum(every_n_tracks|every_x_minutes|fixed_times)
    n_tracks                             # si every_n_tracks
    interval_minutes                     # si every_x_minutes
    times_of_day                         # si fixed_times (JSON ["09:00","09:30"])
    enabled: bool
```

> **Navigation artiste/album (D7)** : dérivée par regroupement des colonnes
> `album_artist`/`album`/`artist` des `radio_tracks` (pas de tables Artiste/Album
> dédiées en v1). La pochette d'un album = celle de son premier titre.

> **Sélection aléatoire des rappels (D13)** : les règles définissent *quand* ;
> le rappel joué est tiré au hasard parmi les `radio_announcements` `enabled`.
> Pas de ciblage par règle en v1.

### 5.3 Pipeline d'import & métadonnées

Sur le modèle de `backend/app/utils/audio_importer.py` (upload multi-fichiers,
ZIP, dossier surveillé, jobs en arrière-plan via `import_jobs`) :

- **Métadonnées** (titre, artiste, album, album_artist, n° piste, année,
  genre, durée) : extraites via **ffprobe** (déjà utilisé par `audio_utils`).
- **Pochette embarquée** (D3) : extraite via **ffmpeg**
  (`ffmpeg -i in.mp3 -an -c:v copy cover.jpg`) puis redimensionnée avec
  **pillow** (déjà dépendance). Stockée dans un nouveau dossier média (ex.
  `data/radio_covers/`).
- **Override manuel** : `PUT /api/radio/tracks/{id}` accepte une image de
  pochette et l'édition des champs ; `cover_source` passe à `manual`.
- **Formats acceptés** (validé : *tous les formats audio*) : whitelist large à
  l'import (`.mp3 .m4a .aac .flac .ogg .opus .wav .aiff .wma …`). Les formats
  lisibles nativement par Chromium (mp3, aac/m4a, flac, ogg/opus, wav) sont
  servis tels quels par `/stream`. Les formats non lus par le navigateur (ex.
  `.wma`) sont **transcodés à l'import** en un format web (AAC/MP3) via ffmpeg,
  l'original étant conservé ou remplacé selon un réglage. La détection de durée
  et de tags reste faite par ffprobe quel que soit le format.

> **Aucune nouvelle dépendance Python** : ffprobe/ffmpeg + pillow suffisent
> (pas besoin de `mutagen`).

Dossiers média à créer (config + `install.sh`) : `data/radio/` (fichiers
musique), `data/radio_covers/` (pochettes), `data/radio_announcements/`
(rappels), et sous-dossiers surveillés dédiés (ex. `data/watched/radio/`).

### 5.4 Endpoints API (`/api/radio`)

Nouveau routeur `backend/app/routers/radio.py` (+ `radio_playlists`,
`radio_announcements` si on suit le découpage actuel), enregistré dans
`main.py`.

```
# Bibliothèque
GET    /api/radio/tracks            (filtres: q, artist, album, genre, tag)
GET    /api/radio/tracks/{id}
GET    /api/radio/tracks/{id}/stream
GET    /api/radio/tracks/{id}/cover
POST   /api/radio/tracks/upload      (multi MP3)          -> job
POST   /api/radio/tracks/upload-zip  (ZIP)                -> job
PUT    /api/radio/tracks/{id}        (métadonnées + pochette manuelle)
DELETE /api/radio/tracks/{id}
GET    /api/radio/artists            (regroupement dérivé)
GET    /api/radio/albums             (regroupement dérivé)
GET/POST/PUT/DELETE /api/radio/tags

# Playlists
GET/POST/PUT/DELETE /api/radio/playlists
PUT    /api/radio/playlists/{id}/items      (ajout/retrait/réordonnancement)
PUT    /api/radio/playlists/{id}/default    (désigne la playlist d'ambiance)

# Rappels
GET    /api/radio/announcements
POST   /api/radio/announcements/upload      (MP3 + description)   -> job
PUT    /api/radio/announcements/{id}        (description, enabled)
DELETE /api/radio/announcements/{id}
GET    /api/radio/announcements/{id}/stream
POST   /api/radio/announcements/play-now    (déclenchement manuel)
GET/POST/PUT/DELETE /api/radio/announcement-rules
```

### 5.5 Commandes de lecture (WebSocket)

Réutilise `/ws/playback` avec `channel=radio` et le hook
`frontend/src/lib/usePlaybackSocket.ts` (déjà paramétré par canal). Nouvelles
commandes côté `playback_manager` :

```
load_radio_playlist { playlist_id, shuffle? }
play / pause
radio_next_track / radio_previous_track / radio_jump_to_track { index }
radio_seek { position_seconds }
volume { volume }
radio_set_shuffle { on } / radio_set_repeat { mode }
radio_add_to_queue { track_id } / radio_reorder_queue { ... }
radio_play_announcement { announcement_id? }   # null = aléatoire (manuel)
report_position (primaire -> serveur, comme le kiosk)
radio_track_ended / announcement_ended
```

---

## 6. Architecture frontend

> ⚠️ **Rappel projet** (`frontend/AGENTS.md`) : cette version de Next.js
> comporte des ruptures d'API. **Lire `node_modules/next/dist/docs/` avant
> d'écrire du code frontend.**

- **`/radio`** (`src/app/radio/page.tsx`) — écran du poste dédié. Mise en page
  « type Spotify » : grande pochette centrée, titre/artiste/album, barre de
  progression, file d'attente « à suivre », barre de contrôle
  (play/pause, précédent/suivant, volume, shuffle, repeat, bouton rappel
  manuel). Affichage en veille (aucune lecture) : horloge + logo, cohérent avec
  l'écran d'attente du kiosk. Thème dynamique réutilisé (`var(--accent-*)`).
- **Onglet « Radio »** (`src/app/radio-remote/` ou dashboard dédié) —
  télécommande admin responsive (mobile + PC), sur le patron de
  `DashboardScreen` / `MobileRemote` / `/coach`.
- **Onglet « Piste Audio Radio »** (`src/app/radio-library/page.tsx`) — 3 vues
  **séparées visuellement** (D7) via un sélecteur de vue : (a) Morceaux +
  Playlists, (b) Artistes/Albums, (c) Tags/Genres. Import via `UploadManager`
  existant, édition métadonnées + pochette, création/édition de playlists
  (glisser-déposer comme les playlists audio).
- **Onglet « Rappels »** (`src/app/radio-announcements/page.tsx`) — liste des
  annonces avec leur **description** au premier plan, toggle actif/inactif,
  import (MP3 + champ description obligatoire), et éditeur des **règles** de
  déclenchement.
- **i18n** : nombreuses clés à ajouter dans `frontend/src/lib/i18n.ts`.
- **Crossfade / gapless** (D6) — implémenté sur `/radio` via **Web Audio API** :
  deux `MediaElementAudioSourceNode` → `GainNode` → destination, avec rampe de
  gain sur `radio_crossfade_seconds`. Même graphe utilisé pour le **duck** des
  rappels (baisse du gain musique, lecture de l'annonce sur un 3ᵉ nœud, remontée).
  C'est la brique techniquement la plus lourde et nouvelle du projet.

---

## 7. Rappels (annonces de bienséance)

Module d'annonces vocales intercalées dans la musique (ex. « merci de replacer
vos poids sur leur support… »).

- **Import** (onglet dédié) : MP3 + **champ description obligatoire** (le texte
  dit par l'annonce, D13) pour les gérer facilement. Activation/retrait par
  toggle `enabled`.
- **Déclenchement** (D11) — 4 types de règles cumulables :
  1. **Toutes les N musiques** — compteur `tracks_since_announcement`.
  2. **Toutes les X minutes** — minuteur serveur.
  3. **À heures fixes** — horaires récurrents (`times_of_day`).
  4. **Manuel** — bouton « jouer maintenant » (admin + `/radio`).
- **Insertion** (D12) — selon le mode :
  - *Toutes les N musiques* → **attend la fin du morceau** en cours, joue le
    rappel dans le silence inter-titres, puis reprend.
  - *X min / heures fixes / manuel* → **fondu immédiat** (duck) : la musique
    baisse, le rappel se joue, la musique remonte — l'annonce part à l'heure
    pile même au milieu d'un morceau.
- **Sélection** (D13) — **aléatoire** parmi les rappels `enabled`.

Côté serveur, le moteur de rappels vit dans le tick de lecture / APScheduler du
canal radio : il décide *quand* déclencher et émet une commande
`radio_play_announcement` ; le lecteur `/radio` applique l'attente-fin ou le
duck selon le mode transmis.

---

## 8. 24/7, auto-boot & Planning

- **Playlist d'ambiance par défaut** (D9) : une `radio_playlists.is_default`
  tourne **en boucle** (repeat=playlist) en permanence.
- **Auto-démarrage au boot** (D10) : `backend/app/utils/boot_state.py` — au
  démarrage, si le canal radio est au repos et `radio_autostart_on_boot` actif,
  charger la playlist par défaut et lancer la lecture.
- **Planning** (D10, arbitrage A1) : extension de `Schedule` — nouveau
  `ScheduleTargetType.radio_playlist` et `channel="radio"`. Une programmation
  radio définit une **fenêtre début → fin** pendant laquelle une playlist
  remplace le défaut ; à la fin de la fenêtre, **retour automatique à la
  playlist par défaut**. Elle réutilise **le même système de récurrence que les
  cours** (jours de semaine 0–6 + heure), avec en plus une **option 24/7**.

### Extension concrète du modèle `Schedule`

Aujourd'hui une programmation est un *déclencheur* ponctuel : `run_at` (once) ou
`recurrence_rule` JSON `{days_of_week, time}` (recurring), validé par
`routers/schedule.py::_validate_and_normalize`, et le canal est **contraint à
`cable`/`network`** (lignes `data.channel if ... in ("cable","network")`).
Points à modifier :

1. **Enum & validation** : ajouter `ScheduleTargetType.radio_playlist` ;
   autoriser `channel="radio"` ; `_check_target_exists` gère `radio_playlist`.
2. **Fenêtre** : étendre le JSON de récurrence en
   `{days_of_week, time, end_time, mode: "window"|"24_7"}` (rétro-compatible :
   sans `end_time`, comportement inchangé pour les cours). Pour une once,
   ajouter une fin (`end_at`).
3. **Bascule retour** : `scheduler_manager` programme, en plus du démarrage,
   un job de **fin de fenêtre** qui rebascule le canal radio sur la playlist
   par défaut (sauf mode `24_7`, qui ne rebascule jamais tant qu'aucune autre
   fenêtre ne prend la main).
4. **UI Planning** : réutiliser l'éditeur récurrent des cours (jours + heure)
   en ajoutant heure de fin + case « 24/7 », filtré sur le canal `radio`.

---

## 9. Nouveaux paramètres

Clés `settings` (éditables à chaud via `/api/settings`) :

| Clé | Défaut | Rôle |
|---|---|---|
| `radio_crossfade_seconds` | `4` | Durée du fondu enchaîné |
| `radio_autostart_on_boot` | `true` | Démarrage auto au boot (config.toml uniquement) |
| `radio_announcement_duck_level` | `15` | Volume musique (%) pendant un rappel en mode duck |
| `radio_announcement_fade_ms` | `1500` | Durée du fondu d'entrée/sortie du duck (ms) |
| `radio_volume_default` | `100` | Volume radio par défaut |

Ces clés sont déclarées dans `config.py` (lot L0). Les entiers sont modifiables
à chaud via `PUT /api/settings` (mécanisme `_DB_OVERRIDABLE_FIELDS`) ;
`radio_autostart_on_boot` (booléen) reste piloté par `config.toml`.

> **La playlist d'ambiance par défaut n'est PAS un réglage** : c'est la
> `RadioPlaylist` marquée `is_default` (décision D9), pas une clé `settings`.

Les règles de rappels (N, X min, heures fixes) sont stockées en table
`radio_announcement_rules`, pas en `settings`.

---

## 10. Impacts sur l'existant & risques

- **Faible couplage** : sous-système indépendant (D1) + canal indépendant (D8).
  Peu de risque de régression sur Câblé/Réseau/Coach. Les touch-points communs
  sont `models.py`, `main.py` (include_router), `navLinks.ts`, `i18n.ts`,
  `usePlaybackSocket.ts` (déjà multi-canal), `Schedule` (extension fenêtre),
  `boot_state.py`, `install.sh` (nouveaux dossiers média).
- **Schéma** : 7 nouvelles tables créées par `create_all()` (pas d'Alembic dans
  ce projet). L'extension de `Schedule` (colonnes de fenêtre) se fera par
  micro-migration `_migrate_add_missing_columns` au lot L7.
- **Risque principal — crossfade (Web Audio API)** : brique nouvelle, la plus
  complexe. À isoler dans un lot dédié, livrable après une lecture radio simple
  (enchaînement net) déjà fonctionnelle.
- **Autoplay navigateur** : `/radio` sur le poste dédié doit démarrer le son
  sans geste (même contrainte que le kiosk câblé, cf.
  `--autoplay-policy=no-user-gesture-required` dans le xinitrc kiosk). Prévoir
  un service kiosk analogue pour le poste radio (`install.sh`).
- **Aucune nouvelle dépendance Python** (ffprobe/ffmpeg/pillow existants).
- **Next.js atypique** : lire `node_modules/next/dist/docs/` avant tout code
  frontend (`frontend/AGENTS.md`).

### 10.1 Audit `install.sh` — défaut préexistant détecté

`install.sh` **n'est pas complet** pour une configuration optimale, indépendamment
de la radio :

- **Le `config.toml` de production ne déclare que 3 dossiers** (`media_dir`,
  `watch_dir`, `thumbnails_dir`, tous sous `${REPO_DIR}/data`, lignes 501-504).
  Il **omet** `audio_dir`, `audio_watch_dir`, `backgrounds_dir`,
  `backgrounds_watch_dir` et `logs_dir`.
- Ces clés omises retombent alors sur les défauts de `config.py`, résolus en
  **relatif par rapport à `backend/`** (`ROOT_DIR = …/backend`). En production,
  les cours audio, les fonds animés et les logs atterrissent donc dans
  **`${REPO_DIR}/backend/data/…`**, alors que les vidéos sont dans
  **`${REPO_DIR}/data/…`** → **données éclatées sur deux emplacements**.
- Conséquences réelles :
  - `install.sh` ne `mkdir` (ligne 490) et ne `chown` (ligne 491) que
    `${REPO_DIR}/data` : `backend/data` n'est jamais préparé (créé à la volée
    par les importeurs, cf. `importer.py`/`audio_importer.py` — l'app se
    rattrape, mais ce n'est pas explicite).
  - **`--uninstall --purge-data` ne supprime que `${REPO_DIR}/data`** (ligne
    245) : les cours audio, fonds et logs sous `backend/data` **survivent à une
    désinstallation destructive** (données orphelines laissées derrière). C'est
    un bug.
  - L'indicateur de stockage (`routers/settings.py`) somme bien tous les
    dossiers via leurs chemins absolus résolus → il reste correct, mais il
    additionne deux arbres `data/` distincts.

**Correctif recommandé (à intégrer au lot L0)** : déclarer **explicitement tous
les dossiers média** dans le `config.toml` généré (tous sous `${REPO_DIR}/data`),
les `mkdir` tous, et étendre le `--purge-data` pour couvrir l'ensemble. Cela
unifie l'arborescence et supprime le split.

### 10.2 Ce que la radio ajoute à `install.sh`

- Nouveaux dossiers média à `mkdir` + `chown` + déclarer dans `config.toml` :
  `data/radio`, `data/radio_covers`, `data/radio_announcements`,
  `data/radio_watched` (et `data/radio_announcements_watched` si import surveillé
  des rappels).
- Ajout de ces dossiers à la liste `--purge-data`.
- **Pas de nouveau service kiosk systemd** (arbitrage A5 : `/radio` ouvert à la
  main dans un navigateur). Conserver toutefois à l'esprit le caveat autoplay
  (§3, hors périmètre) : le son ne démarre qu'après un premier clic.
- Aucun paquet apt supplémentaire (ffmpeg/ffprobe déjà installés).

---

## 11. Découpage en lots

| Lot | Contenu | Dépend de |
|---|---|---|
| **L0** ✅ | Schéma DB (7 tables via `create_all`) + clés `settings`/`config` + dossiers média (config.py, init_db, storage tracker) + **`install.sh` : unification de tous les dossiers sous `${REPO_DIR}/data` (correctif §10.1) + dossiers radio + `--purge-data`** + script `scripts/migrate_unify_data_dirs.py` + backup/restore | — |
| **L1** ✅ | Import & bibliothèque : `radio_utils`/`radio_importer` (ID3 + pochette + transcodage tous formats), router `/api/radio` (tracks CRUD/artists/albums/tags), stream+cover dans main.py, watcher radio, kinds d'upload radio, onglet « Piste Audio Radio » (vue Morceaux : grille pochettes carrées + import + drawer d'édition métadonnées/pochette/tags). Vérifié en navigateur. | L0 |
| **L2** ✅ | Playlists radio (`routers/radio_playlists.py` : CRUD, ajout, réordonnancement, playlist par défaut) + les 3 vues sur la page (Morceaux&Playlists / Artistes&Albums / Tags&Genres) avec filtres. Vérifié en navigateur. | L1 |
| **L3** ✅ | Canal `radio` + moteur de lecture (`RadioPlaybackManager` indépendant) + état WS (réutilise `/ws/playback`, channel=radio) + onglet admin « Radio » (télécommande) — continu, file d'attente, shuffle, repeat (**sans** crossfade). Vérifié en navigateur. | L1 |
| **L4** ✅ | Écran `/radio` (mise en page Spotify, affichage + contrôles) + poste dédié — pas de service kiosk systemd (arbitrage A5), écran de déverrouillage autoplay à la place. Vérifié en navigateur. | L3 |
| **L5** ✅ | **Crossfade / gapless** (Web Audio API) sur `/radio` — deux `<audio>` routés dans un graphe MediaElementAudioSourceNode → GainNode → destination, fondu anticipé (avant la fin réelle de la piste), le duck des rappels (L6) réutilise le même graphe. Vérifié en navigateur (instrumentation directe des appels Web Audio). | L4 |
| **L6** ✅ | **Rappels** : import + description + onglet dédié + règles (N / X min / heures fixes / manuel) + insertion (attente-fin / duck simple ramp `<audio>.volume`, le vrai Web Audio API reste pour L5) + sélection aléatoire. Vérifié en navigateur. | L3 |
| **L7** ✅ | 24/7 (playlist par défaut, auto-boot) + intégration Planning (fenêtres récurrentes + retour auto, **pas** de fenêtre ponctuelle ni à cheval sur minuit — portée réduite assumée). Vérifié en navigateur (fenêtre réelle déclenchée + retour au défaut à la seconde près). | L3 |

Chaque lot est livrable et vérifiable indépendamment (dev backend port 8001,
frontend `npm run dev`, puis déploiement Wyse via rsync/ssh).

---

## 12. Arbitrages complémentaires (validés)

| # | Point | Décision |
|---|---|---|
| A1 | Fenêtres horaires du Planning | **Début + fin**, **option 24/7**, et **récurrence par jours de semaine** — même système que le planning des cours (cf. §8). |
| A2 | Formats audio | **Tous les formats audio** dès la v1 (transcodage à l'import pour ce que le navigateur ne lit pas, cf. §5.3). |
| A3 | Second écran radio | **Un seul poste dédié** — aucun miroir synchronisé attendu. |
| A4 | Rappel pendant un crossfade | **OK** : le rappel interrompt le fondu enchaîné en cours. |
| A5 | Poste radio | **`/radio` ouvert à la main** dans un navigateur — **pas** de service kiosk systemd dédié. Caveat autoplay : premier clic requis pour le son (§3). |
| A6 | `install.sh` | **Défaut préexistant confirmé** (§10.1) : dossiers éclatés + `--purge-data` incomplet → corrigé au lot **L0**. |

Cahier des charges **complet et validé**. Reste à décider par quel lot démarrer
l'implémentation (proposé : **L0**, socle DB + dossiers + correctif `install.sh`).
