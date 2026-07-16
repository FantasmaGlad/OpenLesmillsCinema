"use client";

import React, { useEffect, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";

interface AudioCourseSummary {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  track_count: number;
  total_duration_seconds: number;
}

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8000/api${path}`;
  }
  return `/api${path}`;
}

function formatTime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const PROGRAM_ACCENT: Record<string, string> = {
  RPM: "var(--accent-rpm)",
  Sprint: "var(--accent-sprint)",
  "The Trip": "var(--accent-trip)",
};

const CHAIN_MODE_LABELS: Record<string, string> = {
  auto: "Auto",
  timer: "Auto + minuterie",
  manual: "Manuel",
};

export default function CoachModePage() {
  const { state, connected, sendCommand } = usePlaybackSocket();
  const [courses, setCourses] = useState<AudioCourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTrackList, setShowTrackList] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch(getApiUrl("/audio"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setCourses)
      .catch(() => setCourses([]))
      .finally(() => setLoading(false));
  }, []);

  const isCoachMode = state.state === "coach_mode";
  const course = state.current_audio_course;
  const program = course?.program ?? undefined;
  const accent = (program && PROGRAM_ACCENT[program]) || "var(--accent-primary)";
  const tracks = state.audio_tracks || [];
  const trackIndex = state.audio_track_index ?? 0;
  const currentTrack = tracks[trackIndex] || null;
  const remaining = currentTrack?.duration_seconds
    ? Math.max(0, currentTrack.duration_seconds - state.audio_position_seconds)
    : null;

  const filteredCourses = courses.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));

  // Tap 2/2 : le choix du cours suffit à le lancer (réf. F10.4/UX4.9).
  const launchCourse = (courseId: number) => {
    sendCommand("load_audio_course", { audio_course_id: courseId });
  };

  if (!isCoachMode) {
    return (
      <div className="coach-screen coach-picker-screen">
        <div className="coach-picker-header">
          <h1 className="coach-picker-title">Mode coach</h1>
          <p className="coach-picker-subtitle">
            {connected ? "Choisissez un cours pour le lancer" : "Connexion à l'écran cinéma..."}
          </p>
          <input
            type="text"
            className="search-input coach-picker-search"
            placeholder="Rechercher un cours..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="coach-picker-list">
          {loading ? (
            <p className="live-empty">Chargement des cours...</p>
          ) : filteredCourses.length === 0 ? (
            <p className="live-empty">Aucun cours audio disponible. Importez-en un depuis le PC.</p>
          ) : (
            filteredCourses.map((c) => (
              <button key={c.id} className="coach-course-item" onClick={() => launchCourse(c.id)}>
                <span
                  className="coach-course-item-accent"
                  style={{ background: (c.program && PROGRAM_ACCENT[c.program]) || "var(--accent-other)" }}
                />
                <span className="coach-course-item-body">
                  <span className="coach-course-item-title">{c.title}</span>
                  <span className="coach-course-item-meta">
                    {c.program || "Autre"} · {c.track_count} piste(s)
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="coach-screen coach-live-screen" style={{ borderTopColor: accent }}>
      <div className="coach-live-header">
        <span className="coach-live-course-title" style={{ color: accent }}>
          {course?.title}
        </span>
        <button className="coach-icon-btn" onClick={() => sendCommand("stop")} title="Quitter le mode coach">
          ✕
        </button>
      </div>

      <div className="coach-live-track-block">
        <span className="coach-live-track-label">
          {currentTrack ? `Piste ${trackIndex + 1} / ${tracks.length}` : "Aucune piste"}
        </span>
        <span className="coach-live-track-title">{currentTrack?.title}</span>
        <span className="coach-live-track-time">- {formatTime(remaining)}</span>
      </div>

      <div className="coach-controls-grid">
        <button className="coach-btn" onClick={() => sendCommand("audio_previous_track")} disabled={trackIndex <= 0}>
          ⏮
        </button>
        <button
          className="coach-btn coach-btn-main"
          style={{ background: accent }}
          onClick={() => sendCommand(state.audio_playing ? "pause" : "play")}
        >
          {state.audio_playing ? "⏸" : "▶"}
        </button>
        <button className="coach-btn" onClick={() => sendCommand("audio_next_track")} disabled={trackIndex >= tracks.length - 1}>
          ⏭
        </button>
      </div>

      <button className="coach-btn coach-btn-wide" onClick={() => sendCommand("audio_restart_track")}>
        ↺ Relancer la piste
      </button>

      <div className="coach-volume-row">
        <button className="coach-btn coach-btn-square" onClick={() => sendCommand("volume", { volume: Math.max(0, state.volume - 10) })}>
          −
        </button>
        <span className="coach-volume-value">🔊 {state.volume}%</span>
        <button className="coach-btn coach-btn-square" onClick={() => sendCommand("volume", { volume: Math.min(100, state.volume + 10) })}>
          +
        </button>
      </div>

      <div className="coach-chain-mode-row">
        {(["auto", "timer", "manual"] as const).map((mode) => (
          <button
            key={mode}
            className={`speed-btn ${state.audio_chain_mode === mode ? "active" : ""}`}
            style={{ minHeight: "48px" }}
            onClick={() => sendCommand("audio_set_chain_mode", { mode })}
          >
            {CHAIN_MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      <button className="coach-tracklist-toggle" onClick={() => setShowTrackList(true)}>
        Voir les {tracks.length} pistes ▲
      </button>

      {showTrackList && (
        <div className="coach-sheet-overlay" onClick={() => setShowTrackList(false)}>
          <div className="coach-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="coach-sheet-handle" />
            <h3 style={{ margin: "0 0 12px" }}>Pistes du cours</h3>
            <div className="coach-sheet-list">
              {tracks.map((t, idx) => (
                <button
                  key={t.id}
                  className={`coach-sheet-track ${idx === trackIndex ? "active" : ""}`}
                  onClick={() => {
                    sendCommand("audio_jump_to_track", { index: idx });
                    setShowTrackList(false);
                  }}
                >
                  <span>{idx + 1}. {t.title}</span>
                  <span style={{ color: "var(--text-muted)" }}>{formatTime(t.duration_seconds)}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-secondary" style={{ height: "48px", marginTop: "12px" }} onClick={() => setShowTrackList(false)}>
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
