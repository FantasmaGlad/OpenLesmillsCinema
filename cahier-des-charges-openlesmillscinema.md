# Cahier des charges — OpenLesmillsCinema

**Version :** 1.1 — 15 juillet 2026
**Auteur :** [Toi]
**Statut :** Validé pour développement
**Document lié :** Cahier des charges UI/UX v1.0 (spécification détaillée des interfaces)

---

## 1. Contexte et objectifs

### 1.1 Contexte

Le logiciel officiel Les Mills Cinema ne répond pas aux besoins de la salle : gestion des contenus rigide, pas de contrôle sur l'import des cours, ergonomie insuffisante. Le projet vise à le remplacer par une solution auto-hébergée, libre et entièrement contrôlée.

### 1.2 Objectif

Développer un système de home cinéma dédié aux cours Les Mills (RPM, Sprint, The Trip) permettant :

- l'import et la gestion libre de ses propres fichiers de cours ;
- la création de playlists (enchaînements de cours) ;
- la programmation horaire, ponctuelle et récurrente ;
- le pilotage complet à distance via une interface web sur le réseau local ;
- l'animation des cours donnés **en physique par un coach** : fonds animés projetés à l'écran et lecture des **pistes audio (MP3)** du cours, pilotées simplement depuis un téléphone ;
- un fonctionnement 100 % local (local-first) : la coupure d'Internet n'impacte aucune fonctionnalité.

### 1.3 Périmètre

- **Inclus :** lecture vidéo plein écran, gestion de bibliothèque, playlists, planning, contrôle à distance, écran d'attente, minuteur/chrono, **fonds animés pour cours donnés en physique**, **mode audio (MP3 des cours) avec pilotage simplifié par le coach depuis mobile**, logs, démarrage/arrêt par script, reprise automatique après coupure électrique.
- **Exclus (v1) :** multi-utilisateurs et droits, statistiques d'utilisation, multi-salles (prévu en évolution), streaming hors LAN.

---

## 2. Environnement matériel et logiciel

### 2.1 Machine de développement

| Élément | Détail |
|---|---|
| Modèle | HP Pavilion Laptop 16-ag0xxx |
| CPU / GPU | AMD Ryzen 7 8840U / Radeon 780M |
| RAM / Disque | 16 Go / 512 Go |
| OS | Ubuntu 26.04 LTS, GNOME 50, Wayland |

### 2.2 Machine de déploiement (serveur cinéma)

| Élément | Détail |
|---|---|
| Modèle | Dell Wyse 5070 (Intel Gemini Lake) |
| OS | Debian 13 « Trixie » |
| Sortie vidéo | DisplayPort → adaptateur HDMI → vidéoprojecteur |
| Stockage vidéos | SSD interne, extensible (upgrade SSD, disque USB ou clé USB) |
| Rôle | Serveur applicatif + affichage cinéma (décodage local, majoritairement 1080p, capable de 4K 60 Hz avec décodage matériel) |

### 2.3 Clients

- **PC (prioritaire) :** interface d'administration complète (bibliothèque, playlists, planning, upload).
- **Mobile (secondaire) :** usage « télécommande » rapide (lecture, pause, volume, navigation).
- **Local sur le mini PC :** sortie du mode kiosk avec clavier/souris et accès à l'interface d'administration via `http://127.0.0.1` — fonctionne donc même totalement hors réseau.

---

## 3. Architecture générale

### 3.1 Vue d'ensemble

Architecture centralisée « tout web » (option Chromium kiosk retenue pour sa fiabilité de centralisation et sa flexibilité visuelle) :

