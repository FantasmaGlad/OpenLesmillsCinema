//! Construit la commande shell exécutée sur la cible (via SSH) pour dérouler
//! `install.sh`.
//!
//! Deux stratégies d'élévation (réf. `docs/cahier-des-charges-installeur.md`
//! §7) :
//! - [`Elevation::Sudo`] : l'utilisateur SSH est déjà sudoer → `sudo install.sh …`.
//! - [`Elevation::SuRoot`] : machine sans `sudo` / non-sudoer → root direct via
//!   `su - -c "install.sh --as-user <login> …"` (option B, ne modifie pas la
//!   politique sudo de la machine).
//!
//! La commande produite ne contient **jamais** de mot de passe : le secret
//! (mot de passe utilisateur pour `sudo`, ou root pour `su`) est fourni
//! séparément par l'IHM via l'entrée du PTY SSH (§13).

/// Options mappées sur les drapeaux d'`install.sh`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallOptions {
    pub no_kiosk: bool,
    pub skip_packages: bool,
    pub skip_build: bool,
    pub dry_run: bool,
    /// Émet la sortie machine `--progress=json` (l'assistant en a besoin pour
    /// la barre de progression). Laissé configurable pour les tests.
    pub progress_json: bool,
}

impl InstallOptions {
    /// Réglage par défaut de l'assistant : non-interactif (`-y`) + sortie JSON.
    pub fn assistant_default() -> Self {
        InstallOptions {
            progress_json: true,
            ..Default::default()
        }
    }

    /// Arguments passés à `install.sh`, hors `--as-user` (injecté par
    /// l'élévation `SuRoot`). Toujours non-interactif (`-y`).
    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec!["-y".to_string()];
        if self.progress_json {
            args.push("--progress=json".to_string());
        }
        if self.no_kiosk {
            args.push("--no-kiosk".to_string());
        }
        if self.skip_packages {
            args.push("--skip-packages".to_string());
        }
        if self.skip_build {
            args.push("--skip-build".to_string());
        }
        if self.dry_run {
            args.push("--dry-run".to_string());
        }
        args
    }
}

/// Stratégie d'élévation de privilèges retenue pour la cible (réf. §7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Elevation {
    /// L'utilisateur SSH est sudoer : `sudo <script> <args>`.
    Sudo,
    /// Root direct via `su -`, en fournissant le compte cible à `install.sh`
    /// (`--as-user <login>`), pour une machine sans `sudo`.
    SuRoot { as_user: String },
}

/// Vrai si le jeton n'a pas besoin d'être protégé pour le shell (jeu de
/// caractères sûr courant : options, chemins, `=`, `:`, `,`).
fn is_shell_safe(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '=' | ':' | ',' | '+' | '@' | '%'))
}

/// Protège une chaîne en guillemets simples POSIX (`'…'`), en gérant le `'`
/// interne via la séquence `'\''`.
pub fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Protège un jeton seulement s'il en a besoin (sinon le laisse lisible).
pub fn shell_quote(token: &str) -> String {
    if is_shell_safe(token) {
        token.to_string()
    } else {
        shell_single_quote(token)
    }
}

/// Construit la commande shell à exécuter sur la cible via SSH.
///
/// `script_path` est le chemin absolu d'`install.sh` sur la cible.
pub fn build_remote_command(script_path: &str, opts: &InstallOptions, elev: &Elevation) -> String {
    match elev {
        Elevation::Sudo => {
            let mut parts = vec!["sudo".to_string(), shell_quote(script_path)];
            parts.extend(opts.to_args().iter().map(|a| shell_quote(a)));
            parts.join(" ")
        }
        Elevation::SuRoot { as_user } => {
            // Commande interne exécutée en root : script + --as-user <login> + args.
            let mut inner = vec![
                shell_quote(script_path),
                "--as-user".to_string(),
                shell_quote(as_user),
            ];
            inner.extend(opts.to_args().iter().map(|a| shell_quote(a)));
            let inner_cmd = inner.join(" ");
            // `su - -c '<inner>'` : login shell root, une seule commande protégée.
            format!("su - -c {}", shell_single_quote(&inner_cmd))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_default_is_noninteractive_json() {
        let a = InstallOptions::assistant_default().to_args();
        assert_eq!(a, vec!["-y", "--progress=json"]);
    }

    #[test]
    fn args_reflect_flags_in_stable_order() {
        let opts = InstallOptions {
            no_kiosk: true,
            skip_packages: true,
            skip_build: false,
            dry_run: true,
            progress_json: true,
        };
        assert_eq!(
            opts.to_args(),
            vec!["-y", "--progress=json", "--no-kiosk", "--skip-packages", "--dry-run"]
        );
    }

    #[test]
    fn sudo_command_is_readable_when_safe() {
        let cmd = build_remote_command(
            "/home/fanta/Bobine/install.sh",
            &InstallOptions::assistant_default(),
            &Elevation::Sudo,
        );
        assert_eq!(cmd, "sudo /home/fanta/Bobine/install.sh -y --progress=json");
    }

    #[test]
    fn su_root_injects_as_user_and_wraps() {
        let cmd = build_remote_command(
            "/home/fanta/Bobine/install.sh",
            &InstallOptions::assistant_default(),
            &Elevation::SuRoot { as_user: "fanta".to_string() },
        );
        assert_eq!(
            cmd,
            "su - -c '/home/fanta/Bobine/install.sh --as-user fanta -y --progress=json'"
        );
    }

    #[test]
    fn paths_with_spaces_are_quoted() {
        let cmd = build_remote_command(
            "/home/fa nta/Bobine/install.sh",
            &InstallOptions::assistant_default(),
            &Elevation::Sudo,
        );
        assert_eq!(
            cmd,
            "sudo '/home/fa nta/Bobine/install.sh' -y --progress=json"
        );
    }

    #[test]
    fn single_quote_in_token_is_escaped() {
        // Chemin contenant une apostrophe : séquence '\'' attendue.
        assert_eq!(shell_single_quote("a'b"), r#"'a'\''b'"#);
    }

    #[test]
    fn su_root_quoting_survives_space_in_login_home() {
        let cmd = build_remote_command(
            "/opt/bobine/install.sh",
            &InstallOptions { no_kiosk: true, progress_json: true, ..Default::default() },
            &Elevation::SuRoot { as_user: "op er".to_string() },
        );
        // Le login avec espace est protégé DANS la commande interne, elle-même
        // protégée par les guillemets externes de `su -c`.
        assert_eq!(
            cmd,
            "su - -c '/opt/bobine/install.sh --as-user '\\''op er'\\'' -y --progress=json --no-kiosk'"
        );
    }
}
