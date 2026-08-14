//! Parse le flux machine de `install.sh --progress=json`.
//!
//! Contrat (réf. `docs/cahier-des-charges-installeur.md` §10) : `install.sh`
//! émet une **ligne JSON compacte par évènement**, versionnée par la clé de
//! tête `"bobine":1`. Les autres lignes du flux sont du journal humain, à
//! afficher tel quel. On distingue donc trois natures de ligne
//! ([`LineKind`]) : évènement reconnu, ligne marquée mais illisible, ou simple
//! journal.
//!
//! Les évènements ([`Event`]) : `run_begin`, `step` (deux par étape :
//! `start` puis `ok`/`skip`/`error`), `run_end`. On les rejoue dans un
//! [`ProgressState`] qui expose directement ce dont l'IHM a besoin : un
//! pourcentage monotone, l'étape courante, la phase, et l'éventuelle erreur.

use serde::{Deserialize, Serialize};

/// Mode d'installation annoncé par `run_begin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Installation complète avec kiosk Chromium (borne écran câblé).
    Kiosk,
    /// Backend seul (`--no-kiosk`), poste de dev ou serveur distinct.
    Server,
}

/// Statut d'un évènement `step`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// L'étape démarre.
    Start,
    /// L'étape s'est terminée avec succès.
    Ok,
    /// L'étape a été ignorée (drapeau `--skip-*`, `--no-kiosk`…).
    Skip,
    /// L'étape a échoué (émis par le trap `on_error`).
    Error,
}

/// Statut d'un évènement `run_end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Installation terminée avec succès.
    Ok,
    /// Installation interrompue par une erreur.
    Error,
}

/// Métadonnées d'ouverture d'une exécution (`run_begin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunBegin {
    #[serde(default)]
    pub version: String,
    pub total: u32,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub log: String,
    pub mode: Mode,
    #[serde(default)]
    pub dry_run: bool,
}

/// Évènement d'étape (`step`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepEvent {
    pub status: StepStatus,
    /// Numéro d'étape (1-indexé).
    pub step: u32,
    pub total: u32,
    /// Avancement 0..=100. Monotone : le `start` d'une étape vaut le `pct` de
    /// clôture de la précédente.
    pub pct: u8,
    /// Identifiant **stable** de l'étape (`packages`, `kiosk`, …) : mapper les
    /// icônes / i18n dessus, jamais sur `title` (prose FR mouvante).
    pub slug: String,
    /// Libellé humain courant.
    pub title: String,
    /// Détail optionnel : raison d'un `skip`, code d'un `error`.
    #[serde(default)]
    pub detail: Option<String>,
}

/// Évènement de clôture d'exécution (`run_end`). Les champs varient selon le
/// statut (succès vs erreur), d'où leur caractère optionnel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunEnd {
    pub status: RunStatus,
    #[serde(default)]
    pub pct: Option<u8>,
    pub total: u32,
    /// Résultat du contrôle `/api/health` (succès uniquement).
    #[serde(default)]
    pub healthy: Option<bool>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// Code de retour (erreur uniquement).
    #[serde(default)]
    pub rc: Option<i32>,
    /// Étape en cours au moment de l'échec (erreur uniquement).
    #[serde(default)]
    pub step: Option<u32>,
    #[serde(default)]
    pub dry_run: Option<bool>,
}

/// Un évènement de progression, discriminé par la clé `event`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    RunBegin(RunBegin),
    Step(StepEvent),
    RunEnd(RunEnd),
}

/// Nature d'une ligne du flux mêlé (évènements JSON + journal humain).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineKind {
    /// Évènement machine reconnu et parsé.
    Event(Event),
    /// Ligne marquée `"bobine":` mais illisible (schéma cassé) — à signaler.
    Malformed(String),
    /// Ligne de journal humain ordinaire — à afficher telle quelle.
    Log,
}

/// Vrai si la ligne porte le marqueur d'évènement de tête `{"bobine":`.
///
/// Le marqueur en tête permet un filtrage fiable sans parser tout le flux.
pub fn is_event_marker(line: &str) -> bool {
    line.trim_start().starts_with("{\"bobine\":")
}

