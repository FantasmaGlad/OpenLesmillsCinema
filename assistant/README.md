# Assistant d'installation Bobine

Application graphique (poste admin) qui **localise le mini PC**, s'y **connecte
en SSH**, **détecte le matériel**, puis **déroule `install.sh`** avec une barre
de progression. Cf. le cahier des charges : [`../docs/cahier-des-charges-installeur.md`](../docs/cahier-des-charges-installeur.md).

## État

- **`core/` — bibliothèque `bobine-installer-core`** : livrée. Logique **pure**
  et testable (aucune E/S), fondation de l'IHM. Couverte par `cargo test`.
- **IHM Tauri + SSH/mDNS réels** : jalon **J2**, à venir. Se branchera sur
  `core` sans réécrire la logique.

> `core` ne réimplémente pas l'installation : `install.sh` reste la **source de
> vérité unique**. L'assistant l'**orchestre** (construit la commande, parse sa
> sortie).

## Modules de `core`

| Module | Rôle | Réf. cahier |
|---|---|---|
| `progress` | Parse `install.sh --progress=json` (évènements typés) + `ProgressState` prêt à afficher (barre, libellé, phase, erreur). | §10 |
| `orchestrate` | Construit la commande distante `install.sh` (`sudo` ou `su - --as-user`), sans jamais embarquer de mot de passe. | §7, §10 |
| `privilege` | Arbre de décision de l'amorçage des privilèges (sudo présent ? sudoer ?) → `sudo` vs option B `su -`. | §7 |
| `discovery` | Arithmétique du `/24` à sonder + modèle de candidat + indice d'OS depuis la bannière SSH. | §6 |

## Tester

```bash
cd assistant
cargo test --workspace
```

Le test d'intégration [`core/tests/replay_fixture.rs`](core/tests/replay_fixture.rs)
rejoue un flux `--progress=json` **réel** capturé depuis `install.sh`
([`fixtures/install-events.jsonl`](core/tests/fixtures/install-events.jsonl)) :
garde-fou contre toute divergence entre l'émetteur et le parseur. Si tu modifies
le protocole côté `install.sh`, régénère la fixture et fais évoluer les tests.

## Prochaines étapes (J2)

1. Membre `src-tauri/` (binaire Tauri) dépendant de `core`.
2. Découverte réseau réelle : mDNS (`bobine.local`, `_ssh._tcp`) + scan du `/24`
   (`discovery` fournit déjà les hôtes à sonder).
3. Transport SSH (`russh`) : sondes privilèges (`privilege`), lancement de la
   commande (`orchestrate`), lecture ligne-à-ligne du flux → `ProgressState`.
   Allouer un **PTY** pour un flush ligne-à-ligne côté cible.
4. Écrans du parcours (§4) : découverte → connexion → analyse → options →
   installation (barre + journal) → terminé (URL/QR).