```
┌─────────────────────────── Wyse 5070 (Debian 13) ───────────────────────────┐
│                                                                             │
│  Backend Python (FastAPI)                                                   │
│   ├─ API REST (bibliothèque, playlists, planning, upload)                   │
│   ├─ WebSocket (état de lecture temps réel, commandes télécommande)         │
│   ├─ Scheduler (programmations ponctuelles et récurrentes)                  │
│   ├─ Watcher de dossier (import par copie de fichiers)                      │
│   ├─ Base SQLite                                                            │
│   └─ Sert le frontend (build statique Next.js) + flux vidéo (HTTP Range)    │
│                                                                             │
│  Chromium en mode kiosk (plein écran, sortie HDMI)                          │
│   └─ Page « écran cinéma » : lecteur HTML5 <video>, écran d'attente,        │
│      minuteur/chrono, overlays — pilotée par WebSocket                      │
│                                                                             │
│  Watchdog : supervision et relance automatique de Chromium et du backend    │
└─────────────────────────────────────────────────────────────────────────────┘
             ▲ LAN (HTTP/WebSocket, accès libre, port 80 ou 8080)
   PC admin ─┘─ Mobile télécommande ─┘
```

### 3.2 Principes

- **Un seul moteur d'affichage** (Chromium) pour la vidéo, l'attente, le minuteur et les overlays : pas de bascule entre processus, transitions visuelles maîtrisées, évolutivité graphique maximale.
- **Local-first :** aucune dépendance à Internet à l'exécution. Internet ne sert qu'au développement.
- **Installation native** (pas de Docker) pour des performances maximales sur le Gemini Lake.

### 3.3 Décodage vidéo — exigence critique

Le Gemini Lake exige le **décodage matériel** (VAAPI) dans Chromium. Le projet impose :

- Chromium lancé avec les flags d'accélération adaptés (`--enable-features=AcceleratedVideoDecodeLinuxGL`, `--use-gl=...`, à valider selon la version Debian 13) ;
- vérification en recette via `chrome://gpu` et `intel_gpu_top` que le décodage H.264/HEVC 1080p (et 4K le cas échéant) est bien matériel ;
- **plan de repli documenté :** si un fichier pose problème en HTML5 (codec exotique, conteneur MKV mal supporté), une étape de normalisation à l'import est prévue (voir §5.3).

---

## 4. Stack technologique

| Couche | Choix | Justification |
|---|---|---|
| Backend | **Python 3 + FastAPI + Uvicorn** | Léger, asynchrone (WebSocket natif), écosystème riche (APScheduler, watchdog, ffmpeg-python). |
| Base de données | **SQLite** | Mono-utilisateur, zéro administration, un simple fichier à sauvegarder. MariaDB serait surdimensionné ici. |
| Frontend | **Next.js (React) en export statique** | Voir §4.1. |
| Affichage salle | **Chromium mode kiosk** (page servie par le backend) | Centralisation, flexibilité visuelle (minuteur, overlays), un seul moteur. |
| Lecture vidéo | **`<video>` HTML5** + décodage matériel VAAPI | Intégré au kiosk ; contrôlable en JS via WebSocket. |
| Traitement vidéo | **ffmpeg / ffprobe** | Extraction de métadonnées, miniatures, normalisation éventuelle. |
| Planification | **APScheduler** (dans le backend) | Programmations ponctuelles + récurrentes avec persistance SQLite. |
| Supervision | **systemd** (+ script wrapper `openlesmillscinema`) | Démarrage au boot, relance après crash, reprise après coupure électrique. |

### 4.1 Pourquoi Next.js en export statique (et pas un serveur Node)

Next.js fonctionne normalement avec un serveur Node.js qui tourne en permanence pour faire du rendu côté serveur (SSR). Ici ce serait contre-productif, pour quatre raisons :

1. **RAM et CPU :** le Wyse 5070 doit garder ses ressources pour le décodage vidéo et le backend. Un process Node permanent consomme 100–300 Mo de RAM pour un bénéfice nul ici.
2. **Le SSR ne sert à rien dans ce contexte :** le SSR est utile pour le SEO et le premier affichage rapide de sites publics. Une interface d'administration LAN mono-utilisateur n'a besoin ni de l'un ni de l'autre — toutes les données viennent de l'API de toute façon.
3. **Moins de pièces mobiles :** avec `next build` en mode `output: 'export'`, on obtient un dossier de fichiers HTML/JS/CSS purs. FastAPI les sert comme fichiers statiques. Un seul service applicatif à superviser au lieu de deux.
4. **Tu gardes tout le confort React/Next :** composants, routing, hot-reload en dev sur ton laptop. Seul le déploiement change : on copie le dossier `out/` sur le serveur.

