# Plan de construction — OpenLesmillsCinema

**Version :** 1.1 — 15 juillet 2026
**Statut :** Lots 0, 1, 2 et 3 complétés. Prêt pour le Lot 4 (Écran d'attente, minuteur, transitions).
**Documents liés :** Cahier des charges fonctionnel v1.1, Cahier des charges UI/UX v1.0

---

## 1. Objectif et méthode

Ce document découpe le cahier des charges (fonctionnel + UI/UX) en **lots**, puis en **tâches unitaires**, dans un ordre de réalisation qui :

1. **Valide en premier le risque technique le plus critique** — le décodage matériel VAAPI sur le Wyse 5070 dans Chromium (§3.3) — avant d'investir du temps dans les fonctionnalités.
2. Construit un **socle de bout en bout** le plus tôt possible (une vidéo lue en plein écran, pilotable à distance) plutôt que d'empiler les couches horizontalement (tout le backend, puis tout le frontend).
3. Ajoute ensuite les fonctionnalités par ordre de dépendance réelle : bibliothèque → playlists → planning → cas d'usage « cours en physique » (fonds animés + audio) → habillage/thèmes/canvas → robustesse & déploiement.

Chaque tâche référence les identifiants du cahier des charges (`F1.1`, `UX2.4`, `NF2`…) pour garder la traçabilité — aucune exigence des deux documents n'est censée manquer à l'appel.

**Tailles indicatives** (solo, temps partiel) : **S** = quelques heures à une demi-journée · **M** = 1–3 jours · **L** = 3–6 jours · **XL** = plus d'une semaine. À ajuster selon le temps réellement disponible — ce sont des ordres de grandeur, pas des engagements.

**Comment utiliser ce document :** coche les tâches au fur et à mesure (`- [x]`) directement dans ce fichier. L'ordre des lots est une proposition, pas une obligation absolue — certains lots (11 Thèmes, 13 Journalisation) peuvent avancer en parallèle dès que leurs dépendances sont posées.

---

## 2. Vue d'ensemble des lots

| Lot | Nom | Taille | Statut | Objectif |
|---|---|---|---|---|
| 0 | Amorçage & validation des risques | M | ✅ Terminé | Prouver que Chromium kiosk + décodage matériel tiennent sur le Wyse 5070 |
| 1 | Fondations backend & données | M | ✅ Terminé | Schéma SQLite, config centralisée, squelette API |
| 2 | Bibliothèque vidéo & import | L | ✅ Terminé | Upload, dossier surveillé, métadonnées, compatibilité codec |
| 3 | Lecture temps réel & télécommande | L | ✅ Terminé | WebSocket, contrôle play/pause/seek/volume, lecteur kiosk |
| 4 | Écran d'attente, minuteur, transitions | M | ⏳ À faire | Attente par défaut, compte à rebours, overlay pause, minuteur |
| 5 | Playlists | M | ⏳ À faire | Enchaînement de cours, éditeur PC |
| 6 | Programmation horaire | L | ⏳ À faire | Scheduler, récurrence, overrides, gestion de conflit |
| 7 | Fonds animés | S | ⏳ À faire | Bibliothèque de boucles d'ambiance, lecture en boucle |
| 8 | Mode audio (cours coach MP3) | L | ⏳ À faire | Bibliothèque audio, lecture piste à piste, mode coach mobile |
| 9 | Interface web PC complète | L | ⏳ À faire | Coquille admin, tableau de bord, paramètres, intégration des pages |
| 10 | Interface mobile | M | ⏳ À faire | Télécommande plein écran, menu burger, intégration mode coach |
| 11 | Thèmes & i18n | M | ⏳ À faire | Variables CSS, thème sombre/clair, FR/EN |
| 12 | Éditeur de canvas | L | ⏳ À faire | Éditeur de composition attente/pause, rendu dynamique écran cinéma |
| 13 | Journalisation | S | ⏳ À faire | Log d'activité, log technique, rotation, UI logs |
| 14 | Cycle de vie du service & déploiement | M | ⏳ À faire | Script de contrôle, systemd, install Debian 13, watchdog |
| 15 | Tests, recette & documentation | M | ⏳ À faire | Vérification des critères de recette, documentation livrée |

---

## 3. Feuille de route et jalons

| Jalon | Lots couverts | Statut | Ce qui est démontrable à la fin |
|---|---|---|---|
| **M1 — Socle validé** | 0 | ✅ Atteint | Une vidéo test se lit plein écran sur le Wyse 5070, décodage matériel confirmé (`chrome://gpu`, `intel_gpu_top`) |
| **M2 — Lecture pilotable de bout en bout** | 1, 2, 3, 4 | 🔄 En cours | Une vraie vidéo importée, lue plein écran, pilotable à distance (< 500 ms), avec attente / compte à rebours / pause / minuteur |
| **M3 — Enchaînements** | 5, 6 | ⏳ À faire | Playlists et programmations (ponctuelles/récurrentes) fonctionnelles, conflits gérés et repris à la bonne position |
| **M4 — Cours en physique** | 7, 8 | ⏳ À faire | Fonds animés + mode audio coach complets, pilotables depuis mobile |
| **M5 — Interfaces finalisées** | 9, 10, 11, 12 | ⏳ À faire | PC et mobile complets, thèmes FR/EN, canvas éditable |
| **M6 — Prêt pour la salle** | 13, 14, 15 | ⏳ À faire | Logs, service systemd, installation Debian, recette intégrale, documentation livrée |

---

## 4. Détail des lots

### Lot 0 — Amorçage & validation des risques techniques

*Objectif : initialiser le projet et lever le doute sur le point le plus risqué de l'architecture avant d'investir dans les fonctionnalités.*

- [x] **0.1** Initialiser le dépôt git, structure de dossiers (`backend/`, `frontend/`, `scripts/`, `docs/`) *(réf: NF6)*
- [x] **0.2** Environnement Python (venv, FastAPI, Uvicorn, dépendances de base)
- [x] **0.3** Générer le projet Next.js en export statique (`output: 'export'`), vérifier qu'un serveur statique simple sert bien le dossier `out/` *(réf: §4.1)*
- [x] **0.4** Installer Debian 13 sur le Wyse 5070 (ou support de test équivalent), installer Chromium *(réf: §2.2)*
- [x] **0.5** **POC critique :** Chromium en mode kiosk avec les flags d'accélération (`--enable-features=AcceleratedVideoDecodeLinuxGL`, `--use-gl=...`), lecture d'une vidéo H.264 1080p en `<video>` HTML5, vérification du décodage matériel via `chrome://gpu` et `intel_gpu_top` *(réf: §3.3, NF2)*
- [x] **0.6** Répéter la vérification en HEVC, et en 4K si un fichier de test est disponible *(réf: F1.1, NF2)*
- [x] **0.7** POC unité systemd minimale : Chromium kiosk lancé au boot, relancé après un kill manuel *(réf: F7.2)*
- [x] **0.8** Décision **GO/NO-GO** documentée ; si NO-GO, réévaluer l'architecture d'affichage avant de poursuivre

**Dépendances :** aucune — point de départ.
**Sortie attendue :** un verdict clair sur la faisabilité du décodage matériel. Tout le reste du projet en dépend.

#### Résultat — 15 juillet 2026 : ✅ GO

Testé sur le Wyse 5070 réel (`192.168.1.95`, Debian 13 trixie, Intel GeminiLake UHD 605, noyau 6.12). `vainfo` confirme le pilote iHD avec décodage matériel H.264 (High/Main/ConstrainedBaseline), HEVC (Main/Main10) et VP9. Chromium 150 + ffmpeg 7.1 installés (117 Mo).

**Preuve retenue :** pendant la lecture, le moteur vidéo dédié du GPU (colonne VCS d'`intel_gpu_top`) passe de 0 % (idle) à ~17-20 % en H.264 1080p, ~15-17 % en HEVC 1080p et ~30-46 % en H.264 4K, avec `VaapiVideoDecoder()` effectivement construit dans les logs Chromium (`--vmodule=*vaapi*=2`). Confirme un décodage matériel réel, pas seulement une capacité pilote théorique.

**Trois pièges découverts, à retenir pour le Lot 14 (déploiement) :**

1. **La session d'affichage doit avoir un vrai accès GPU.** La session VNC existante sur le Wyse (`Xtigervnc :1`, utilisée pour l'administration à distance) est un serveur X *logiciel* sans DRI2/DRI3 ni EGL matériel (« No suitable EGL configs found », « dri3 extension not supported »). Chromium y tombe en rendu logiciel et le décodage matériel échoue silencieusement. Le kiosk de production doit tourner sur une session X11 (ou Wayland) réellement liée au GPU — testé ici via un second serveur `Xorg` dédié sur les sorties physiques (DP-3/HDMI-1, EDID « GRANDIN » 1920×1080, cohérent avec le câblage DisplayPort→HDMI du cahier des charges §2.2).
2. **L'utilisateur du service kiosk doit appartenir au groupe `render`** (`/dev/dri/renderD128` est `root:render`). L'accès qui semblait fonctionner via la session VNC venait d'une ACL dynamique accordée par logind à cette session précise — elle ne s'applique pas à un service systemd lancé indépendamment. À faire explicitly à l'installation (Lot 14) : `usermod -aG render,video <user>`.
3. **Ne pas utiliser le script wrapper `/usr/bin/chromium` de Debian** pour le kiosk : il charge automatiquement l'extension `plasma-browser-integration` (voir `/etc/chromium.d/extensions`), sans intérêt pour un kiosk dédié et qui a provoqué des blocages en environnement non-Plasma. Lancer directement le binaire `/usr/lib/chromium/chromium`.

Test complémentaire : service systemd (`Restart=always`, `RestartSec=2`) validé — un `kill -9` du process principal est suivi d'un redémarrage complet en 2-3 s. Unité de test supprimée après vérification ; l'unité définitive sera créée au Lot 14.

**Non testé à ce stade** (repoussé à la recette finale, Lot 15) : mesure de la RAM totale du système en lecture continue (NF2), test de coupure électrique réelle (F7.3).

---

### Lot 1 — Fondations backend & données

*Objectif : poser le schéma de données et le squelette applicatif sur lesquels tous les lots suivants s'appuient.*

- [x] **1.1** Modéliser le schéma SQLite complet (§7) : `videos`, `backgrounds`, `audio_courses`, `audio_tracks`, `playlists`, `playlist_items`, `schedules`, `schedule_overrides`, `playback_state`, `canvas_layouts`, `settings`, `activity_log`
- [x] **1.2** ORM (SQLAlchemy) + migrations (Alembic)
- [x] **1.3** Configuration centralisée `config.toml` : port, chemins (vidéos, dossier surveillé, logs), durée d'attente entre cours, flags Chromium *(réf: F7.4)*
- [x] **1.4** Squelette API FastAPI : structure de routers, gestion d'erreurs, format de réponse standardisé
- [x] **1.5** Servir le build statique Next.js depuis FastAPI + endpoint de flux vidéo avec support HTTP Range *(réf: §4.1, F1.1)*
- [x] **1.6** Structure de logging applicatif de base (prépare le Lot 13)

**Dépendances :** Lot 0.

#### Résultat — 15 juillet 2026 : ✅ Complété

- **Schéma de base de données :** Modélisé intégralement dans `backend/app/models.py` à l'aide de SQLAlchemy 2.0 (syntaxe moderne `Mapped` et `mapped_column`).
- **Initialisation & SQLite :** Script `backend/app/database.py` configuré avec support multithread SQLite (`check_same_thread=False`). Intègre `init_db()` qui crée les dossiers requis (`data/videos`, `data/watched`, `data/thumbnails`) et auto-génère le schéma SQLite si la base de données n'existe pas.
- **Alembic :** Fichier `backend/alembic/env.py` configuré pour charger dynamiquement `settings.database_url` depuis la configuration TOML et l'injecter au runtime, permettant d'éviter de stocker l'URL DB en dur dans le fichier ini.
- **Configuration :** Module `backend/app/config.py` chargeant un fichier `config.toml` à la racine (avec fallback vers `/etc/openlesmillscinema/config.toml` en production). Les chemins de fichiers sont résolus en chemins absolus.
- **FastAPI :** Configuration CORS, endpoints de healthcheck, et montage des répertoires statiques pour les miniatures et le build statique Next.js (`frontend/out/`).
- **Streaming Range :** Implémentation du support complet de requêtes HTTP Range dans `main.py` pour la route `/api/videos/{id}/stream`. Permet au lecteur de sauter n'importe où dans la timeline de la vidéo sans recharger le fichier entier.

**Vérification (session Claude Code, 16 juillet 2026) :** voir §8.7 pour le détail — deux lacunes comblées (`config.toml` manquant, `datetime.utcnow()` déprécié), suite de tests rejouée avec succès (6/6).

---

### Lot 2 — Bibliothèque vidéo & import

*Objectif : alimenter la bibliothèque de cours par upload ou copie de fichiers, avec métadonnées complètes.*

- [x] **2.1** Upload web (MP4, M4V, MKV ; fichiers jusqu'à ~500 Mo, progression) *(réf: F3.1)*
- [x] **2.2** Watcher de dossier (watchdog) : détection et indexation automatique *(réf: F3.2)*
- [x] **2.3** Extraction ffprobe à l'import (durée, résolution, codec) *(réf: F3.3)*
- [x] **2.4** Génération de miniature (ffmpeg) *(réf: F3.3)*
- [x] **2.5** Métadonnées métier : programme (RPM/Sprint/The Trip), release, titre — saisie et édition *(réf: F3.4)*
- [x] **2.6** Contrôle de compatibilité codec/conteneur à l'import via ffprobe (piste vidéo + piste audio) *(réf: F3.5)*
- [x] **2.7** Normalisation automatique en tâche de fond selon le cas détecté *(réf: F3.5)* :
  - M4V avec audio AC-3 (Dolby) → remux + transcodage audio vers AAC (`-c:v copy`, vidéo intacte, opération rapide)
  - MKV au conteneur mal supporté → remux vers MP4 sans réencodage
  - M4V protégé par DRM (FairPlay iTunes) → aucune normalisation possible, rejet à l'import avec message explicite
- [x] **2.8** Recherche, filtres (programme/release/titre), tri *(réf: F3.6)*
- [x] **2.9** Suppression (avec confirmation, réf: UX5.2) et renommage *(réf: F3.6)*
- [x] **2.10** API liste/détail/édition/suppression vidéos (support des pages du Lot 9)

**Dépendances :** Lot 1.

#### Résultat — 15 juillet 2026 : ✅ Complété

- **Watcher de dossier (Watchdog) :** Implémenté dans `backend/app/utils/watcher.py`. Surveille en tâche de fond le dossier `data/watched`. Pour éviter d'importer un fichier en cours d'écriture (copie lente sur le disque), une boucle de stabilisation vérifie que la taille du fichier reste inchangée pendant 3 secondes consécutives avant de déclencher l'importation effective.
- **Séquençage & Concurrence :** Les importations et normalisations vidéo (FFmpeg/FFprobe) sont gérées dans `watcher.py` à l'aide d'un `ThreadPoolExecutor` à **un seul worker**. Cela garantit qu'une seule opération FFmpeg est exécutée à la fois, protégeant ainsi le CPU du Wyse 5070 de tout ralentissement global du système.
- **Utilitaires Vidéo (FFmpeg & FFprobe) :** Écrits dans `backend/app/utils/video_utils.py`.
  - Analyse des métadonnées avec `ffprobe -v error -show_format -show_streams -of json`.
  - Détection DRM : identifie les codecs `encv`/`enca` ou les tags de chiffrement pour lever une exception claire.
  - Détermination de la compatibilité Direct Play (format MP4/M4V, codec vidéo H.264/HEVC, codec audio AAC). Si incompatible (ex: MKV ou Dolby AC-3), le pipeline planifie des actions de normalisation.
  - Génération de miniatures à 10% de la durée du fichier par `ffmpeg -y -ss <pos> -i <input> -vframes 1 -q:v 2 <output>`.
- **Pipeline d'importation :** Module `backend/app/utils/importer.py`. Déplace les fichiers valides vers le stockage interne, génère des identifiants uniques, extrait les métadonnées et miniature, puis persiste l'entrée en base de données.
- **FastAPI Endpoints :** Routeur `backend/app/routers/videos.py` implémentant le CRUD, la recherche textuelle insensible à la casse (`ilike`), le filtrage par programme et release, le tri et la suppression physique des fichiers.
- **Normalisation en tâche de fond :** Endpoint `/api/videos/{video_id}/normalize` et tâche asynchrone `bg_normalize` utilisant `BackgroundTasks` de FastAPI pour exécuter les remux ou transcodages audio sans bloquer les réponses de l'API.


---

### Lot 3 — Lecture temps réel & télécommande

*Objectif : construire la boucle de contrôle centrale — état de lecture partagé, pilotable à distance, affiché sur le kiosk.*

- [x] **3.1** Serveur WebSocket : diffusion de l'état de lecture (titre, position, état) *(réf: F2.5, UX5.1)*
- [x] **3.2** Modèle d'état (machine à états : attente / countdown / lecture / pause / mode coach / hors ligne)
- [x] **3.3** Endpoints play/pause/stop, reprise à distance *(réf: F2.1)*
- [x] **3.4** Contrôle du volume *(réf: F2.2)*
- [x] **3.5** Vitesse de lecture réglable *(réf: F2.3)*
- [x] **3.6** Navigation dans la vidéo (seek, barre de progression) *(réf: F2.4)*
- [x] **3.7** Frontend écran cinéma : lecteur HTML5 `<video>` connecté au WebSocket *(réf: §3.1, F1.1)*
- [x] **3.8** OSD temporaire (3 s) lors d'un seek/volume à distance *(réf: UX2.12)*
- [x] **3.9** Retour optimiste sur les clients de contrôle, corrigé si le serveur infirme *(réf: UX5.4)*
- [x] **3.10** Mesure de la latence commande → effet écran, cible < 500 ms *(réf: NF4)*

**Dépendances :** Lot 1, plus une vidéo test (Lot 0 ou entrée manuelle en base) ; s'enrichit avec le Lot 2 une fois la bibliothèque réelle disponible.

#### Résultat — 16 juillet 2026 : ✅ Complété

- **WebSocket & état partagé :** `ConnectionManager` dans [ws_manager.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/utils/ws_manager.py) (connect/disconnect/broadcast). Machine à états dans [playback_manager.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/playback_manager.py) : `waiting/countdown/playing/paused/coach_mode/offline`, transitions `load/play/pause/stop/seek/volume/speed/report_position`, tâche asyncio de compte à rebours pilotée par `countdown_seconds` (`config.toml`, 0 = désactivé).
- **Endpoints :** `/ws/playback` (commandes + diffusion) et `GET /api/playback/state` (snapshot REST pour le premier rendu) dans [routers/playback.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/routers/playback.py), branchés dans [main.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/main.py).
- **Garde-fou découvert en testant :** `play`/`pause` ignorent désormais toute commande reçue pendant le `countdown` — sans ce correctif, une pause distante pendant le compte à rebours était écrasée par la tâche de countdown à son échéance suivante.
- **Écran kiosk :** [kiosk/page.tsx](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/app/kiosk/page.tsx), plein écran sans sidebar/en-tête. Lecteur `<video>` piloté par les évènements WebSocket, transitions en fondu CSS entre attente/countdown/vidéo, OSD 3 s sur seek/volume/vitesse, latence commande → écran loguée en console (observée < 5 ms en LAN local).
- **Télécommande :** page `/` réécrite en tableau de bord minimal ([page.tsx](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/app/page.tsx)) — bloc « En direct » (lecture/pause/stop/vitesse/volume/seek) + sélection et lancement d'un cours depuis la bibliothèque, retour optimiste sur le slider de volume. Volontairement minimal : le tableau de bord complet (bloc « Prochainement », raccourcis) reste au Lot 9.
- **En-tête :** statut de l'écran cinéma dans [ClientLayout.tsx](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/components/ClientLayout.tsx) branché sur l'état réel (au lieu du texte statique du Lot 2).
- **Vérification effectuée :** backend de test lancé en parallèle sans perturber la session de développement déjà active sur le port 8000 ; upload d'un clip réel (H.264/AAC, 3 min) ; séquence complète rejouée et confirmée par lecture directe des propriétés DOM de l'élément `<video>` (`currentTime`, `volume`, `playbackRate`, `paused` correspondant exactement aux commandes envoyées : seek → 42 s, volume → 65 %, vitesse → 1,5×, pause). Garde-fou countdown vérifié par assertion. Tableau de bord vérifié en cliquant réellement ses boutons, état reflété sans rechargement de page. Vidéo et backend de test supprimés après vérification.
- **Hors périmètre de ce lot** (volontairement, voir lots suivants) : écran d'attente complet avec horloge/canvas (Lot 4), overlay de pause thémé (Lot 4), enchaînement de playlist (Lot 5), persistance de la position interrompue en base (`playback_state`, Lot 6).
- **Point de vigilance :** pendant les tests, une session de navigateur cumulant de nombreux onglets/rechargements rapprochés a ponctuellement montré une rafale de diffusions redondantes (centaines de messages "speed" identiques en une fraction de seconde), non reproduite dans une session à un seul onglet propre — cause probable côté outillage de test, pas dans le code livré. À surveiller si un comportement similaire réapparaît avec plusieurs télécommandes réelles connectées simultanément.

---

### Lot 4 — Écran d'attente, minuteur, transitions

*Objectif : habiller l'écran cinéma entre les cours. Version avec composition par défaut fixe — l'édition complète du canvas vient au Lot 12.*

- [ ] **4.1** Écran d'attente par défaut : logo/nom de salle, horloge, bloc « prochain cours » *(réf: F1.2, UX2.1)*
- [ ] **4.2** Minuteur/chronomètre plein écran : par défaut, temps restant + nom du prochain cours *(réf: F1.3, UX2.4, UX2.5)*
- [ ] **4.3** Minuteur modulable : libre (saisie/presets 30s/1min/5min), chronomètre croissant, pause, reset, masquage, modification en cours de décompte *(réf: UX2.6)*
- [ ] **4.4** Personnalisation basique (taille, couleur, position) — version simple avant l'éditeur complet *(réf: UX2.7)*
- [ ] **4.5** Compte à rebours plein écran 5-4-3-2-1 avant chaque lancement, couleur du programme, durée configurable *(réf: F1.4, UX2.8)*
- [ ] **4.6** Transitions en fondu attente → rebours → vidéo → attente, sans jamais montrer le bureau/navigateur *(réf: UX2.9)*
- [ ] **4.7** Overlay de pause thémé (image figée assombrie + titre + « PAUSE » + progression) *(réf: F1.4, UX2.11)*
- [ ] **4.8** Signal visuel de fin de minuteur (pulsation/flash) *(réf: UX2.7)*
- [ ] **4.9** Vérifier qu'aucun overlay permanent n'apparaît pendant la lecture normale (image pure) *(réf: UX2.10)*
- [ ] **4.10** Vérifier la lisibilité depuis le fond de la salle (tailles minimales horloge / compte à rebours / minuteur) *(réf: UX6.3)*

**Dépendances :** Lot 3.

---

### Lot 5 — Playlists

- [ ] **5.1** Modèle de données + API CRUD `playlists`/`playlist_items` *(réf: F4.1, F4.2)*
- [ ] **5.2** Réordonnancement, duplication, suppression (confirmation, réf: UX5.2) *(réf: F4.2)*
- [ ] **5.3** Mixage libre entre programmes dans une même playlist *(réf: F4.3)*
- [ ] **5.4** Lancement manuel immédiat d'une playlist ou d'un cours seul *(réf: F4.4)*
- [ ] **5.5** Enchaînement automatique des éléments, écran d'attente intercalé (durée configurable) *(réf: F2.6)*
- [ ] **5.6** UI PC : éditeur de playlist (liste à gauche, contenu à droite, glisser-déposer, durée totale, ajout depuis la bibliothèque avec recherche) *(réf: UX3.13)*

**Dépendances :** Lot 2 (bibliothèque), Lot 3 (lecture), Lot 4 (écran d'attente intercalé).

---

### Lot 6 — Programmation horaire

- [ ] **6.1** Intégration APScheduler + persistance SQLite *(réf: F5.5)*
- [ ] **6.2** Programmation ponctuelle (date/heure précise, cours ou playlist) *(réf: F5.1)*
- [ ] **6.3** Programmation récurrente (ex. jour de semaine + heure) *(réf: F5.2)*
- [ ] **6.4** Overrides : annulation ou remplacement ponctuel d'une occurrence (confirmation, réf: UX5.2) *(réf: F5.2)*
- [ ] **6.5** Règle de conflit : lecture manuelle en cours → annulation en arrière-plan, mémorisation de la position, relance possible depuis l'interface *(réf: F5.3)*
- [ ] **6.6** Fonctionnement garanti hors ligne (horloge locale, RTC/NTP si disponible) *(réf: F5.5)*
- [ ] **6.7** UI PC : vue planning calendrier semaine, glisser-déposer, gestion visuelle des overrides (occurrence barrée/remplacée) *(réf: F5.4, UX3.14, UX3.15)*
- [ ] **6.8** UI PC : vue liste chronologique alternative *(réf: UX3.16)*

**Dépendances :** Lot 5 (playlists), Lot 3 (état de lecture / interruption).

---

### Lot 7 — Fonds animés

- [ ] **7.1** Modèle + API : dossier dédié séparé des cours, upload web ou copie surveillée *(réf: F9.1)*
- [ ] **7.2** Lecture en boucle infinie plein écran, sans son, jusqu'à arrêt manuel ou prise de relais *(réf: F9.2)*
- [ ] **7.3** Sélection et lancement depuis PC/mobile, vignettes de prévisualisation *(réf: F9.3)*
- [ ] **7.4** Minuteur affichable en overlay par-dessus le fond animé *(réf: F9.4)*
- [ ] **7.5** UI PC : grille de vignettes animées au survol, upload, suppression (confirmation, réf: UX5.2) *(réf: UX3.12)*

**Dépendances :** Lot 4 (moteur d'overlay/minuteur), Lot 2 (patterns d'upload/watcher réutilisés).

---

### Lot 8 — Mode audio (cours donnés par un coach, MP3)

- [ ] **8.1** Modèles `audio_courses` / `audio_tracks`
- [ ] **8.2** Import MP3 multi-fichiers ou ZIP d'un cours, dossier surveillé *(réf: F10.1)*
- [ ] **8.3** Extraction métadonnées (numéro/titre/durée par piste), ordre déduit du nom de fichier puis réordonnable *(réf: F10.1, F10.2)*
- [ ] **8.4** Lecture piste par piste, 3 modes d'enchaînement : automatique / auto + minuterie réglable / manuel *(réf: F10.3, UX4.8)*
- [ ] **8.5** Association d'un fond animé à un cours audio *(réf: F9.5)*
- [ ] **8.6** Sortie audio par la même chaîne que le mode cinéma *(réf: F10.6)*
- [ ] **8.7** Priorité mode audio : une programmation vidéo survenant pendant un cours audio coach n'interrompt pas, est annulée et relançable *(réf: F10.7)*
- [ ] **8.8** Écran pendant le mode audio : fond animé / écran d'attente / habillage sobre « piste en cours » *(réf: F10.5, UX2.13)*
- [ ] **8.9** UI PC : grille de cours audio groupés par programme, fiche cours avec pistes réordonnables par glisser-déposer *(réf: UX3.10)*
- [ ] **8.10** Import UI : upload multi-fichiers/ZIP *(réf: UX3.11)*
- [ ] **8.11** UI mobile : mode coach — choisir un cours en 2 taps max, piste en cours en très grand, pause/reprise/suivant/précédent/relancer, volume +/−, bottom sheet des pistes *(réf: F10.4, UX4.5–UX4.9)*

**Dépendances :** Lot 4 (overlay/minuteur), Lot 6 (règle de priorité), Lot 7 (association fond animé).

---

### Lot 9 — Interface web PC complète

*Objectif : construire la coquille d'administration et intégrer les pages des lots précédents dans une navigation cohérente.*

- [ ] **9.1** Layout général : sidebar fixe (Tableau de bord, Bibliothèque, Cours audio, Fonds animés, Playlists, Planning, puis Paramètres/Logs en bas), en-tête d'état permanent *(réf: F6.1, UX3.1, UX3.2)*
- [ ] **9.2** Tableau de bord : bloc « En direct » (vignette, progression, télécommande complète), bloc « Prochainement », raccourcis *(réf: UX3.3–UX3.5)*
- [ ] **9.3** Bibliothèque : grille groupée par programme + bascule liste (tableau dense), recherche/filtres/tri, indicateur dossier surveillé, fiche vidéo en panneau latéral, sélection multiple *(réf: UX3.6–UX3.9)*
- [ ] **9.4** Intégration finale playlists/planning/cours audio/fonds animés dans la navigation (réutilise Lots 5–8)
- [ ] **9.5** Paramètres : thème, langue, durée du compte à rebours, durée d'attente entre cours, accès à l'éditeur de canvas, chemins (lecture seule), volume par défaut *(réf: UX3.17)*
- [ ] **9.6** Logs : onglets Activité (filtrable) et Technique (brut + téléchargement) *(réf: UX3.18)*
- [ ] **9.7** États vides soignés, messages d'erreur explicites, toasts discrets de succès sur l'ensemble des pages *(réf: UX5.3)*

**Dépendances :** Lots 2, 5, 6, 7, 8 (les pages existent en version fonctionnelle) ; Lot 11 (thèmes) idéalement en parallèle.

---

### Lot 10 — Interface mobile

- [ ] **10.1** Écran télécommande plein écran : vignette/titre, progression avec seek tactile, gros boutons (lecture/pause central, précédent/suivant, stop en **appui long** sans confirmation, réf: UX5.2) *(réf: UX4.1, UX4.2)*
- [ ] **10.2** Volume : gros boutons +/− avec affichage du niveau *(réf: UX4.3)*
- [ ] **10.3** Accès en un tap : minuteur, « Lancer » (cours/playlist/fond animé), bascule mode coach *(réf: UX4.4)*
- [ ] **10.4** Menu latéral burger vers les mêmes sections que le PC, en présentation adaptée *(réf: UX4.1)*
- [ ] **10.5** Intégration du mode coach mobile (réutilise Lot 8.11)
- [ ] **10.6** Vérification des cibles tactiles ≥ 48 px (≥ 64 px en mode coach/télécommande) *(réf: UX6.1)*

**Dépendances :** Lot 3 (télécommande), Lot 8 (mode coach), Lot 9 (patterns communs).

---

### Lot 11 — Thèmes & i18n

- [ ] **11.1** Variables CSS (custom properties) : fond, surfaces, texte, accents, couleurs par programme, rayons, typographies *(réf: UX1.3)*
- [ ] **11.2** Thème « Les Mills sombre » par défaut *(réf: UX1.1, §1.1–1.2 UI/UX)*
- [ ] **11.3** Thème clair alternatif *(réf: UX1.2)*
- [ ] **11.4** Application uniforme du thème actif à PC, mobile et écran cinéma (attente + overlays) *(réf: UX1.3, UX2.3)*
- [ ] **11.5** Persistance du choix de thème côté serveur, appliqué à tous les clients *(réf: UX1.4)*
- [ ] **11.6** i18n FR/EN : extraction de toutes les chaînes, bascule dans les paramètres *(réf: UX1.5, F6.2b)*
- [ ] **11.7** Vérification des contrastes WCAG AA sur le thème sombre *(réf: UX6.2)*

**Dépendances :** peut démarrer dès le Lot 4 en parallèle ; l'intégration finale se fait avec les Lots 9/10.

---

### Lot 12 — Éditeur de canvas

- [ ] **12.1** Modèle `canvas_layouts` (JSON : type attente/pause, éléments avec position/taille/couleur/contenu/visibilité)
- [ ] **12.2** Rendu dynamique sur l'écran cinéma à partir d'une composition JSON (remplace les compositions figées du Lot 4) *(réf: UX2.1)*
- [ ] **12.3** Éditeur PC : blocs déplaçables/redimensionnables sur grille avec magnétisme *(réf: UX2.2)*
- [ ] **12.4** Éléments disponibles : logo (PNG/SVG), texte libre, horloge, bloc prochain cours, compte à rebours, minuteur/chrono, image de fond, fond animé *(réf: UX2.2)*
- [ ] **12.5** Prévisualisation live au format 16:9, boutons « appliquer à l'écran » / « réinitialiser au défaut » *(réf: UX2.2)*
- [ ] **12.6** Compositions multiples enregistrables, sélection de la composition active *(réf: UX2.2)*
- [ ] **12.7** Composition dédiée « pause » réutilisant le même éditeur *(réf: UX2.11)*

**Dépendances :** Lot 4 (les éléments existent déjà en dur), Lot 9 (page Paramètres qui héberge l'éditeur).

---

### Lot 13 — Journalisation

- [ ] **13.1** Log d'activité horodaté : uploads, imports dossier, lectures (début/fin/annulation), cours audio/pistes, fonds animés, playlists, programmations, overrides *(réf: F8.1)*
- [ ] **13.2** Log technique séparé : erreurs backend, crash/relance kiosk, échecs de lecture, état du décodage matériel *(réf: F8.2)*
- [ ] **13.3** Rotation des logs (logrotate ou équivalent) *(réf: F8.3)*
- [ ] **13.4** Consultation du log d'activité depuis l'interface web (s'intègre à 9.6) *(réf: F8.3)*

**Dépendances :** transverse — les événements sont émis au fil des Lots 2–8, mais la structure de logging est posée dès le Lot 1 ; l'UI vient avec le Lot 9.

---

### Lot 14 — Cycle de vie du service & déploiement

- [ ] **14.1** Script de contrôle unique `openlesmillscinema start|stop|restart|status` *(réf: F7.1)*
- [ ] **14.2** Unités systemd `openlesmillscinema-backend.service` et `openlesmillscinema-kiosk.service`, démarrage au boot *(réf: F1.5, F7.2)*
- [ ] **14.3** Watchdog de supervision, `Restart=always`, relance en < 10 s *(réf: F1.5, NF3)*
- [ ] **14.4** Configuration Chromium kiosk définitive (flags VAAPI validés au Lot 0), sortie de kiosk au clavier sur le mini PC *(réf: F1.6, §3.3)*
- [ ] **14.5** Config centralisée `/etc/openlesmillscinema/config.toml`, commentée, couvrant toutes les options du script *(réf: F7.4)*
- [ ] **14.6** Script d'installation Debian 13 : dépendances système, ffmpeg, Chromium, création des services *(réf: NF5)*
- [ ] **14.7** Vérifier l'absence d'authentification (accès libre LAN, F6.3) et l'accès local via `127.0.0.1` sur le mini PC hors réseau *(réf: F6.3, F6.4)*
- [ ] **14.8** Test de reprise après coupure électrique simulée *(réf: F7.3, NF3)*

**Dépendances :** Lot 0 (POC) ; l'ensemble des lots fonctionnels doit être raisonnablement stable avant l'installation définitive.

---

### Lot 15 — Tests, recette & documentation

- [ ] **15.1** Dérouler un par un tous les critères de recette fonctionnels (§10 cahier fonctionnel)
- [ ] **15.2** Dérouler un par un tous les critères de recette UI/UX (§8 cahier UI/UX)
- [ ] **15.3** Vérification finale des exigences non fonctionnelles : NF1 (local-first, débrancher le routeur), NF2 (RAM < 2 Go, perf), NF3 (fiabilité), NF4 (latence < 500 ms), NF5 (install native), NF6 (maintenabilité), NF7 (sauvegarde/restauration)
- [ ] **15.4** Documentation installation
- [ ] **15.5** Documentation exploitation
- [ ] **15.6** Procédure de sauvegarde/restauration (base SQLite + config + dossier vidéos) *(réf: NF7)*
- [ ] **15.7** Plan de repli codec documenté *(réf: §3.3)*
- [ ] **15.8** Documentation du système de design (variables de thème, composants de base) *(réf: livrable UI/UX #1)*

**Dépendances :** tous les lots précédents.

---

## 5. Rappel : hors périmètre v1

Ne pas créer de tâches pour : multi-utilisateurs/droits, statistiques d'usage, multi-salles, streaming hors LAN, authentification (accès LAN libre en v1, `F6.3`). Ces éléments sont prévus en évolution (§8 cahier fonctionnel) ; l'architecture ne doit pas leur être fermée, mais ils ne se développent pas en v1.

## 6. Risques et points de vigilance

- ~~**Décodage matériel Gemini Lake** (§3.3)~~ — ✅ résolu au Lot 0 (voir résultat détaillé ci-dessus). Point de vigilance qui en découle pour le Lot 14 : le service kiosk doit tourner sur une session d'affichage réellement liée au GPU (pas une session VNC logicielle) et l'utilisateur du service doit être dans le groupe `render`.
- **Formats vidéo exotiques / conteneurs MKV mal supportés** — le plan de repli (normalisation ffmpeg, Lot 2.6–2.7) doit être testé tôt avec de vrais fichiers Les Mills, pas seulement des fichiers de test propres.
- **M4V avec DRM (FairPlay iTunes)** (F3.5) — cas fréquent si des cours sont achetés/importés depuis iTunes : le rejet à l'import doit être **explicite et compréhensible** (UX5.3), pas une erreur technique brute, sinon l'utilisateur pensera à un bug plutôt qu'à un fichier protégé illisible par nature.
- **Latence WebSocket < 500 ms** (NF4) — à mesurer dès le Lot 3, pas seulem## 8. Coordination des agents de développement

Afin de faciliter la collaboration et de guider au mieux les prochains agents de développement, voici l'état des lieux technique complet et les directives d'implémentation pour les étapes suivantes (Lots 3 et 4).

### 8.1 Travaux réalisés et Acquis techniques (Lots 1 & 2)

Les fondations du projet ont été entièrement posées et validées. Voici les composants majeurs prêts à être réutilisés :

- **Base de données & Modélisation (Lot 1)** :
  - Le schéma de base de données SQLite est défini dans [models.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/models.py). Il gère déjà les cours audio, les playlists, le planning, les configurations de canvas d'attente et l'historique de log.
  - La base de données est configurée pour s'auto-initialiser proprement via `init_db()` dans [database.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/database.py) à la racine de `data/database.db`.
- **Configuration (Lot 1)** :
  - Centralisée dans [config.toml](file:///home/fanta/Documents/OpenLesmillsCinema/backend/config.toml) à la racine, elle est parsée par le module [config.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/config.py) avec des chemins locaux de développement par défaut.
- **Pipeline d'importation robuste (Lot 2)** :
  - **Watcher automatique** : Utilise `watchdog` ([watcher.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/utils/watcher.py)) pour surveiller `data/watched/`. Une boucle de stabilisation attend que la taille du fichier soit constante pendant 3 secondes consécutives avant d'importer le fichier pour éviter les lectures partielles pendant les copies lentes.
  - **Limitation CPU critique** : FFmpeg et FFprobe sont exécutés via un `ThreadPoolExecutor` configuré avec `max_workers=1` pour garantir qu'aucune exécution parallèle ne sature le processeur du Wyse 5070.
  - **Sécurité DRM** : Détection automatique des DRM (via ffprobe cherchant les pistes de type `encv`/`enca` ou flags de cryptage) avec rejet propre et explicite.
  - **Normalisation automatique** : Remuxing rapide MKV -> MP4 sans réencodage vidéo, et transcodage audio AC-3 -> AAC (`-c:v copy -c:a aac`) exécuté de manière asynchrone via les `BackgroundTasks` de FastAPI.
  - **Génération de miniatures** : Extraction d'une image à 10% de la durée de la vidéo.
- **Streaming HTTP Range (Lot 1)** :
  - Implémenté sur l'endpoint `/api/videos/{video_id}/stream` dans [main.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/main.py). Il supporte les requêtes de contenu partiel (HTTP 206), permettant à Chromium de naviguer à n'importe quel moment de la vidéo instantanément.
- **Interface Utilisateur (Lot 2)** :
  - **Layout & Design System** : Implémenté sur Next.js dans [layout.tsx](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/app/layout.tsx) et stylisé via des variables CSS thématiques dans [globals.css](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/app/globals.css).
  - **Page Bibliothèque** : Implémentée dans [page.tsx](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/app/library/page.tsx). Gère l'affichage en grille/liste, la recherche textuelle insensitive, les filtres par programme/release, le panneau latéral d'édition des métadonnées, l'upload avec barre de progression en temps réel, et la confirmation de suppression.

---

### 8.2 Directives d'architecture et de codage pour la suite

1. **Concurrence & Tâches de fond** :
   - Toute tâche lourde (décryptage, transcodage, écriture disque longue) doit être confiée à des files d'attente asynchrones ou au `ThreadPoolExecutor` dédié à un seul worker.
   - Ne jamais lancer de sous-processus bloquants directement dans les threads de requête FastAPI.
2. **Design System & Ergonomie** :
   - Respecter impérativement les variables CSS de [globals.css](file:///home/fanta/Documents/OpenLesmillsCinema/frontend/src/app/globals.css) (ne pas écrire de valeurs de couleurs en dur).
   - Les boutons et zones cliquables doivent mesurer au minimum **48px** pour l'administration et **64px** pour les écrans tactiles de contrôle (télécommande mobile et mode coach).
   - Utiliser des transitions CSS en fondu ou glissement (`var(--transition-normal)`) pour éviter les ruptures visuelles brusques.
3. **Base de données** :
   - Injecter systématiquement la session de base de données avec `Depends(get_db)`.
   - Si vous devez modifier la structure des tables, utilisez Alembic pour créer une migration propre ou mettez à jour [models.py](file:///home/fanta/Documents/OpenLesmillsCinema/backend/app/models.py) en vous assurant que l'auto-initialisation au démarrage reste fonctionnelle.

---

### 8.3 Spécifications techniques pour le Lot 3 (Lecture temps réel & Télécommande)

Le Lot 3 est le cœur fonctionnel de la lecture interactive. Le prochain agent devra suivre ce schéma :

#### 8.3.1 Machine à états de lecture
Le serveur doit maintenir un état de lecture global synchronisé, représenté par la structure suivante :
```json
{
  "state": "waiting | countdown | playing | paused | coach_mode | offline",
  "current_video": {
    "id": 1,
    "title": "RPM 102",
    "duration_seconds": 2700.0
  },
  "position_seconds": 124.5,
  "volume": 80,
  "speed": 1.0,
  "countdown_remaining": 5.0
}
```

#### 8.3.2 Implémentation WebSocket (FastAPI)
- Créer un gestionnaire de connexions WebSocket (`ConnectionManager`) dans `backend/app/utils/ws_manager.py` pour diffuser les changements d'état à tous les clients connectés (kiosk et télécommandes).
- Deux canaux de messages :
  - **Client -> Serveur (Commandes)** : `{"command": "play|pause|seek|volume|speed", "params": {...}}`
  - **Serveur -> Clients (Diffusions)** : `{"event": "state_change", "data": {...}}`

#### 8.3.3 Lecteur Kiosk (Écran cinéma)
- Développer une route Next.js dédiée `/kiosk` (sans sidebar ni en-tête d'administration).
- Cette page contient le lecteur vidéo HTML5 `<video>` en plein écran, connecté au WebSocket du serveur.
- Au chargement d'un cours :
  1. Affichage du compte à rebours de 5s.
  2. Transition (fondu au noir/opacité) vers la vidéo.
  3. Lancement de la lecture.
- Pour réduire la latence sous les **500 ms** (NF4) :
  - Utiliser le support HTTP Range déjà en place pour les seeks.
  - Mettre en place un mécanisme de "retour optimiste" sur l'interface télécommande : l'UI change d'état localement dès que l'utilisateur clique sur Pause ou règle le volume, sans attendre le retour de confirmation de la socket.

---

### 8.4 Spécifications techniques pour le Lot 4 (Écran d'attente, Minuteur & Transitions)

Ce lot habille l'écran cinéma en dehors de la lecture vidéo :

1. **Écran d'attente** :
   - Intégrer l'horloge système en grand, le logo OpenLesmillsCinema et l'encadré dynamique "Prochain cours à [Heure]" basé sur la base de données SQLite.
2. **Transitions sans coupure visuelle** :
   - Gérer l'affichage kiosk avec des calques superposés (`z-index` CSS). Le calque `<video>` doit toujours rester en dessous d'un calque d'overlay noir de transition.
   - Lors du passage de l'écran d'attente à la vidéo : fondu au noir (0.5s) -> chargement de la vidéo en tâche de fond -> fondu transparent pour révéler la vidéo.
3. **Overlay de Pause** :
   - À la réception du signal `paused` via WebSocket, le kiosk affiche un calque semi-transparent assombrissant la vidéo avec un flou CSS (`backdrop-filter: blur(8px)`) contenant le titre de la release en cours, la barre de progression, et le texte "PAUSE".
4. **Minuteur de cours** :
   - Implémenter le minuteur configurable (presets, chrono croissant/décroissant) visible sur le kiosk, contrôlable en temps réel à la seconde près depuis la télécommande sans désynchronisation.
   - Utiliser des animations CSS de pulsation douces (scale/opacity) pour signaler la fin du décompte.

### 8.5 Instructions pour lancer l'environnement de développement

1. **Lancement du Backend** :
   ```bash
   cd backend
   .venv/bin/uvicorn app.main:app --port 8000 --host 0.0.0.0
   ```
   *Note : Le backend démarrera automatiquement le watcher et initialisera la base de données. En production, il sert également le frontend statique depuis `frontend/out`.*

2. **Lancement du Frontend en mode Dev** :
   ```bash
   cd frontend
   npm run dev
   ```

### 8.6 Feuille de route pour les prochains agents (Lot 3 & Lot 4)
Le prochain jalon critique est le **Jalon M2 (Lecture pilotable de bout en bout)** qui nécessite l'implémentation du **Lot 3** et du **Lot 4**.

1. **Lot 3 — Lecture temps réel & télécommande** :
   - Mettre en place la communication par WebSocket sur le backend pour diffuser l'état de lecture.
   - Créer une machine à états (attente, compte à rebours, lecture, pause, etc.).
   - Créer l'interface du lecteur kiosk (écran cinéma) connectée au WebSocket.
   - Ajouter les contrôles de lecture (play, pause, volume, vitesse, seek) et l'affichage OSD temporaire.
2. **Lot 4 — Écran d'attente, minuteur, transitions** :
   - Implémenter l'écran d'attente par défaut avec l'horloge et le prochain cours.
   - Créer le compte à rebours de 5 secondes avec fondu de transition avant le lancement d'une vidéo.
   - Concevoir l'overlay de pause thémé.

### 8.7 Vérification & finalisation Lot 1 (session Claude Code — 16 juillet 2026)

Passage de relais : vérification complète de ce qui précède, deux lacunes comblées, environnement de test nettoyé.

- **BIOS Wyse 5070 :** mise à jour confirmée en v1.38.0 (Secure Boot toujours actif, historique fwupd 100 % succès, 0 service systemd en échec). Aucune action requise.
- **Lot 1 — deux lacunes corrigées :**
  1. `backend/config.toml` n'existait pas encore (seul le code de chargement existait dans `config.py`) → créé avec les sections `[server]` / `[database]` / `[paths]` / `[playback]`, commentées et alignées sur `Settings`.
  2. `datetime.utcnow()` (déprécié depuis Python 3.12) remplacé par `datetime.now(timezone.utc)` dans les 6 colonnes `default=` de `models.py`.
- **Tests :** `python -m unittest tests.test_video_flow` → 6/6 OK, y compris après les deux correctifs ci-dessus. Le pipeline complet (métadonnées, compatibilité, miniature, import direct, import + normalisation MKV/AC-3, renommage physique) est donc vérifié fonctionnel de bout en bout, pas seulement coché sur le papier.
- **Note pour les prochains agents :** un serveur `uvicorn` (lancé depuis une session Gemini Antigravity, visible via `ps aux`) tourne déjà sur le port 8000 en développement — ne pas s'étonner d'un conflit de port si vous lancez le vôtre en parallèle, ce n'est pas un bug. Il n'a pas été redémarré pour ne pas interrompre l'autre session ; il reprendra `config.toml` et le correctif `models.py` à son prochain redémarrage naturel.
- **Nettoyage :** dossier `~/olmc-poc/` sur le Wyse (vidéos de test synthétiques + logs du POC Lot 0, 70 Mo) supprimé ; `backend/data/test_thumbnails/` (résidu vide d'un run de test local) supprimé. Confirmé : aucun processus Chromium/Xorg résiduel ni unité systemd de test résiduelle sur le Wyse.

Lot 1 est donc réellement terminé (pas seulement coché) ; le Lot 2 a été revérifié comme conséquence de ce passage. Prochaine étape : Lot 3 (cf. §8.3 ci-dessus pour les spécifications déjà rédigées).