/// Classe une ligne du flux : évènement, ligne marquée illisible, ou journal.
pub fn classify_line(line: &str) -> LineKind {
    let trimmed = line.trim();
    if is_event_marker(trimmed) {
        match serde_json::from_str::<Event>(trimmed) {
            Ok(ev) => LineKind::Event(ev),
            Err(e) => LineKind::Malformed(e.to_string()),
        }
    } else {
        LineKind::Log
    }
}

/// Phase globale de l'installation, dérivée du flux d'évènements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Aucun `run_begin`/`step` reçu encore.
    NotStarted,
    /// Installation en cours.
    Running,
    /// `run_end` reçu avec succès.
    Succeeded,
    /// `step:error` ou `run_end:error` reçu.
    Failed,
}

/// Référence légère à une étape (pour l'affichage courant / l'erreur).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRef {
    pub index: u32,
    pub slug: String,
    pub title: String,
}

impl StepRef {
    fn from(ev: &StepEvent) -> Self {
        StepRef {
            index: ev.step,
            slug: ev.slug.clone(),
            title: ev.title.clone(),
        }
    }
}

/// État de progression prêt à afficher, reconstruit en rejouant les évènements.
///
/// L'IHM lie typiquement [`ProgressState::pct`] à la barre et
/// [`ProgressState::current`] au libellé courant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressState {
    pub phase: Phase,
    /// Nombre total d'étapes (connu dès `run_begin`).
    pub total: u32,
    /// Avancement courant 0..=100.
    pub pct: u8,
    /// Étape en cours (ou dernière étape close).
    pub current: Option<StepRef>,
    /// Nombre d'étapes closes (`ok` ou `skip`).
    pub completed: u32,
    /// Étape ayant échoué, le cas échéant.
    pub failure: Option<StepRef>,
    /// Métadonnées d'ouverture (`run_begin`).
    pub run: Option<RunBegin>,
    /// Clôture (`run_end`), une fois reçue.
    pub end: Option<RunEnd>,
}

impl Default for ProgressState {
    fn default() -> Self {
        ProgressState {
            phase: Phase::NotStarted,
            total: 0,
            pct: 0,
            current: None,
            completed: 0,
            failure: None,
            run: None,
            end: None,
        }
    }
}

impl ProgressState {
    /// État initial, avant tout évènement.
    pub fn new() -> Self {
        Self::default()
    }

    /// Applique un évènement déjà parsé.
    pub fn apply(&mut self, ev: &Event) {
        match ev {
            Event::RunBegin(rb) => {
                self.total = rb.total;
                self.phase = Phase::Running;
                self.pct = 0;
                self.run = Some(rb.clone());
            }
            Event::Step(s) => {
                self.total = s.total;
                match s.status {
                    StepStatus::Start => {
                        if self.phase == Phase::NotStarted {
                            self.phase = Phase::Running;
                        }
                        self.pct = s.pct;
                        self.current = Some(StepRef::from(s));
                    }
                    StepStatus::Ok | StepStatus::Skip => {
                        self.completed += 1;
                        self.pct = s.pct;
                        self.current = Some(StepRef::from(s));
                    }
                    StepStatus::Error => {
                        self.pct = s.pct;
                        self.failure = Some(StepRef::from(s));
                        self.phase = Phase::Failed;
                    }
                }
            }
            Event::RunEnd(re) => {
                self.end = Some(re.clone());
                match re.status {
                    RunStatus::Ok => {
                        self.phase = Phase::Succeeded;
                        self.pct = re.pct.unwrap_or(100);
                    }
                    RunStatus::Error => {
                        self.phase = Phase::Failed;
                        if let Some(p) = re.pct {
                            self.pct = p;
                        }
                    }
                }
            }
        }
    }

