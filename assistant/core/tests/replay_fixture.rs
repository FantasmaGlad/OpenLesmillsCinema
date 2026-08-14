//! Test d'intégration : rejoue un flux `install.sh --progress=json` RÉEL
//! (capturé depuis le script, `fixtures/install-events.jsonl`) dans le
//! [`ProgressState`] et vérifie la cohérence de bout en bout. Garde-fou contre
//! toute divergence future entre l'émetteur (install.sh) et le parseur.

use bobine_installer_core::progress::{
    classify_line, Event, LineKind, Mode, Phase, ProgressState, RunStatus, StepStatus,
};

const STREAM: &str = include_str!("fixtures/install-events.jsonl");

#[test]
fn replays_real_install_stream_to_success() {
    let mut state = ProgressState::new();
    let mut events = 0usize;
    let mut starts = 0usize;
    let mut closes = 0usize;

    for line in STREAM.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match state.feed_line(line) {
            LineKind::Event(ev) => {
                events += 1;
                if let Event::Step(s) = &ev {
                    match s.status {
                        StepStatus::Start => starts += 1,
                        StepStatus::Ok | StepStatus::Skip => closes += 1,
                        StepStatus::Error => panic!("aucune erreur attendue: {s:?}"),
                    }
                }
            }
            LineKind::Malformed(e) => panic!("ligne mal formée: {e}\n{line}"),
            LineKind::Log => panic!("ligne de journal inattendue dans un flux pur: {line}"),
        }
    }

    // run_begin + 15 start + 15 close + run_end = 32.
    assert_eq!(events, 32, "nombre d'évènements");
    assert_eq!(starts, 15, "starts");
    assert_eq!(closes, 15, "closes");

    assert_eq!(state.phase, Phase::Succeeded);
    assert_eq!(state.pct, 100);
    assert_eq!(state.total, 15);
    assert_eq!(state.completed, 15);
    assert!(state.failure.is_none());

    let run = state.run.expect("run_begin");
    assert_eq!(run.mode, Mode::Kiosk);
    assert_eq!(run.total, 15);
    // L'échappement JSON de valeurs piégeuses est correctement décodé.
    assert_eq!(run.user, "fa\"n\\ta");
    assert_eq!(run.repo, "/home/fa nta/Bob\"ine");

    let end = state.end.expect("run_end");
    assert_eq!(end.status, RunStatus::Ok);
    assert_eq!(end.healthy, Some(true));
    assert_eq!(end.port, Some(8000));
}

#[test]
fn pct_is_monotone_non_decreasing() {
    let mut last = 0u8;
    for line in STREAM.lines() {
        if let LineKind::Event(ev) = classify_line(line) {
            let pct = match ev {
                Event::Step(s) => Some(s.pct),
                Event::RunEnd(r) => r.pct,
                Event::RunBegin(_) => Some(0),
            };
            if let Some(p) = pct {
                assert!(p >= last, "pct recule: {p} < {last}");
                last = p;
            }
        }
    }
    assert_eq!(last, 100);
}

#[test]
fn every_step_has_a_stable_slug() {
    let expected = [
        "packages", "gpu-access", "python-env", "frontend-build", "config", "cli-tool",
        "uninstaller", "backend-service", "kiosk", "audio", "sudoers", "ntp", "mdns-redirect",
        "watchdog", "activation",
    ];
    let mut seen = Vec::new();
    for line in STREAM.lines() {
        if let LineKind::Event(Event::Step(s)) = classify_line(line) {
            if s.status == StepStatus::Start {
                seen.push(s.slug);
            }
        }
    }
    assert_eq!(seen, expected);
}
