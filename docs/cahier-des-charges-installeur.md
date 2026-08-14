# Cahier des charges — Assistant d'installation graphique (Bobine)

Statut : proposition / à valider. Complète le déploiement en ligne de commande
existant (`install.sh`), qu'il ne remplace pas mais pilote.

## 1. Objectif

Rendre l'installation « clic-clic » pour un exploitant non technicien. Une
application graphique tourne sur le **portable de l'admin** (Windows / macOS /
Linux, avec sa session graphique), **localise le mini PC** sur le réseau local,
s'y **connecte en SSH**, **détecte le matériel et l'état du système**, puis
**déroule `install.sh`** en affichant une barre de progression et un journal
lisible. La cible reste un **Debian 13 minimal sans bureau** (modèle « borne »).

Non-objectif : installer un serveur graphique sur la cible pour y lancer un
installeur local (la cible est headless par conception). L'IHM vit sur le
portable admin, pas sur le mini PC.

## 2. Acteurs et prérequis

- **Poste admin** : un ordinateur de l'exploitant, sur le **même réseau local**
  (Wi-Fi ou filaire) que le mini PC. Il exécute l'assistant.
- **Mini PC cible** : Debian 13 fraîchement installé, **SSH actif**, joignable
  sur le LAN. Peut être dans plusieurs états de « nudité » (voir §7 et §9).
- Prérequis réseau : les deux machines se voient sur le LAN. Internet est requis
  sur la cible **une seule fois** (paquets apt, NodeSource) — l'assistant le
  vérifie et le signale sinon.

## 3. Architecture technique de l'assistant

- **Cadriciel recommandé : Tauri** (cœur Rust + IHM web, binaire léger,
  signable par OS, client SSH natif via `russh`/`libssh2`). Alternative
  pragmatique : **Electron** (dev plus rapide, client SSH `ssh2` Node, mais
  binaire lourd). Éviter Python packagé (distribution multi-OS plus pénible).
- **Transport unique : SSH** (mot de passe ou clé). Aucune dépendance installée
  sur la cible pour communiquer : tout passe par des commandes shell non
  interactives et l'analyse de leur sortie.
- **Aucun secret persisté** : mots de passe gardés en mémoire le temps de la
  session, jamais écrits sur disque.
- L'assistant ne réimplémente pas la logique d'installation : il **orchestre**
  `install.sh` (source de vérité unique), pour éviter toute divergence.

## 4. Parcours utilisateur (écrans)