    /// Classe une ligne brute du flux et, si c'est un évènement, l'applique.
    /// Retourne la nature de la ligne pour que l'appelant route le journal.
    pub fn feed_line(&mut self, line: &str) -> LineKind {
        let kind = classify_line(line);
        if let LineKind::Event(ev) = &kind {
            self.apply(ev);
        }
        kind
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_run_begin_with_escaped_values() {
        let line = r#"{"bobine":1,"ts":"2026-08-14T10:00:00Z","event":"run_begin","version":"2.0","total":15,"user":"fa\"n\\ta","repo":"/home/fa nta/Bob\"ine","log":"/tmp/x.log","mode":"kiosk","dry_run":false}"#;
        match classify_line(line) {
            LineKind::Event(Event::RunBegin(rb)) => {
                assert_eq!(rb.total, 15);
                assert_eq!(rb.user, "fa\"n\\ta"); // \" -> " et \\ -> \
                assert_eq!(rb.repo, "/home/fa nta/Bob\"ine");
                assert_eq!(rb.mode, Mode::Kiosk);
                assert!(!rb.dry_run);
            }
            other => panic!("attendu RunBegin, obtenu {other:?}"),
        }
    }

    #[test]
    fn parses_step_skip_with_detail() {
        let line = r#"{"bobine":1,"ts":"t","event":"step","status":"skip","step":4,"total":15,"pct":26,"slug":"frontend-build","title":"Build du frontend Next.js","detail":"--skip-build"}"#;
        match classify_line(line) {
            LineKind::Event(Event::Step(s)) => {
                assert_eq!(s.status, StepStatus::Skip);
                assert_eq!(s.slug, "frontend-build");
                assert_eq!(s.detail.as_deref(), Some("--skip-build"));
            }
            other => panic!("attendu Step, obtenu {other:?}"),
        }
    }

    #[test]
    fn non_event_line_is_log() {
        assert_eq!(classify_line("  ┃ [1/15] Paquets système (apt)"), LineKind::Log);
        assert_eq!(classify_line("ok redis-server actif"), LineKind::Log);
        // Un objet JSON qui n'est pas un évènement bobine reste du journal.
        assert_eq!(classify_line(r#"{"autre":true}"#), LineKind::Log);
    }

    #[test]
    fn marked_but_broken_line_is_malformed() {
        // Marqueur présent mais JSON tronqué.
        match classify_line(r#"{"bobine":1,"event":"step","status":"#) {
            LineKind::Malformed(_) => {}
            other => panic!("attendu Malformed, obtenu {other:?}"),
        }
    }

    #[test]
    fn state_tracks_start_then_close() {
        let mut st = ProgressState::new();
        st.feed_line(r#"{"bobine":1,"event":"run_begin","total":15,"mode":"kiosk"}"#);
        assert_eq!(st.phase, Phase::Running);
        st.feed_line(r#"{"bobine":1,"event":"step","status":"start","step":1,"total":15,"pct":0,"slug":"packages","title":"Paquets"}"#);
        assert_eq!(st.pct, 0);
        assert_eq!(st.current.as_ref().unwrap().slug, "packages");
        st.feed_line(r#"{"bobine":1,"event":"step","status":"ok","step":1,"total":15,"pct":6,"slug":"packages","title":"Paquets"}"#);
        assert_eq!(st.pct, 6);
        assert_eq!(st.completed, 1);
    }

    #[test]
    fn state_marks_failure_on_error_events() {
        let mut st = ProgressState::new();
        st.feed_line(r#"{"bobine":1,"event":"step","status":"start","step":1,"total":15,"pct":0,"slug":"packages","title":"Paquets"}"#);
        st.feed_line(r#"{"bobine":1,"event":"step","status":"error","step":1,"total":15,"pct":0,"slug":"packages","title":"Paquets","detail":"code 100"}"#);
        assert_eq!(st.phase, Phase::Failed);
        assert_eq!(st.failure.as_ref().unwrap().slug, "packages");
        st.feed_line(r#"{"bobine":1,"event":"run_end","status":"error","rc":100,"step":1,"total":15}"#);
        assert_eq!(st.phase, Phase::Failed);
        assert_eq!(st.end.as_ref().unwrap().rc, Some(100));
    }

    #[test]
    fn run_end_ok_forces_hundred_percent() {
        let mut st = ProgressState::new();
        st.feed_line(r#"{"bobine":1,"event":"run_end","status":"ok","pct":100,"total":15,"healthy":true,"url":"http://bobine.local","port":8000,"dry_run":false}"#);
        assert_eq!(st.phase, Phase::Succeeded);
        assert_eq!(st.pct, 100);
        assert_eq!(st.end.as_ref().unwrap().healthy, Some(true));
    }
}