En résumé : Next.js sert d'**outil de build** confortable ; à l'exécution, il ne reste que des fichiers statiques.

---

## 5. Spécifications fonctionnelles

### 5.1 Écran cinéma (mode kiosk)

- **F1.1** — Lecture vidéo plein écran (MP4, M4V, MKV ; H.264/HEVC ; majoritairement 1080p, 4K supporté). Le M4V étant une variante du conteneur MP4, il est traité nativement ; voir F3.5 pour les cas particuliers (audio AC-3, DRM).
- **F1.2** — Écran d'attente entre les cours : **canvas entièrement personnalisable** depuis l'interface PC (logo importable, textes, horloge, prochain cours, couleurs, positions des éléments ; plusieurs compositions enregistrables). Voir doc UI/UX §2.1.
- **F1.3** — Minuteur / chronomètre en élément de canvas, plein écran par défaut ; **affiche par défaut le temps restant avant le prochain cours et son nom** ; temps modifiable en cours de décompte ; personnalisable (taille, couleur, position). Voir doc UI/UX §2.2.
- **F1.4** — Transitions propres : attente → **compte à rebours 5-4-3-2-1** aux couleurs du programme (durée configurable) → cours → attente. **Overlay de pause** personnalisé et thémé. Voir doc UI/UX §2.3–2.4.
- **F1.5** — Le kiosk démarre automatiquement au boot et se relance en cas de crash (watchdog).
- **F1.6** — Sortie du mode kiosk possible au clavier sur le mini PC pour accéder à l'administration locale.

### 5.2 Contrôle de lecture (télécommande web)

- **F2.1** — Lecture / pause / stop, reprise à distance.
- **F2.2** — Volume (contrôle du volume système ou du lecteur).
- **F2.3** — Vitesse de lecture réglable.
- **F2.4** — Navigation dans la vidéo (seek, barre de progression).
- **F2.5** — État temps réel visible sur tous les clients (titre en cours, position, état) via WebSocket.
- **F2.6** — Enchaînement automatique des éléments d'une playlist, avec écran d'attente intercalé (durée configurable).

### 5.3 Bibliothèque et import des vidéos

- **F3.1** — Import par **upload via l'interface web** (MP4, M4V, MKV ; fichiers jusqu'à ~500 Mo, barre de progression).
- **F3.2** — Import par **dossier surveillé** : toute vidéo copiée dans le dossier (USB, réseau, etc.) est détectée et indexée automatiquement.
- **F3.3** — À l'import : extraction automatique des métadonnées techniques (durée, résolution, codec) via ffprobe, génération d'une miniature.
- **F3.4** — Métadonnées métier normées Les Mills : **programme** (RPM / Sprint / The Trip), **numéro de release**, titre libre. Saisie/édition via l'interface.
- **F3.5** — Contrôle de compatibilité à l'import (ffprobe) : si le codec/conteneur n'est pas lisible nativement par Chromium, normalisation automatique en tâche de fond. Cas typiques :
  - **M4V avec audio AC-3 (Dolby)** : non décodé par Chromium sous Linux → remux automatique avec transcodage audio vers AAC (`-c:v copy`, vidéo intacte, opération rapide) ;
  - **MKV au conteneur mal supporté** : remux vers MP4 sans réencodage ;
  - **M4V protégé par DRM (FairPlay iTunes)** : illisible par nature — le fichier est rejeté à l'import avec un message explicite.
- **F3.6** — Recherche et filtres (programme, release, titre) ; suppression et renommage.

