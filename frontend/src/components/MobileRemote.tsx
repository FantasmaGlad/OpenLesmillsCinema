"use client";

import React, { useRef, useState } from "react";
import type { PlaybackState } from "@/lib/usePlaybackSocket";
import type { TimerState } from "@/lib/useTimerSocket";

interface VideoSummary {
  id: number;
  title: string;
  program: string | null;
  duration_seconds: number | null;
}

interface PlaylistSummary {
  id: number;
  name: string;
  item_count: number;
}

interface BackgroundSummary {
  id: number;
  title: string;
}

interface MobileRemoteProps {
  state: PlaybackState;
  connected: boolean;
  sendCommand: (command: string, params?: Record<string, unknown>) => void;
  timerState: TimerState;
  sendTimerCommand: (command: string, params?: Record<string, unknown>) => void;
  videos: VideoSummary[];
  playlists: PlaylistSummary[];
  backgrounds: BackgroundSummary[];
  getApiUrl: (path: string) => string;
}

function formatTime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STOP_HOLD_MS = 650;

export default function MobileRemote({
  state,
  connected,
  sendCommand,
  timerState,
  sendTimerCommand,
  videos,
  playlists,
  backgrounds,
  getApiUrl,
}: MobileRemoteProps) {
  const [sheet, setSheet] = useState<"none" | "timer" | "launch">("none");
  const [launchSearch, setLaunchSearch] = useState("");
  const [holdingStop, setHoldingStop] = useState(false);
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isActive = state.current_video !== null || state.state === "playlist_waiting" || state.state === "background";
  const duration = state.current_video?.duration_seconds ?? 0;
  const displayPosition = seekDragValue ?? state.position_seconds;

  const startStopHold = () => {
    setHoldingStop(true);
    stopTimerRef.current = setTimeout(() => {
      sendCommand("stop");
      setHoldingStop(false);
    }, STOP_HOLD_MS);
  };

  const cancelStopHold = () => {
    setHoldingStop(false);
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  };

  const filteredVideos = videos.filter((v) => v.title.toLowerCase().includes(launchSearch.toLowerCase()));
  const filteredPlaylists = playlists.filter((p) => p.name.toLowerCase().includes(launchSearch.toLowerCase()));
  const filteredBackgrounds = backgrounds.filter((b) => b.title.toLowerCase().includes(launchSearch.toLowerCase()));

  return (
    <div className="mobile-remote">
      {!connected ? (
        <div className="mobile-remote-empty">Connexion à l&apos;écran cinéma...</div>
      ) : !isActive ? (
        <div className="mobile-remote-empty">
          <p>Aucun cours en cours.</p>
          <button className="btn btn-primary" style={{ height: "56px", marginTop: "16px" }} onClick={() => setSheet("launch")}>
            Lancer un cours
          </button>
        </div>
      ) : (
        <>
          <div className="mobile-remote-now">
            {state.current_video?.thumbnail_url && (
              <img
                src={getApiUrl(`/thumbnails/${state.current_video.thumbnail_url}`)}
                alt=""
                className="mobile-remote-thumb"
              />
            )}
            <span className="mobile-remote-title">
              {state.current_video?.title || (state.state === "background" ? state.current_background?.title : "")}
            </span>
          </div>

          <div className="mobile-remote-progress">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={1}
              value={displayPosition}
              disabled={state.state === "background"}
              onChange={(e) => setSeekDragValue(Number(e.target.value))}
              onMouseUp={(e) => {
                sendCommand("seek", { position_seconds: Number((e.target as HTMLInputElement).value) });
                setSeekDragValue(null);
              }}
              onTouchEnd={(e) => {
                sendCommand("seek", { position_seconds: Number((e.target as HTMLInputElement).value) });
                setSeekDragValue(null);
              }}
              className="seek-slider mobile-remote-seek"
            />
            <div className="mobile-remote-time-row">
              <span>{formatTime(displayPosition)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </>
      )}

      <div className="mobile-remote-controls">
        <button
          className="coach-btn"
          onClick={() => sendCommand("previous_video")}
          disabled={state.playlist_index === null || state.playlist_index === 0}
        >
          ⏮
        </button>
        <button
          className="coach-btn coach-btn-main"
          style={{ background: "var(--accent-primary)" }}
          onClick={() => sendCommand(state.state === "playing" ? "pause" : "play")}
          disabled={!isActive || state.state === "background"}
        >
          {state.state === "playing" ? "⏸" : "▶"}
        </button>
        <button
          className="coach-btn"
          onClick={() => sendCommand("next_video")}
          disabled={state.playlist_items === null || state.playlist_index === (state.playlist_items?.length ?? 1) - 1}
        >
          ⏭
        </button>
      </div>

      {/* Stop en appui long, sans confirmation (réf. UX4.2/UX5.2) */}
      <button
        className={`coach-btn coach-btn-wide mobile-remote-stop ${holdingStop ? "holding" : ""}`}
        disabled={!isActive}
        onPointerDown={startStopHold}
        onPointerUp={cancelStopHold}
        onPointerLeave={cancelStopHold}
        onContextMenu={(e) => e.preventDefault()}
      >
        {holdingStop ? "Maintenez pour arrêter..." : "■ Stop (appui long)"}
      </button>

      <div className="coach-volume-row" style={{ maxWidth: "none" }}>
        <button className="coach-btn coach-btn-square" onClick={() => sendCommand("volume", { volume: Math.max(0, state.volume - 10) })}>
          −
        </button>
        <span className="coach-volume-value">🔊 {state.volume}%</span>
        <button className="coach-btn coach-btn-square" onClick={() => sendCommand("volume", { volume: Math.min(100, state.volume + 10) })}>
          +
        </button>
      </div>

      <div className="mobile-remote-quick-row">
        <button className="btn btn-secondary mobile-remote-quick-btn" onClick={() => setSheet("timer")}>
          ⏱ Minuteur
        </button>
        <button className="btn btn-secondary mobile-remote-quick-btn" onClick={() => setSheet("launch")}>
          ▶ Lancer
        </button>
        <a href="/coach/" className="btn btn-primary mobile-remote-quick-btn" style={{ textDecoration: "none" }}>
          🎤 Mode coach
        </a>
      </div>

      {sheet !== "none" && (
        <div className="coach-sheet-overlay" onClick={() => setSheet("none")}>
          <div className="coach-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="coach-sheet-handle" />
            {sheet === "timer" ? (
              <>
                <h3 style={{ margin: "0 0 12px" }}>Minuteur</h3>
                <div className="timer-mode-group">
                  {(["next_course", "countdown", "countup", "hidden"] as const).map((mode) => (
                    <button
                      key={mode}
                      className={`speed-btn ${timerState.mode === mode ? "active" : ""}`}
                      style={{ minHeight: "48px" }}
                      onClick={() => sendTimerCommand("set_mode", { mode })}
                    >
                      {{ next_course: "Prochain cours", countdown: "Minuteur", countup: "Chrono", hidden: "Masqué" }[mode]}
                    </button>
                  ))}
                </div>
                {timerState.mode === "countdown" && (
                  <div className="live-controls" style={{ marginTop: "16px" }}>
                    <button className="btn btn-secondary coach-btn" onClick={() => sendTimerCommand("start_countdown", { seconds: 30 })}>30s</button>
                    <button className="btn btn-secondary coach-btn" onClick={() => sendTimerCommand("start_countdown", { seconds: 60 })}>1min</button>
                    <button className="btn btn-secondary coach-btn" onClick={() => sendTimerCommand("start_countdown", { seconds: 300 })}>5min</button>
                  </div>
                )}
                <button className="btn btn-secondary" style={{ height: "48px", marginTop: "16px" }} onClick={() => setSheet("none")}>
                  Fermer
                </button>
              </>
            ) : (
              <>
                <h3 style={{ margin: "0 0 12px" }}>Lancer</h3>
                <input
                  type="text"
                  className="search-input"
                  style={{ width: "100%", marginBottom: "12px" }}
                  placeholder="Rechercher..."
                  value={launchSearch}
                  onChange={(e) => setLaunchSearch(e.target.value)}
                />
                <div className="coach-sheet-list">
                  {filteredPlaylists.map((p) => (
                    <button key={`pl-${p.id}`} className="coach-sheet-track" onClick={() => { sendCommand("load_playlist", { playlist_id: p.id }); setSheet("none"); }}>
                      <span>📋 {p.name}</span>
                      <span style={{ color: "var(--text-muted)" }}>{p.item_count} cours</span>
                    </button>
                  ))}
                  {filteredBackgrounds.map((b) => (
                    <button key={`bg-${b.id}`} className="coach-sheet-track" onClick={() => { sendCommand("load_background", { background_id: b.id }); setSheet("none"); }}>
                      <span>🖼 {b.title}</span>
                      <span style={{ color: "var(--text-muted)" }}>Fond animé</span>
                    </button>
                  ))}
                  {filteredVideos.map((v) => (
                    <button key={`v-${v.id}`} className="coach-sheet-track" onClick={() => { sendCommand("load", { video_id: v.id }); setSheet("none"); }}>
                      <span>🎬 {v.title}</span>
                      <span style={{ color: "var(--text-muted)" }}>{v.program || "Autre"}</span>
                    </button>
                  ))}
                  {filteredVideos.length === 0 && filteredPlaylists.length === 0 && filteredBackgrounds.length === 0 && (
                    <p className="live-empty">Aucun résultat.</p>
                  )}
                </div>
                <button className="btn btn-secondary" style={{ height: "48px", marginTop: "12px" }} onClick={() => setSheet("none")}>
                  Fermer
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