1. **Accueil** — présentation, bouton « Installer Bobine sur un mini PC ».
2. **Découverte réseau** (§6) — liste des candidats trouvés (nom / IP / indice
   d'OS), + saisie manuelle d'une IP. Choix de la cible.
3. **Connexion SSH** — identifiant + mot de passe (ou clé). Test de
   joignabilité, vérification que c'est bien un Debian 13 amd64.
4. **Élévation de privilèges** (§7) — détection sudo/su ; si nécessaire, demande
   du mot de passe root et amorçage, avec explication à l'écran.
5. **Analyse système** (§8, §9) — sonde matérielle + logicielle. Écran récap :
   « Détecté : AMD Ryzen 5, iGPU Radeon, 8 Go RAM, disque 120 Go, Wi-Fi présent,
   Debian 13, dépôts non-free-firmware manquants (seront ajoutés) ». L'assistant
   en déduit le **jeu de paquets adapté**.
6. **Options** — dossier d'installation, mode kiosk oui/non, sortie d'écran,
   etc. (mappées sur les options de `install.sh`).
7. **Installation** — exécution pilotée (§10) : **barre de progression par
   étape** + journal live + gestion des erreurs.
8. **Terminé** — URL d'accès (`http://bobine.local`), bouton « Ouvrir », QR code
   pour la télécommande mobile, rappel des identifiants et de la désinstallation.

## 5. Périmètre fonctionnel (in / out)

- In : installation neuve, ré-installation/mise à jour (idempotente),
  détection matérielle, remédiation des dépôts, amorçage des privilèges, suivi
  de progression, diagnostic post-install (`/api/health`).
- Out (v1) : gestion de flotte multi-appareils, mises à jour OTA planifiées,
  GPU NVIDIA propriétaire (fallback décodage logiciel + avertissement).

## 6. Découverte réseau (localiser le mini PC)

Trois méthodes combinées, du plus fiable au plus large :

1. **mDNS / Zeroconf** : si Bobine est déjà installé, il s'annonce en
   `bobine.local`. Sinon, on écoute `_workstation._tcp` / `_ssh._tcp` pour lister
   les machines annonçant SSH.
2. **Scan du sous-réseau** : déduire le `/24` local depuis l'IP du poste admin,
   sonder le **port 22 ouvert**, puis empreinte légère (bannière SSH, tentative
   d'identification d'OS).
3. **Saisie manuelle** de l'IP (repli toujours disponible).

Sortie : liste de candidats { IP, nom d'hôte, bannière SSH, OS probable }.
Vérification de non-ambiguïté avant connexion (afficher hostname + IP).

## 7. Amorçage des privilèges — le cas sudo / `su -` (IMPORTANT)

**Le problème.** Sur un Debian installé de façon minimale, deux configurations
existent selon un choix fait pendant l'installation de Debian :

- **Mot de passe root DÉFINI** → l'installeur Debian **n'ajoute PAS** le premier
  utilisateur au groupe `sudo`, et `sudo` **peut même ne pas être installé** du
  tout. On administre alors via `su -` (mot de passe root). C'est le cas le plus
  fréquent d'une install minimale « à l'ancienne ».
- **Mot de passe root LAISSÉ VIDE** → l'installeur **installe `sudo`** et
  **ajoute l'utilisateur au groupe `sudo`** (root verrouillé) — comportement
  « façon Ubuntu ».

Conséquence directe : `sudo ./install.sh` peut échouer de deux manières —
soit `sudo: command not found`, soit `<user> n'est pas dans le fichier sudoers`.
Or `install.sh` **exige** d'être lancé **via `sudo` depuis un compte normal**
(il refuse aussi bien l'absence de droits que l'exécution directe en root sans
`SUDO_USER`).

**Détection par l'assistant.** Après connexion SSH en tant qu'utilisateur :
1. `command -v sudo` — `sudo` est-il installé ?
2. `sudo -n true` puis, au besoin, `sudo -v` avec le mot de passe utilisateur —
   l'utilisateur est-il sudoer (avec ou sans mot de passe) ?
Trois cas :
- **Déjà sudoer** → on continue directement en `sudo`.
- **Pas sudoer / `sudo` absent** → **amorçage** requis (ci-dessous).
- **SSH root direct** : souvent impossible (sshd Debian par défaut
  `PermitRootLogin prohibit-password`), d'où le choix de se connecter en
  **utilisateur** puis de basculer avec `su -`.

**Deux stratégies d'amorçage** (à trancher, cf. §11) :

- **Option A — Amorcer `sudo`** (modifie le système) : l'assistant demande le
  **mot de passe root**, puis via `su -` exécute
  `apt-get update && apt-get install -y sudo && usermod -aG sudo <user>` (ou pose
  un fichier `/etc/sudoers.d/`). Le changement de groupe ne prend effet qu'à la
  **prochaine session** → l'assistant **rouvre une connexion SSH**, l'utilisateur
  est alors sudoer, et `sudo ./install.sh` fonctionne.
- **Option B — Ne rien changer aux droits** (recommandée) : ajouter à
  `install.sh` un drapeau `--as-user <login>`. L'assistant lance alors
  **tout en root via `su -`** :
  `su - -c "cd <repo> && ./install.sh --as-user <login> -y"`. `install.sh`
  accepte d'être root **à condition** que `--as-user` fournisse le compte cible
  (pour l'ownership des fichiers, le service kiosk, etc.). Avantage : ne touche
  pas à la politique sudo de la machine (utile en environnement contraint) et
  marche même sans `sudo` installé.

**Explication à afficher à l'utilisateur** (texte type de l'écran §4.4) :
> « Ce mini PC utilise un compte administrateur séparé (root). Pour installer
> Bobine, entrez le mot de passe **root** défini lors de l'installation de
> Debian. Bobine s'installera avec ce droit, sans modifier vos autres réglages
> (option B), ou en vous ajoutant aux administrateurs `sudo` si vous préférez
> (option A). »

## 8. Détection matérielle et paquets adaptés

Le `install.sh` actuel installe **en dur** le pilote vidéo **Intel** (VA-API
`intel-media-va-driver`). C'est le principal point à rendre **adaptatif**, car
le matériel varie (Ryzen/AMD notamment).

Sondes (via SSH) et décisions :

| Sonde | Commande | Décision |
|---|---|---|
| Vendeur CPU | `lscpu` / `/proc/cpuinfo` (`AuthenticAMD` vs `GenuineIntel`) | **Microcode** : `amd64-microcode` (AMD/Ryzen) ou `intel-microcode` (Intel) |
| Vendeur GPU | `lspci -nn` (VGA/3D/Display : `8086`=Intel, `1002`/`1022`=AMD, `10de`=NVIDIA) | **VA-API** : Intel → `intel-media-va-driver-non-free` (repli `i965-va-driver`) ; **AMD/Ryzen** → `mesa-va-drivers` (+ `firmware-amd-graphics`) ; NVIDIA → hors v1 (avertir, décodage logiciel) |
| Firmware | `dmesg` (`firmware ... failed`), `lspci -k` (modules sans firmware) | Ajouter `firmware-linux`, `firmware-misc-nonfree`, `firmware-amd-graphics`, `firmware-iwlwifi`… selon besoin |
| Wi-Fi | `ip -o link` (interfaces `wl*`), `rfkill` | Confirmer la présence (nécessaire à l'écran réseau + radio, cf. README) ; installer le firmware Wi-Fi manquant |
| RAM / disque | `free -m`, `df -h`, `lsblk` | Avertir sous seuil (ex. < 4 Go RAM, < 8 Go libres) |
| Architecture | `dpkg --print-architecture` | Exiger `amd64` ; refuser/avertir sinon (le projet cible x86, pas ARM/Pi) |

Principe : construire un **profil matériel**, en déduire la liste de paquets, et
**afficher le récap** avant d'agir. La détection doit idéalement vivre **dans
`install.sh`** (bénéficie aussi à la CLI) ; l'assistant ne fait que la refléter.

## 9. Détection des dépôts / sources APT et remédiation

Une install minimale peut manquer de composants ou de sources :

- **Composants APT** : Debian 12+ sépare `non-free-firmware` de `non-free`.
  Beaucoup de pilotes/firmwares (Wi-Fi, GPU AMD, `*-non-free`) l'exigent.
  Sonder `/etc/apt/sources.list` et `/etc/apt/sources.list.d/*.sources`
  (format deb822) ; **activer** `contrib non-free non-free-firmware` si absents.
- **Joignabilité** : `apt-get update` fonctionne-t-il ? `deb.debian.org` et
  `deb.nodesource.com` sont-ils joignables ? Sinon, message clair (pas
  d'internet → installation impossible en l'état, proposer le pré-staging).
- **Outils de base** manquants : `curl`, `ca-certificates`, `gnupg` (requis pour
  NodeSource), `sudo` (cf. §7). `install.sh` les installe déjà ; l'assistant
  confirme la couverture.
- **« Tout installer »** : si le système est « nu » (composants/sources/outils
  manquants), l'assistant applique la remédiation ci-dessus **avant** de lancer
  `install.sh`, pour qu'il dispose de tout ce dont il a besoin.

## 10. Exécution d'`install.sh` et suivi de progression

- L'assistant exécute `install.sh` **en non interactif** (`-y`), en streamant sa
  sortie via SSH.
- **Protocole de progression** : `install.sh` émet déjà des étapes lisibles
  (`step`/`step_done`). Pour un suivi FIABLE (barre + pourcentage), ajouter un
  mode **sortie structurée** (ex. `--progress=json` imprimant une ligne par
  évènement : `{"step":"packages","status":"start|ok|error","pct":42}`).
  L'assistant parse ces lignes → barre + libellé courant + journal détaillé
  repliable.
- **Fin** : l'assistant attend `GET /api/health == 200` (déjà fait par
  `install.sh`) et affiche le récap + l'URL.

## 11. Modifications requises côté `install.sh` (pour l'assistant)

À trancher, mais recommandées (et bénéfiques aussi à la CLI) :

1. **Détection matérielle intégrée** (§8) : choisir le driver VA-API + microcode
   selon le GPU/CPU réels, au lieu de l'Intel en dur.
2. **Remédiation des composants APT** (§9) : activer `non-free-firmware` etc. si
   requis par le matériel.
3. **`--as-user <login>`** (§7, option B) : autoriser l'exécution en root en
   fournissant explicitement le compte cible, pour l'amorçage sans `sudo`.
4. **`--progress=json`** (§10) : sortie machine pour la barre de progression.
5. (Optionnel) `--assume-network-checked` / pré-staging pour les cas hors-ligne.

Ces points peuvent être livrés **indépendamment de l'assistant** : ils
améliorent déjà la CLI et sont la fondation technique de l'IHM.

## 12. Gestion des erreurs et reprise

- Chaque étape échouée s'affiche avec le **log brut** et une **cause probable**
  (ex. « pas d'internet », « firmware Wi-Fi manquant », « mot de passe root
  invalide »). Bouton « Réessayer cette étape » quand c'est possible.
- `install.sh` étant **idempotent**, relancer l'assistant après correction est
  sûr (ne casse rien, ne touche pas aux données).
- Journaliser côté cible (`/var/log/bobine/install-*.log`, déjà fait) et
  proposer l'export du log depuis l'assistant pour le support.

## 13. Sécurité

- SSH uniquement ; proposer l'auth par **clé** (générer/déposer une clé) en plus
  du mot de passe. Ne jamais persister les mots de passe.
- Vérifier/mémoriser l'empreinte d'hôte SSH (TOFU) et alerter en cas de
  changement.
- Rappeler que le bouton « Désinstaller » et le reset sont **destructifs** (déjà
  cadré côté app).

## 14. Livrables et jalons

- **J1 — Fondations CLI** : `install.sh` gagne la détection matérielle (§8), la
  remédiation APT (§9), `--as-user` (§7) et `--progress=json` (§10). Testable
  sans IHM.
- **J2 — Assistant minimal** : découverte réseau + SSH + amorçage privilèges +
  exécution avec barre de progression (chemin heureux).
- **J3 — Robustesse** : détection/récap matériel à l'écran, remédiation guidée,
  gestion d'erreurs + reprise, auth par clé, empreinte d'hôte.
- **J4 — Finition** : écran de fin (URL/QR), export de log, signatures/packaging
  par OS.

## 15. Questions ouvertes (à trancher)

- Amorçage privilèges : **Option A** (ajouter au groupe sudo) ou **Option B**
  (`--as-user`, ne rien changer) — la B est recommandée.
- GPU NVIDIA : hors v1 (décodage logiciel + avertissement) confirmé ?
- Cadriciel : **Tauri** (recommandé) vs Electron.
- Pré-staging hors-ligne des paquets : nécessaire en v1 ou v2 ?
