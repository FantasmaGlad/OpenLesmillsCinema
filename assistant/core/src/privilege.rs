//! Amorçage des privilèges : décide comment lancer `install.sh` selon l'état
//! de `sudo` sur la cible (réf. `docs/cahier-des-charges-installeur.md` §7).
//!
//! Rappel du problème : sur un Debian minimal, `sudo` peut être **absent** et
//! l'utilisateur **non-sudoer** (cas « mot de passe root défini »). On retient
//! alors l'**option B** (recommandée) : lancer en root via `su -` en passant
//! `--as-user <login>` à `install.sh`, sans toucher à la politique sudo.

use crate::orchestrate::Elevation;

/// Résultat des sondes exécutées sur la cible après connexion SSH.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SudoProbe {
    /// `command -v sudo` a réussi.
    pub sudo_installed: bool,
    /// L'utilisateur est sudoer (`sudo -n true`, ou `sudo -v` avec mot de passe).
    pub user_is_sudoer: bool,
}

/// Décision d'amorçage des privilèges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivilegeDecision {
    /// Déjà sudoer et `sudo` présent → on continue en `sudo`, sans rien changer.
    UseSudo,
    /// Pas sudoer ou `sudo` absent → option B : `su -` + `--as-user`, aucune
    /// modification de la politique système.
    BootstrapSuAsUser,
}

/// Tranche l'amorçage à partir des sondes.
pub fn decide(probe: &SudoProbe) -> PrivilegeDecision {
    if probe.sudo_installed && probe.user_is_sudoer {
        PrivilegeDecision::UseSudo
    } else {
        PrivilegeDecision::BootstrapSuAsUser
    }
}

/// Traduit la décision en stratégie d'élévation concrète.
///
/// `login` est le compte SSH (propriétaire des fichiers / service kiosk) ;
/// requis uniquement par l'option B, où il devient `--as-user <login>`.
pub fn elevation_for(decision: PrivilegeDecision, login: &str) -> Elevation {
    match decision {
        PrivilegeDecision::UseSudo => Elevation::Sudo,
        PrivilegeDecision::BootstrapSuAsUser => Elevation::SuRoot {
            as_user: login.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sudoer_with_sudo_uses_sudo() {
        let d = decide(&SudoProbe { sudo_installed: true, user_is_sudoer: true });
        assert_eq!(d, PrivilegeDecision::UseSudo);
        assert_eq!(elevation_for(d, "fanta"), Elevation::Sudo);
    }

    #[test]
    fn missing_sudo_bootstraps_su() {
        let d = decide(&SudoProbe { sudo_installed: false, user_is_sudoer: false });
        assert_eq!(d, PrivilegeDecision::BootstrapSuAsUser);
        assert_eq!(
            elevation_for(d, "fanta"),
            Elevation::SuRoot { as_user: "fanta".to_string() }
        );
    }

    #[test]
    fn sudo_present_but_not_sudoer_bootstraps_su() {
        // Cas « mot de passe root défini » : sudo installé mais user absent des sudoers.
        let d = decide(&SudoProbe { sudo_installed: true, user_is_sudoer: false });
        assert_eq!(d, PrivilegeDecision::BootstrapSuAsUser);
    }
}
