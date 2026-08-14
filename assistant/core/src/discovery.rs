//! Arithmétique de découverte réseau (réf.
//! `docs/cahier-des-charges-installeur.md` §6).
//!
//! Logique **pure** uniquement : déduire le `/24` local à sonder à partir de
//! l'IP du poste admin, et modéliser un candidat. Le scan effectif (port 22,
//! bannière SSH) et le mDNS sont des E/S, réalisées par l'IHM au jalon J2 ;
//! [`os_hint_from_banner`] les aide à qualifier ce qu'ils trouvent.

use std::net::Ipv4Addr;

/// Adresse réseau du `/24` contenant `ip` (dernier octet mis à 0).
pub fn network_v24(ip: Ipv4Addr) -> Ipv4Addr {
    let o = ip.octets();
    Ipv4Addr::new(o[0], o[1], o[2], 0)
}

/// Hôtes candidats d'un `/24` (`.1`..=`.254`), en excluant l'IP du poste admin.
///
/// On saute l'adresse réseau (`.0`) et le broadcast (`.255`), ainsi que l'IP
/// locale (inutile de se sonder soi-même).
pub fn subnet_hosts_v24(local_ip: Ipv4Addr) -> Vec<Ipv4Addr> {
    let o = local_ip.octets();
    (1u8..=254)
        .map(|host| Ipv4Addr::new(o[0], o[1], o[2], host))
        .filter(|ip| *ip != local_ip)
        .collect()
}

/// Un candidat trouvé sur le réseau (§6). Les champs optionnels se remplissent
/// au fil des sondes (résolution de nom, bannière SSH…).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub ip: Ipv4Addr,
    pub hostname: Option<String>,
    pub ssh_banner: Option<String>,
    pub os_hint: Option<String>,
}

impl Candidate {
    /// Candidat minimal : juste une IP joignable sur le port 22.
    pub fn new(ip: Ipv4Addr) -> Self {
        Candidate {
            ip,
            hostname: None,
            ssh_banner: None,
            os_hint: None,
        }
    }

    /// Renseigne la bannière SSH et en déduit l'indice d'OS.
    pub fn with_ssh_banner(mut self, banner: impl Into<String>) -> Self {
        let banner = banner.into();
        self.os_hint = os_hint_from_banner(&banner);
        self.ssh_banner = Some(banner);
        self
    }
}

/// Indice d'OS grossier déduit d'une bannière SSH (repli `None`).
///
/// Ex. `SSH-2.0-OpenSSH_9.2p1 Debian-2` → `Some("Debian")`.
pub fn os_hint_from_banner(banner: &str) -> Option<String> {
    let b = banner.to_ascii_lowercase();
    if b.contains("raspbian") {
        Some("Raspberry Pi OS".to_string())
    } else if b.contains("ubuntu") {
        Some("Ubuntu".to_string())
    } else if b.contains("debian") {
        Some("Debian".to_string())
    } else if b.contains("openssh") {
        Some("Linux/OpenSSH".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_address_zeroes_last_octet() {
        assert_eq!(
            network_v24(Ipv4Addr::new(10, 0, 0, 30)),
            Ipv4Addr::new(10, 0, 0, 0)
        );
        assert_eq!(
            network_v24(Ipv4Addr::new(192, 168, 1, 42)),
            Ipv4Addr::new(192, 168, 1, 0)
        );
    }

    #[test]
    fn subnet_excludes_self_network_and_broadcast() {
        let hosts = subnet_hosts_v24(Ipv4Addr::new(10, 0, 0, 30));
        assert_eq!(hosts.len(), 253); // 254 hôtes moins soi-même
        assert!(!hosts.contains(&Ipv4Addr::new(10, 0, 0, 30))); // pas soi
        assert!(!hosts.contains(&Ipv4Addr::new(10, 0, 0, 0))); // pas le réseau
        assert!(!hosts.contains(&Ipv4Addr::new(10, 0, 0, 255))); // pas le broadcast
        assert!(hosts.contains(&Ipv4Addr::new(10, 0, 0, 1)));
        assert!(hosts.contains(&Ipv4Addr::new(10, 0, 0, 254)));
    }

    #[test]
    fn os_hint_recognises_common_banners() {
        assert_eq!(
            os_hint_from_banner("SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u2"),
            Some("Debian".to_string())
        );
        assert_eq!(
            os_hint_from_banner("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.1"),
            Some("Ubuntu".to_string())
        );
        // OpenSSH générique sans distro identifiable.
        assert_eq!(
            os_hint_from_banner("SSH-2.0-OpenSSH_for_Windows_8.1"),
            Some("Linux/OpenSSH".to_string())
        );
        assert_eq!(os_hint_from_banner("SSH-2.0-dropbear"), None);
    }

    #[test]
    fn candidate_builder_infers_os() {
        let c = Candidate::new(Ipv4Addr::new(10, 0, 0, 30))
            .with_ssh_banner("SSH-2.0-OpenSSH_9.2p1 Debian-2");
        assert_eq!(c.os_hint.as_deref(), Some("Debian"));
        assert_eq!(c.ssh_banner.as_deref(), Some("SSH-2.0-OpenSSH_9.2p1 Debian-2"));
    }
}
