"use client";

import React, { useEffect, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import { useTimerSocket } from "@/lib/useTimerSocket";

interface VideoSummary {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  duration_seconds: number | null;
}

interface PlaylistSummary {
  id: number;
  name: string;
  item_count: number;
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

function formatDuration(seconds: number) {
  if (!seconds) return "0 min";
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

function formatTimerDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const STATE_LABELS: Record<string, string> = {
  waiting: "En attente",
  countdown: "Compte à rebours",
  playing: "Lecture",
  paused: "Pause",
  coach_mode: "Mode coach",
  offline: "Hors ligne",
  playlist_waiting: "Attente inter-cours",
};

const TIMER_MODE_LABELS: Record<string, string> = {
  next_course: "Prochain cours",
  countdown: "Minuteur",
  countup: "Chrono",
  hidden: "Masqué",
};

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2];

export default function DashboardPage() {
  const { state, connected, sendCommand } = usePlaybackSocket();
  const { state: timerState, sendCommand: sendTimerCommand } = useTimerSocket();
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string>("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const [volumeDragValue, setVolumeDragValue] = useState<number | null>(null);
  const [customMinutes, setCustomMinutes] = useState<string>("5");

  useEffect(() => {
    fetch(getApiUrl("/videos?sort_by=imported_at&order=desc"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setVideos)
      .catch(() => setVideos([]));

    fetch(getApiUrl("/playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, []);

  const isActive = state.current_video !== null || state.state === "playlist_waiting";
  const duration = state.current_video?.duration_seconds ?? 0;
  const displayPosition = seekDragValue ?? state.position_seconds;
  const displayVolume = volumeDragValue ?? state.volume;

  const nextPlaylistItem = state.playlist_items && state.playlist_index !== null && state.playlist_index !== undefined
    ? state.playlist_items[state.playlist_index + 1]
    : null;

  const handleLaunch = () => {
    if (!selectedVideoId) return;
    sendCommand("load", { video_id: Number(selectedVideoId) });
  };

  const handleLaunchPlaylist = () => {
    if (!selectedPlaylistId) return;
    sendCommand("load_playlist", { playlist_id: Number(selectedPlaylistId) });
  };

  const handlePlayPause = () => {
    sendCommand(state.state === "playing" ? "pause" : "play");
  };

  const handleTimerPauseResume = () => {
    sendTimerCommand(timerState.running ? "pause" : "resume");
  };

  return (
    <div className="dashboard-container">
      <div className="live-block">
        <div className="live-header">
          <h3>En direct</h3>
          <span className={`status-pill ${connected ? "ok" : "down"}`}>
            {connected ? STATE_LABELS[state.state] ?? state.state : "Déconnecté"}
          </span>
        </div>

        {isActive ? (
          <>
            {/* Playlist Indicator & Quick Navigation */}
            {state.playlist_name && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(228, 0, 43, 0.03)", padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid rgba(228, 0, 43, 0.15)", marginBottom: "12px" }}>
                <span style={{ fontSize: "0.85rem", color: "var(--accent-primary)", fontWeight: 700 }}>
                  Playlist : {state.playlist_name} [{(state.playlist_index ?? 0) + 1}/{state.playlist_items?.length ?? 0}]
                </span>
                {state.playlist_items && state.playlist_index !== null && (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      className="btn btn-secondary"
                      style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "4px" }}
                      onClick={() => sendCommand("previous_video")}
                      disabled={state.playlist_index === 0}
                      title="Cours précédent"
                    >
                      ⏮ Préc.
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "4px" }}
                      onClick={() => sendCommand("next_video")}
                      disabled={state.playlist_index === state.playlist_items.length - 1}
                      title="Cours suivant"
                    >
                      Suiv. ⏭
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* If in playlist wait transition, show dedicated overlay control */}
            {state.state === "playlist_waiting" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "center", justifyContent: "center", padding: "20px", background: "rgba(255,255,255,0.02)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)" }}>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
                  Temps de transition restant
                </span>
                <span style={{ fontSize: "2.5rem", fontWeight: 900, color: "var(--accent-primary)", fontVariantNumeric: "tabular-nums" }}>
                  {Math.ceil(state.playlist_waiting_remaining ?? 0)} s
                </span>
                {nextPlaylistItem ? (
                  <span style={{ fontSize: "0.9rem", color: "var(--text-main)", fontWeight: 700, textAlign: "center" }}>
                    Prochain cours : {nextPlaylistItem.title}
                  </span>
                ) : (
                  <span style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
                    Fin de la playlist
                  </span>
                )}
                <div style={{ display: "flex", gap: "10px", width: "100%", marginTop: "8px" }}>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, height: "40px", fontSize: "0.85rem" }}
                    onClick={() => sendCommand("skip_waiting")}
                  >
                    Lancer immédiatement
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ height: "40px", padding: "0 16px", fontSize: "0.85rem" }}
                    onClick={() => sendCommand("stop")}
                  >
                    Stop
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="live-title">{state.current_video?.title}</div>

                <div className="live-progress">
                  <span className="live-time">{formatTime(displayPosition)}</span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={1}
                    value={displayPosition}
                    onChange={(e) => setSeekDragValue(Number(e.target.value))}
                    onMouseUp={(e) => {
                      const value = Number((e.target as HTMLInputElement).value);
                      sendCommand("seek", { position_seconds: value });
                      setSeekDragValue(null);
                    }}
                    className="seek-slider"
                  />
                  <span className="live-time">{formatTime(duration)}</span>
                </div>

                <div className="live-controls">
                  <button className="btn btn-secondary control-btn" onClick={() => sendCommand("stop")}>
                    Stop
                  </button>
                  <button className="btn btn-primary control-btn control-btn-main" onClick={handlePlayPause}>
                    {state.state === "playing" ? "Pause" : "Lecture"}
                  </button>
                  <div className="speed-group">
                    {SPEED_OPTIONS.map((s) => (
                      <button
                        key={s}
                        className={`speed-btn ${state.speed === s ? "active" : ""}`}
                        onClick={() => sendCommand("speed", { speed: s })}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>

                <div className="volume-row">
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={displayVolume}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setVolumeDragValue(value);
                      sendCommand("volume", { volume: value });
                    }}
                    onMouseUp={() => setVolumeDragValue(null)}
                    className="volume-slider"
                  />
                  <span className="volume-value">{displayVolume}%</span>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="live-empty">
            Aucun cours en cours. Sélectionnez une vidéo ou une playlist ci-dessous pour la lancer.
          </div>
        )}
      </div>

      <div className="timer-block">
        <div className="live-header">
          <h3>Minuteur</h3>
          <span className={`status-pill ${timerState.mode !== "hidden" ? "ok" : "down"}`}>
            {TIMER_MODE_LABELS[timerState.mode] ?? timerState.mode}
          </span>
        </div>

        <div className="timer-mode-group">
          {(["next_course", "countdown", "countup", "hidden"] as const).map((mode) => (
            <button
              key={mode}
              className={`speed-btn ${timerState.mode === mode ? "active" : ""}`}
              onClick={() => sendTimerCommand("set_mode", { mode })}
            >
              {TIMER_MODE_LABELS[mode]}
            </button>
          ))}
        </div>

        {timerState.mode === "countdown" && (
          <>
            <div className="timer-display">{formatTimerDuration(timerState.remaining_seconds ?? 0)}</div>
            <div className="live-controls">
              <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("start_countdown", { seconds: 30 })}>
                30 s
              </button>
              <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("start_countdown", { seconds: 60 })}>
                1 min
              </button>
              <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("start_countdown", { seconds: 300 })}>
                5 min
              </button>
            </div>
            <div className="launch-row">
              <input
                type="number"
                min={1}
                className="form-control"
                style={{ width: "90px" }}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
              />
              <span style={{ alignSelf: "center", color: "var(--text-muted)" }}>min</span>
              <button
                className="btn btn-primary"
                onClick={() => sendTimerCommand("start_countdown", { seconds: Math.max(1, Number(customMinutes) || 0) * 60 })}
              >
                Démarrer
              </button>
            </div>
            {timerState.remaining_seconds !== null && (
              <div className="live-controls">
                <button className="btn btn-secondary control-btn" onClick={handleTimerPauseResume}>
                  {timerState.running ? "Pause" : "Reprendre"}
                </button>
                <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("adjust", { delta_seconds: -10 })}>
                  -10 s
                </button>
                <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("adjust", { delta_seconds: 10 })}>
                  +10 s
                </button>
                <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("reset")}>
                  Réinitialiser
                </button>
              </div>
            )}
          </>
        )}

        {timerState.mode === "countup" && (
          <>
            <div className="timer-display">{formatTimerDuration(timerState.elapsed_seconds ?? 0)}</div>
            <div className="live-controls">
              {timerState.elapsed_seconds === null ? (
                <button className="btn btn-primary control-btn" onClick={() => sendTimerCommand("start_countup")}>
                  Démarrer
                </button>
              ) : (
                <>
                  <button className="btn btn-secondary control-btn" onClick={handleTimerPauseResume}>
                    {timerState.running ? "Pause" : "Reprendre"}
                  </button>
                  <button className="btn btn-secondary control-btn" onClick={() => sendTimerCommand("reset")}>
                    Réinitialiser
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {timerState.mode === "next_course" && (
          <p className="live-empty">Affiche sur l&apos;écran cinéma le temps restant avant le prochain cours programmé.</p>
        )}
      </div>

      <div className="launch-block">
        <h3>Lancer un cours</h3>
        <div className="launch-row">
          <select
            className="filter-select"
            style={{ flex: 1 }}
            value={selectedVideoId}
            onChange={(e) => setSelectedVideoId(e.target.value)}
          >
            <option value="">Choisir une vidéo...</option>
            {videos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title} {v.program ? `— ${v.program}` : ""} {v.release ? `#${v.release}` : ""}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={handleLaunch} disabled={!selectedVideoId}>
            Lancer
          </button>
        </div>
        {videos.length === 0 && (
          <p className="live-empty" style={{ marginTop: "12px" }}>
            Aucune vidéo dans la bibliothèque pour le moment.
          </p>
        )}
      </div>

      <div className="launch-block">
        <h3>Lancer une playlist</h3>
        <div className="launch-row">
          <select
            className="filter-select"
            style={{ flex: 1 }}
            value={selectedPlaylistId}
            onChange={(e) => setSelectedPlaylistId(e.target.value)}
          >
            <option value="">Choisir une playlist...</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.item_count} cours — {formatDuration(p.total_duration_seconds)})
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={handleLaunchPlaylist} disabled={!selectedPlaylistId}>
            Lancer
          </button>
        </div>
        {playlists.length === 0 && (
          <p className="live-empty" style={{ marginTop: "12px" }}>
            Aucune playlist dans la bibliothèque pour le moment.
          </p>
        )}
      </div>
    </div>
  );
}