### 5.4 Playlists

- **F4.1** — Une playlist = un enchaînement ordonné de cours (ex. échauffement + RPM 98 + stretching).
- **F4.2** — Création, édition (réordonnancement), duplication, suppression.
- **F4.3** — Mixage libre entre programmes (RPM + Sprint + The Trip dans une même playlist).
- **F4.4** — Lancement manuel immédiat d'une playlist ou d'un cours seul.

### 5.5 Programmation horaire

- **F5.1** — Programmation **ponctuelle** : un cours ou une playlist à une date/heure précise.
- **F5.2** — Programmation **récurrente** : ex. « RPM tous les mardis 18h00 », avec **override** possible (exception ponctuelle : annulation ou remplacement d'une occurrence).
- **F5.3** — **Règle de conflit :** si une lecture manuelle est en cours à l'heure d'un programme, le cours interrompu en arrière-plan est **annulé** ; la programmation suivante prendra normalement sa place. Le cours annulé reste **relançable à sa position exacte** depuis l'interface web (PC ou mobile) — le système mémorise la position d'interruption.
- **F5.4** — Vue planning (semaine) dans l'interface d'administration.
- **F5.5** — Le scheduler fonctionne intégralement hors ligne (horloge locale ; RTC + NTP quand disponible).

### 5.6 Interface web

- **F6.1** — **PC-first :** administration complète (bibliothèque façon « petit NAS » grille/liste, upload, cours audio, fonds animés, playlists, planning en calendrier drag & drop, éditeur de canvas, logs, paramètres) **+ télécommande complète intégrée au tableau de bord**. Voir doc UI/UX §3.
- **F6.2** — **Mobile :** télécommande plein écran par défaut (gros boutons, volume +/−) et **mode coach audio** (F10.4) ; toutes les fonctions d'administration restent accessibles via un menu latéral discret. Voir doc UI/UX §4.
- **F6.2b** — **Thèmes :** thème « Les Mills sombre » par défaut (couleurs signature par programme), thèmes commutables dans les paramètres, appliqués à toutes les interfaces y compris l'écran cinéma. **Langues FR/EN** dès la v1 (bascule dans les paramètres). Voir doc UI/UX §1.
- **F6.3** — Accès **libre sur le LAN**, sans authentification (v1). Le serveur n'écoute que sur le réseau local.
- **F6.4** — Accessible en local sur le mini PC via `127.0.0.1` (fonctionnement hors réseau garanti).

### 5.7 Cycle de vie du service

- **F7.1** — Script de contrôle unique : `openlesmillscinema start | stop | restart | status`.
- **F7.2** — Le script pilote des unités **systemd** (`openlesmillscinema-backend.service`, `openlesmillscinema-kiosk.service`) : démarrage automatique au boot, relance automatique en cas de crash (`Restart=always`).
- **F7.3** — **Reprise après coupure électrique :** au retour du courant, la machine boote, les services démarrent seuls, le kiosk réaffiche l'écran d'attente, le scheduler reprend le planning. Aucune intervention manuelle.
- **F7.4** — Configuration centralisée dans un fichier unique (`/etc/openlesmillscinema/config.toml`) : port, chemins (vidéos, dossier surveillé, logs), durée d'attente entre cours, flags Chromium, etc. Toutes les options du script de lancement y sont configurables.

### 5.8 Fonds animés (cours en physique)

Quand un cours est donné en direct par un coach (sans vidéo Les Mills), l'écran diffuse un **fond animé** d'ambiance.

- **F9.1** — Bibliothèque de fonds animés stockée dans un **dossier dédié**, séparé des cours (boucles vidéo MP4/MKV/WebM ; import par upload web ou copie dans le dossier, comme les cours).
- **F9.2** — Lecture en **boucle infinie** plein écran, sans son, jusqu'à arrêt manuel ou prise de relais par une lecture/programmation.
- **F9.3** — Sélection et lancement d'un fond depuis l'interface web (PC et mobile), avec vignettes de prévisualisation.
- **F9.4** — Le minuteur/chrono (F1.3) reste affichable en overlay par-dessus le fond animé.
- **F9.5** — Un fond animé peut être **associé au mode audio** (F10) : le fond tourne à l'écran pendant que les MP3 du cours jouent.

### 5.9 Mode audio — cours donnés par un coach (MP3)

Permet de jouer les **pistes musicales (MP3) d'un cours** pendant que le coach l'anime en physique.

- **F10.1** — Bibliothèque audio : les MP3 sont regroupés par **cours** (ex. « RPM 110 » = ses pistes ordonnées). Import par upload web (multi-fichiers ou archive ZIP d'un cours) ou par dossier surveillé ; ordre des pistes déduit du nom de fichier et réordonnable dans l'interface.
- **F10.2** — Métadonnées par cours audio : programme (RPM / Sprint / The Trip / autre), numéro de release, liste des pistes (numéro, titre, durée extraite automatiquement).
- **F10.3** — Lecture d'un cours audio : piste par piste, avec **trois modes d'enchaînement** commutables en direct : automatique, automatique avec minuterie entre les pistes (durée réglable), ou manuel (le coach lance chaque piste).
- **F10.4** — **Mode coach sur mobile — simplicité prioritaire.** Écran dédié, épuré, gros boutons utilisables en plein cours :
  - choisir un cours (ex. RPM 110) et le lancer en 2 taps maximum ;
  - piste en cours bien visible (numéro, titre, temps restant) ;
  - pause / reprise, piste suivante / précédente, **relancer la piste en cours depuis le début** ;
  - volume avec gros contrôle tactile ;
  - liste des pistes du cours pour sauter directement à un track (ex. lancer le track 5).
- **F10.5** — Pendant le mode audio, l'écran affiche au choix : un fond animé (F9), l'écran d'attente, ou un habillage sobre indiquant la piste en cours.
- **F10.6** — Le son sort par la même chaîne audio que le mode cinéma (sortie du mini PC vers l'ampli).
- **F10.7** — Règles de priorité identiques à F5.3 : une programmation vidéo qui survient pendant un cours audio piloté par le coach **n'interrompt pas** le mode audio (le coach est prioritaire) ; la programmation est annulée et relançable ensuite.

### 5.10 Journalisation

- **F8.1** — **Log d'activité** (lisible, horodaté) : téléversements, imports par dossier, vidéos jouées (début/fin/annulation), cours audio joués et pistes lancées, fonds animés lancés, créations/modifications de playlists, programmations, overrides.
- **F8.2** — **Log technique** séparé pour le diagnostic : erreurs backend, crashs/relances du kiosk, échecs de lecture, état du décodage matériel.
- **F8.3** — Rotation des logs (logrotate ou équivalent). Consultation du log d'activité depuis l'interface web.

---

## 6. Exigences non fonctionnelles

| Réf. | Exigence |
|---|---|
| NF1 | **Local-first :** aucune fonctionnalité ne dépend d'Internet à l'exécution. |
| NF2 | **Performance :** lecture 1080p fluide sans saccade sur le Wyse 5070 ; décodage matériel obligatoire ; RAM totale du système < 2 Go en lecture. |
| NF3 | **Fiabilité :** relance automatique de tout composant crashé en < 10 s ; reprise complète après coupure électrique sans intervention. |
| NF4 | **Latence télécommande :** commande → effet à l'écran < 500 ms sur le LAN. |
| NF5 | **Installation native** sur Debian 13, sans Docker. Script d'installation documenté. |
| NF6 | **Maintenabilité :** code versionné (git), configuration séparée du code, documentation d'installation et d'exploitation. |
| NF7 | **Sauvegarde :** la base SQLite + le fichier de config + le dossier vidéos suffisent à restaurer entièrement le système. |

---

## 7. Modèle de données (SQLite — schéma indicatif)

- **videos** : id, chemin fichier, titre, programme (RPM/Sprint/The Trip), release, durée, résolution, codec, miniature, date d'import, source (upload/dossier).
- **backgrounds** : id, chemin fichier (dossier dédié), titre, durée, vignette, date d'import.
- **audio_courses** : id, programme, release, titre, fond animé associé (optionnel), date d'import.
- **audio_tracks** : audio_course_id, numéro, titre, chemin fichier MP3, durée, ordre.
- **playlists** : id, nom, date de création.
- **playlist_items** : playlist_id, video_id, ordre.
- **schedules** : id, cible (vidéo ou playlist), type (ponctuel/récurrent), règle de récurrence, date/heure, actif.
- **schedule_overrides** : schedule_id, date de l'occurrence, action (annulée/remplacée), cible de remplacement.
- **playback_state** : dernière lecture interrompue (video_id, position, cause) — pour la reprise F5.3.
- **canvas_layouts** : id, type (attente/pause), nom, définition JSON des éléments (type, position, taille, couleur, contenu), active.
- **settings** : clé/valeur (thème actif, langue, durée du compte à rebours, attente entre cours, volume par défaut…).
- **activity_log** : horodatage, type d'événement, détail.

---

## 8. Évolutions prévues (hors v1, à ne pas bloquer par l'architecture)

- **Multi-salles :** un backend central pilotant plusieurs écrans kiosk (l'architecture WebSocket + identifiant d'écran le permet nativement).
- **Nouveaux programmes de cours** au-delà de RPM/Sprint/The Trip (le champ « programme » sera extensible, pas un enum figé).
- Améliorations visuelles de l'écran cinéma (thèmes, animations, habillage par programme).

---

## 9. Livrables

1. Code source (backend FastAPI + frontend Next.js) sous git.
2. Script d'installation pour Debian 13 (dépendances, unités systemd, config Chromium kiosk).
3. Script de contrôle `openlesmillscinema`.
4. Fichier de configuration commenté.
5. Documentation : installation, exploitation, procédure de sauvegarde/restauration, plan de repli codec.
6. Cahier des charges UI/UX (document lié) et ses livrables propres : système de design, thèmes, fichiers de langue FR/EN.

## 10. Critères de recette

- ✅ Boot à froid → écran d'attente affiché sans intervention.
- ✅ Coupure électrique simulée → reprise complète automatique.
- ✅ Lecture 1080p H.264 et HEVC fluide, décodage matériel vérifié (`chrome://gpu`).
- ✅ Upload web d'un MP4 de 500 Mo + import par copie dans le dossier surveillé → les deux apparaissent dans la bibliothèque avec miniature et métadonnées.
- ✅ Import d'un **M4V avec audio AC-3** → remux automatique vers AAC, lecture avec son ; M4V avec DRM → rejet avec message explicite.
- ✅ Playlist de 3 cours : enchaînement automatique avec écran d'attente entre chaque.
- ✅ Programme récurrent + override d'une occurrence → comportement conforme.
- ✅ Conflit lecture manuelle / programmation → annulation + reprise à position exacte depuis mobile.
- ✅ Télécommande mobile : pause/volume/seek < 500 ms.
- ✅ Import d'un cours audio (ZIP de MP3 « RPM 110 ») → pistes ordonnées et durées extraites automatiquement.
- ✅ Mode coach mobile : lancer RPM 110 en 2 taps, pause, relance de la piste en cours, saut au track 5, volume — chaque action < 500 ms.
- ✅ Fond animé lancé depuis mobile, en boucle, minuteur en overlay, pendant que les MP3 jouent.
- ✅ Programmation vidéo survenant pendant un cours audio en mode coach → non-interruption, programmation annulée et relançable.
- ✅ Débranchement du routeur → tout fonctionne en local sur le mini PC via 127.0.0.1.
- ✅ Logs d'activité et technique alimentés et consultables.
