# Bobine

**Affichage dynamique auto-hébergé et lecteur vidéo planifié, hors ligne, pour salles de fitness et cours collectifs.**

Bobine transforme un mini PC dédié bon marché en système vidéo complet pour votre salle : il planifie et diffuse des vidéos de cours collectifs pré-enregistrées sur vos écrans, permet aux adhérents de parcourir et lancer un cours à la demande depuis une borne, pilote un écran câblé et un écran réseau indépendamment, propose un mode coach audio avec fonds animés, et diffuse une musique d'ambiance 24/7. Tout tourne en local, sur votre matériel. Sans cloud, sans abonnement, sans connexion internet après l'installation.

[English](README.md) · [Documentation technique](docs/ARCHITECTURE.md)

[![CI](https://github.com/FantasmaGlad/Bobine/actions/workflows/ci.yml/badge.svg)](https://github.com/FantasmaGlad/Bobine/actions/workflows/ci.yml)
![Licence : AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)
![Backend : FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688)
![Frontend : Next.js](https://img.shields.io/badge/Frontend-Next.js-000000)
![Plateforme : Debian 13](https://img.shields.io/badge/Platform-Debian%2013-A81D33)
![Auto-hébergé](https://img.shields.io/badge/Auto--h%C3%A9berg%C3%A9-Local--first-4c1)

**Mots-clés :** affichage dynamique auto-hébergé, signalétique numérique, cours collectifs, salle de sport, planification vidéo, lecteur vidéo fitness à la demande, borne de cours, studio, cycling indoor, thin client, mini PC, hors ligne, local-first, FastAPI, Next.js, Debian.

---

## Pourquoi Bobine

Les salles de cours collectifs diffusent de plus en plus des cours vidéo pré-enregistrés, animés par un coach à l'écran (« cours virtuels »). Les solutions du marché sont verrouillées dans le cloud, payantes à l'abonnement, et s'arrêtent dès que la connexion tombe. Bobine fait l'inverse :

- **Vous êtes propriétaire.** Vos vidéos, votre matériel, votre planning. Pas d'abonnement, pas de dépendance à un éditeur, pas de compte.
- **Ça marche hors ligne.** Une fois installé, la salle n'a besoin d'aucune connexion internet pour diffuser les cours.
- **Ça tourne sur du matériel bon marché.** Un thin client ou un mini PC d'occasion (type Dell Wyse 5070) suffit.
- **C'est autonome.** Démarrage automatique à la mise sous tension, reprise après coupure de courant, redémarrage automatique d'un composant en panne.

Utilisateurs types : studios, salles de sport, espaces fitness d'hôtels et d'entreprises, kinés et centres de rééducation, studios de danse et de cycling — quiconque diffuse des vidéos de cours planifiées ou à la demande sur un écran.

Bobine est agnostique aux programmes : les catégories de cours sont libres, il s'adapte donc à n'importe quel catalogue de cours collectifs, cycling, renforcement, mobilité ou bien-être.

---

## Fonctionnalités

- **Planification vidéo** — construisez un planning hebdomadaire ; les cours démarrent automatiquement au bon moment sur le bon écran.
- **Borne cinéma à la demande** — un écran plein écran côté adhérent pour choisir et lancer un cours soi-même, avec animation de lancement et compte à rebours « prochain cours ».
- **Deux sorties d'écran indépendantes** — pilotez un écran câblé (HDMI) et un écran réseau séparément, chacun avec son contenu.
- **Télécommande mobile** — contrôlez la lecture (play, pause, avance, suivant) depuis n'importe quel téléphone du réseau local.
- **Support des télécommandes physiques** — la borne cinéma adhérent et l'écran radio répondent à une télécommande USB à dongle (présentateur / « air remote » média) : flèches et OK pour parcourir et lancer un cours, plus les touches play/pause, piste et volume. Aucun pilote, aucun appairage — la télécommande est vue comme un clavier.
- **Mode coach audio** — diffusez des cours audio sur les enceintes de la salle avec un fond visuel animé ou fixe à l'écran.
- **Radio intégrée** — un lecteur de musique d'ambiance 24/7 façon Spotify, avec fondu enchaîné, aléatoire, répétition et rappels vocaux programmés (« replacez vos poids », etc.).
- **Gestion de bibliothèque simple** — import par glisser-déposer, envoi en lot, catégories libres, sélection groupée, progression fichier par fichier, miniatures automatiques.
- **Local-first et résilient** — backend multi-worker, état partagé, reprise automatique après un redémarrage ou une coupure, et un chien de garde qui redémarre un composant mort.
- **Admin web, zéro installation client** — tout s'administre depuis un navigateur ; les écrans adhérents et les télécommandes ne sont que des pages web.

---

## Comment ça marche

Bobine est un unique mini PC sur votre réseau local qui fait tourner :

- un backend **FastAPI** (multi-worker) avec **Redis** comme bus d'état partagé et **SQLite** pour le stockage ;
- un kiosque **Chromium** en plein écran (X11) pour l'écran câblé ;
- une interface **Next.js** (admin, borne adhérent, télécommande mobile), servie en pages statiques depuis la même machine.

Les autres écrans (écran réseau, télécommandes, PC d'admin) sont de simples navigateurs pointant vers le mini PC. Les médias ne quittent jamais votre réseau.

Pour l'architecture complète, le modèle de données, le contrat réseau et la référence API, voir **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Matériel requis

- Un **mini PC ou thin client x86-64** (cible de référence : Dell Wyse 5070, Intel Gemini Lake). Tout petit PC compatible Debian avec un iGPU Intel convient ; le décodage vidéo matériel est utilisé si disponible.
- **4 Go de RAM** minimum, quelques Go de disque pour l'application plus l'espace de votre bibliothèque vidéo.
- **Un ou deux écrans** (HDMI pour la sortie câblée ; l'écran réseau est n'importe quel appareil avec un navigateur).
- Un **réseau local Wi-Fi** (un routeur ou point d'accès) pour joindre les autres appareils — le second écran réseau, la télécommande mobile et le lecteur radio se connectent tous sur le réseau local. Il ne demande **aucune connexion internet** et continue de fonctionner même si votre accès internet tombe : le réseau local seul suffit. Bobine peut aussi tourner **totalement hors ligne, sans aucun réseau**, mais seul l'unique écran câblé (HDMI) est alors utilisé.

Internet n'est nécessaire qu'une seule fois, pour installer le système d'exploitation et le logiciel.

---

## Démarrage rapide

### 1. Installer Debian 13 depuis une clé USB (voie rapide)

Bobine vise **Debian 13 « Trixie »**, installation minimale, sans environnement de bureau (Bobine apporte sa propre pile d'affichage kiosque).

1. **Téléchargez** l'image Debian 13 *netinst* (~700 Mo) sur le site officiel : <https://www.debian.org/download>.
2. **Écrivez-la sur une clé USB** (8 Go et plus). La clé est effacée.
   - Linux : `sudo dd if=debian-13-*-amd64-netinst.iso of=/dev/sdX bs=4M status=progress oflag=sync` (remplacez `/dev/sdX` par votre clé, vue avec `lsblk` — vérifiez deux fois, cette commande écrase la cible).
   - Windows/macOS : utilisez [balenaEtcher](https://etcher.balena.io/) ou Rufus, sélectionnez l'ISO et la clé, lancez.
3. **Démarrez le mini PC sur la clé USB** : allumez et pressez la touche du menu de démarrage (souvent `F12`, `F7`, `F10` ou `Échap` sur Dell/thin client), choisissez la clé.
4. **Déroulez l'installateur Debian** (graphique ou texte) :
   - Définissez le nom de machine, un compte utilisateur normal et son mot de passe (retenez-les — c'est ce compte qui sert à la connexion SSH).
   - À l'étape *Sélection des logiciels*, **décochez tous les environnements de bureau** ; ne gardez que **serveur SSH** et **utilitaires usuels du système**.
   - Terminez et redémarrez en retirant la clé USB.

Vous avez maintenant une machine Debian 13 minimale, joignable sur votre réseau.

### 2. Installer Bobine

Sur le mini PC (en direct ou par SSH), avec votre compte normal (pas root) :

```bash
git clone https://github.com/FantasmaGlad/Bobine.git
cd Bobine
sudo ./install.sh
```

`install.sh` est idempotent et autonome. Il installe les paquets système, Redis, Node.js et l'environnement Python, construit l'interface web, écrit la configuration, enregistre les services systemd (backend, kiosque, garde audio, chien de garde de santé), publie le nom `bobine.local` sur le réseau et démarre le tout. Relancez-le après une mise à jour pour reconstruire et redémarrer proprement.

Pas d'internet à la salle ? Vous pouvez copier le dépôt depuis une autre machine par SSH (rsync) au lieu de le cloner — voir la section *Exploitation & déploiement* de [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### 3. Ouvrir l'interface

Depuis n'importe quel appareil du même réseau, ouvrez :

```
http://bobine.local
```

Bobine se publie en **mDNS (Zeroconf/Bonjour)** sous le nom `bobine.local` : pas besoin de connaître son adresse IP. Si votre réseau bloque le mDNS, utilisez l'IP de la machine directement (`http://<adresse-ip>`) ; l'IP est affichée à la fin de `install.sh`, ou trouvez-la avec `hostname -I` sur le mini PC.

Importez quelques vidéos de cours depuis l'admin, créez un planning ou une playlist, et l'écran câblé se met à diffuser.

---

## Utiliser Bobine

- **Interface d'admin** (`http://bobine.local`) — importez et organisez vidéos, fonds animés, cours audio et pistes radio ; créez playlists et plannings ; gérez réglages, thèmes et langue.
- **Cinéma adhérent** — l'écran câblé affiche un menu de sélection ; l'adhérent lance son cours. Les nouveaux imports y apparaissent automatiquement.
- **Écran réseau** — une seconde sortie indépendante ; choisissez ce qu'affiche chaque écran dans *Paramètres → Sortie vidéo*.
- **Télécommande mobile** — ouvrez `http://bobine.local` sur un téléphone ; l'affichage s'adapte en télécommande pour le staff.
- **Radio** — ouvrez l'écran radio sur un appareil dédié pour diffuser la musique d'ambiance en continu ; pilotage depuis l'onglet *Radio* de l'admin.
- **Synchronisation des écrans** — *Paramètres → Synchronisation des écrans* vide le cache de chaque écran connecté, le recharge avec les derniers assets et redémarre les services.

---

## Santé et supervision

Bobine expose un point de contrôle de santé lisible par machine :

```
GET http://bobine.local/api/health
```

Il rapporte l'état de **Redis**, de la base **SQLite** et du **kiosque Chromium**, et renvoie `200` si tout va bien ou `503` si un composant critique est mort. Un **chien de garde** local le sonde et redémarre automatiquement un composant en panne (backend, Redis ou kiosque) : la salle se rétablit sans intervention. Tous les services redémarrent aussi automatiquement après une coupure de courant.

---

## Désinstallation

Depuis l'admin : *Paramètres → Zone de danger → Désinstaller* (une phrase de confirmation est demandée). Ou en ligne de commande sur le mini PC :

```bash
sudo ./install.sh --uninstall --purge
```

Ajoutez `--purge-data` pour retirer aussi les médias importés (irréversible). Les paquets système partagés sont conservés. Voir `sudo ./install.sh --help` pour toutes les options.

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — référence technique : architecture, modèle de données, contrat réseau, référence API et WebSocket, services systemd, exploitation à distance.
- **[docs/cahier-des-charges-radio.md](docs/cahier-des-charges-radio.md)** — spécification complète du sous-système radio.
- **[docs/cahier-des-charges-installeur.md](docs/cahier-des-charges-installeur.md)** — spécification de l'assistant d'installation graphique et fondations CLI déjà en place. Cœur de l'assistant (Rust) : [`assistant/`](assistant/).

---

## Licence

Bobine est un logiciel libre sous licence **GNU Affero General Public License v3.0 (AGPL-3.0)** — voir [`LICENSE`](LICENSE). Si vous exploitez une version modifiée pour fournir un service en réseau, vous devez mettre à disposition le code source correspondant sous la même licence.

---

## État et feuille de route

Bobine est utilisé en production sur du matériel dédié. Prévu : un assistant d'installation graphique (fondations CLI déjà en place), un site web dédié et une documentation étendue. Les tickets et contributions sont bienvenus sur le [dépôt GitHub](https://github.com/FantasmaGlad/Bobine).
