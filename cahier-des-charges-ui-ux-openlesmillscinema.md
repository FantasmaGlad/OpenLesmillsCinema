# Cahier des charges UI/UX — OpenLesmillsCinema

**Version :** 1.0 — 15 juillet 2026
**Document lié :** Cahier des charges fonctionnel v1.1
**Périmètre :** écran cinéma (projecteur), interface web PC, interface web mobile.

---

## 1. Direction artistique

### 1.1 Univers visuel

L'interface s'inscrit dans l'univers **Les Mills** : noir premium, contrastes forts, énergie contenue.

- **Fond dominant :** noir profond / anthracite (`#0A0A0A` – `#141414`), surfaces en léger relief (`#1C1C1E`).
- **Typographie :** sans-serif condensée et impactante pour les titres (style athlétique, majuscules, graisse forte — ex. *Archivo Expanded*, *Barlow Condensed* ou équivalent libre), sans-serif neutre et lisible pour le corps (ex. *Inter*).
- **Ton :** sobre, dense, sans fioritures. Les couleurs vives sont réservées aux accents, jamais en aplats massifs.
- **Imagerie :** vignettes des cours mises en avant, traitées sur fond sombre ; pas d'illustrations décoratives.

### 1.2 Couleurs par programme

Chaque programme possède sa couleur signature, utilisée systématiquement (badges, bordures de vignettes, accents du mode coach, habillage de l'écran cinéma) :

| Programme | Couleur d'accent | Usage |
|---|---|---|
| RPM | Rouge (`#E4002B` env.) | Badge, vignette, écran coach RPM |
| Sprint | Jaune (`#FFB81C` env.) | idem |
| The Trip | Bleu/violet (`#5C2D91` env.) | idem |
| Autre / non classé | Gris neutre | idem |

Les couleurs par programme sont **définies dans le système de thème** (voir 1.3) et donc modifiables — notamment pour l'ajout futur de nouveaux programmes.

### 1.3 Système de thèmes

- **UX1.1** — Le thème « Les Mills sombre » est le thème par défaut.
- **UX1.2** — L'utilisateur peut **changer de thème** dans les paramètres web : au minimum un thème clair alternatif en v1, architecture ouverte à des thèmes additionnels.
- **UX1.3** — Un thème = un jeu de variables (couleurs de fond, surfaces, texte, accents, couleurs par programme, rayons, typographies). Implémentation en **CSS custom properties**, appliquées à l'ensemble : PC, mobile **et écran cinéma** (l'écran d'attente et les overlays suivent le thème actif).
- **UX1.4** — Le choix du thème est persistant (stocké côté serveur, appliqué à tous les clients).

### 1.4 Langues

- **UX1.5** — Interface **FR/EN** dès la v1 (français par défaut). Bascule dans les paramètres web. Toute chaîne de texte passe par le système d'internationalisation (aucun texte codé en dur) pour préparer un export futur.

---

## 2. Écran cinéma (projecteur)

### 2.1 Écran d'attente — canvas personnalisable

L'écran d'attente n'est pas figé : c'est un **canvas éditable** depuis l'interface PC.

- **UX2.1** — **Composition par défaut :** logo/nom de la salle centré, horloge, bloc « prochain cours » (nom + compte à rebours), fond au choix (couleur du thème, image, ou fond animé discret).
- **UX2.2** — **Éditeur de canvas (PC)** : les éléments sont des blocs déplaçables et redimensionnables sur une grille avec magnétisme :
  - éléments disponibles : logo importable (PNG/SVG), texte libre, horloge, bloc prochain cours, compte à rebours, minuteur/chrono, image de fond, fond animé ;
  - propriétés par élément : position, taille, couleur (dans la palette du thème ou libre), visibilité ;
  - prévisualisation en direct au format 16:9, bouton « appliquer à l'écran » et « réinitialiser au défaut » ;
  - plusieurs compositions enregistrables (ex. « Attente standard », « Soirée The Trip »), avec sélection de la composition active.
- **UX2.3** — L'écran d'attente respecte le thème actif (couleurs, typographies) sauf surcharges explicites dans le canvas.

### 2.2 Minuteur / chronomètre

- **UX2.4** — Le minuteur/chrono est un **élément du canvas**, positionnable librement, **plein écran par défaut** (chiffres géants centrés, lisibles du fond de la salle).
- **UX2.5** — **Comportement par défaut :** lorsqu'il est affiché sans réglage manuel, il montre le **temps restant avant le prochain cours programmé**, avec le **nom du cours** en dessous.
- **UX2.6** — **Modulable :** depuis PC ou mobile, on peut le passer en minuteur libre (durée saisie ou presets 30 s / 1 min / 5 min / personnalisé), en chronomètre croissant, le mettre en pause, le réinitialiser, le masquer. Modification du temps possible en cours de décompte (+/- rapide).
- **UX2.7** — **Personnalisable :** taille, couleur (défaut : accent du thème), position via le canvas ; signal visuel de fin (pulsation/flash de l'écran, pas de son en v1).

### 2.3 Lancement d'un cours — compte à rebours

- **UX2.8** — Toute transition attente → cours passe par un **compte à rebours plein écran « 5-4-3-2-1 »** (durée configurable 0–10 s, 5 s par défaut ; 0 = désactivé), dans la couleur du programme du cours lancé, avec le titre du cours affiché. Cohérent avec les intros des cours Les Mills.
- **UX2.9** — Transitions en fondu propre : attente → rebours → vidéo → attente. Aucune image de bureau/navigateur jamais visible.

### 2.4 Pendant la lecture

- **UX2.10** — Lecture = image pure, **aucun overlay permanent**.
- **UX2.11** — **Overlay de pause personnalisé :** lors d'une pause, un habillage aux couleurs du thème s'affiche (image figée assombrie + titre du cours + « PAUSE » + barre de progression). Il est personnalisable via le même éditeur de canvas (composition « pause »).
- **UX2.12** — OSD temporaire (3 s) lors d'un seek ou changement de volume à distance : fine barre de progression + indicateur, puis disparition.

### 2.5 Mode audio / fonds animés à l'écran

- **UX2.13** — Pendant un cours audio (mode coach), l'écran affiche au choix : fond animé associé, écran d'attente, ou habillage sobre « piste en cours » (n° de track, titre, temps restant de piste) aux couleurs du programme.

---

## 3. Interface web PC (administration)

### 3.1 Structure générale

- **UX3.1** — **Sidebar fixe à gauche**, sections dans l'ordre :
  1. **Tableau de bord**
  2. **Bibliothèque** (vidéos)
  3. **Cours audio**
  4. **Fonds animés**
  5. **Playlists**
  6. **Planning**
  — en bas de sidebar : **Paramètres** et **Logs**.
- **UX3.2** — En-tête permanent : état de l'écran cinéma (Attente / Lecture : titre / Mode coach / Hors ligne) avec pastille de statut, visible sur toutes les pages.

### 3.2 Tableau de bord

- **UX3.3** — Bloc « **En direct** » : vignette/état de ce qui joue, barre de progression, et **télécommande complète** (lecture/pause/stop, précédent/suivant, seek, volume, vitesse) — la version PC inclut toutes les commandes du mobile.
- **UX3.4** — Bloc « Prochainement » : les 3 prochaines programmations, avec accès rapide au planning.
- **UX3.5** — Raccourcis : lancer une playlist, lancer un fond animé, afficher le minuteur, passer en mode coach.

### 3.3 Bibliothèque (vidéos) — esprit « petit NAS »

- **UX3.6** — **Vue grille par défaut, groupée par programme** (sections RPM / Sprint / The Trip / Autre avec leur couleur), vignettes 16:9, badge release, durée. **Bascule grille ⇄ liste** (tableau dense : titre, programme, release, durée, résolution, codec, date, taille) — l'esprit d'un gestionnaire de fichiers NAS.
- **UX3.7** — Barre supérieure : recherche instantanée, filtres (programme, release), tri, bouton **Téléverser** (zone de glisser-déposer, files d'upload avec progression), indicateur du dossier surveillé.
- **UX3.8** — Fiche vidéo (panneau latéral) : lecture immédiate, édition des métadonnées, ajout à une playlist, état de compatibilité codec (avec action « normaliser » si besoin), suppression (avec confirmation).
- **UX3.9** — Sélection multiple : ajout groupé à une playlist, suppression groupée (confirmation).

### 3.4 Cours audio

- **UX3.10** — Même logique : grille de cours groupés par programme ; fiche cours = liste ordonnée des pistes (n°, titre, durée), réordonnable par glisser-déposer, association d'un fond animé, réglage de l'enchaînement par défaut (auto / minuterie entre pistes / manuel — voir UX4.8).
- **UX3.11** — Import : upload multi-fichiers MP3 ou ZIP d'un cours complet.

### 3.5 Fonds animés

- **UX3.12** — Grille de vignettes animées au survol, lancement en un clic, upload, suppression (confirmation).

### 3.6 Playlists

- **UX3.13** — Liste des playlists à gauche, contenu de la playlist sélectionnée à droite : réordonnancement par **glisser-déposer**, durée totale calculée, ajout depuis la bibliothèque (recherche intégrée), duplication, lancement immédiat.

### 3.7 Planning

- **UX3.14** — **Vue calendrier semaine** (type agenda) avec **glisser-déposer** des cours/playlists sur les créneaux ; les blocs portent la couleur de leur programme.
- **UX3.15** — Création/édition d'une programmation : ponctuelle ou récurrente (jours de semaine, heure), avec gestion visuelle des **overrides** (occurrence barrée = annulée, badge = remplacée).
- **UX3.16** — Vue liste chronologique en alternative.

### 3.8 Paramètres et logs

- **UX3.17** — Paramètres : thème, langue (FR/EN), durée du compte à rebours de lancement, durée d'attente entre cours d'une playlist, éditeur de canvas (attente + pause), chemins d'information (lecture seule), volume par défaut.
- **UX3.18** — Logs : onglets « Activité » (lisible, filtrable par type et date) et « Technique » (consultation brute, téléchargement).

---

## 4. Interface web mobile

### 4.1 Philosophie

- **UX4.1** — Le mobile est une **télécommande plein écran** avant tout. Pas de navigation permanente visible : l'écran principal est dédié au contrôle. Les autres sections (bibliothèque, playlists, planning, paramètres — mêmes capacités que le PC, en présentation adaptée) sont accessibles via un **menu latéral (burger)** volontairement discret.

### 4.2 Écran télécommande (accueil mobile)

- **UX4.2** — Plein écran : vignette/titre de ce qui joue, barre de progression avec seek tactile, puis **gros boutons** : lecture/pause central (le plus grand), précédent/suivant, stop. Le stop est direct (pas de boîte de confirmation, cf. UX5.2) mais déclenché par **appui long** pour éviter un arrêt accidentel en plein cours.
- **UX4.3** — **Volume : gros boutons + / −** (pas de slider fin), avec affichage du niveau. Pas de retour haptique requis.
- **UX4.4** — Accès en un tap depuis la télécommande : minuteur (presets + temps du prochain cours), « Lancer » (cours / playlist / fond animé, listes simples avec recherche), bascule mode coach.

### 4.3 Mode coach (audio)

- **UX4.5** — Écran dédié plein écran, dans la couleur du programme du cours : nom du cours (ex. RPM 110), **piste en cours en très grand** (n° + titre + temps restant).
- **UX4.6** — Boutons géants : **pause/reprise** (central), **piste suivante**, **piste précédente**, **relancer la piste au début**, volume **+ / −**. Actions **directes, sans confirmation** et sans verrouillage.
- **UX4.7** — Liste des pistes accessible d'un glissement (bottom sheet) pour sauter directement à un track.
- **UX4.8** — **Modes d'enchaînement** commutables depuis cet écran :
  - **Auto** : les pistes s'enchaînent seules ;
  - **Auto + minuterie** : pause automatique de X secondes entre les pistes (X réglable, ex. 10/20/30 s) ;
  - **Manuel** : chaque piste s'arrête à sa fin, le coach lance la suivante.
- **UX4.9** — Lancer un cours en **2 taps maximum** : Mode coach → choisir le cours (liste des récents en tête).

---

## 5. Comportements transverses

- **UX5.1** — **État temps réel partagé :** tous les clients (PC, mobiles, écran) reflètent le même état en < 500 ms via WebSocket. Aucun indicateur « qui contrôle » : libre-service assumé.
- **UX5.2** — **Confirmations : actions destructives uniquement** (suppression de vidéo, cours audio, fond, playlist, programmation). Toutes les commandes de lecture sont directes ; le « stop » utilise un appui long sur mobile comme garde-fou léger, sans boîte de dialogue.
- **UX5.3** — États vides soignés (bibliothèque vide → invitation à téléverser), erreurs explicites (fichier incompatible → cause + action proposée), toasts discrets pour les succès.
- **UX5.4** — Réactivité : chaque commande donne un retour visuel immédiat (état optimiste), corrigé si le serveur infirme.

## 6. Accessibilité et contraintes terrain

- **UX6.1** — Cibles tactiles ≥ 48 px partout, ≥ 64 px en mode coach et sur la télécommande.
- **UX6.2** — Contrastes conformes WCAG AA sur le thème sombre ; textes essentiels lisibles en salle sombre.
- **UX6.3** — L'écran cinéma est lisible du fond de la salle : tailles minimales imposées pour horloge, compte à rebours et minuteur plein écran.

## 7. Livrables UI/UX

1. Système de design (variables de thème, composants de base) documenté dans le code.
2. Maquettes ou prototypes des écrans clés : attente (canvas), pause, compte à rebours, tableau de bord PC, bibliothèque, planning, télécommande mobile, mode coach.
3. Les deux thèmes v1 (Les Mills sombre + clair) et fichiers de langue FR/EN.

## 8. Critères de recette UI/UX

- ✅ Changement de thème appliqué instantanément sur PC, mobile **et** écran cinéma.
- ✅ Éditeur de canvas : import d'un logo, déplacement des blocs, sauvegarde d'une 2ᵉ composition, application à l'écran.
- ✅ Minuteur plein écran affichant par défaut le temps + nom du prochain cours ; modification du temps en cours de décompte.
- ✅ Compte à rebours 5→1 aux couleurs du programme avant chaque lancement.
- ✅ Overlay de pause thémé affiché lors d'une pause à distance.
- ✅ Bibliothèque : bascule grille/liste, groupement par programme, upload par glisser-déposer.
- ✅ Planning : glisser-déposer d'un cours sur un créneau, création d'une récurrence, override visuel.
- ✅ Mobile : lancement d'un cours audio en 2 taps ; les trois modes d'enchaînement fonctionnent ; boutons ≥ 64 px.
- ✅ Bascule FR/EN sans texte résiduel non traduit.
- ✅ Suppression → confirmation ; pause/lecture/volume → aucune confirmation.
