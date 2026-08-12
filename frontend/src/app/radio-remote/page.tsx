"use client";

import React, { useEffect, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useInterpolatedPosition } from "@/lib/useInterpolatedPosition";
import { RadioEvent, RadioRepeatMode, useRadioSocket } from "@/lib/useRadioSocket";
import Icon from "@/components/Icon";

// Télécommande admin du canal radio (réf. docs/cahier-des-charges-radio.md,
// lot L3) : pilote le RadioPlaybackManager à distance (mobile + PC). Le
// lecteur réel (écran /radio, poste dédié) arrive au lot L4 — d'ici là, cette
// page permet déjà de tester/piloter le moteur (playlist, file d'attente,
// shuffle, repeat).

interface RadioPlaylistSummary {
  id: number;
  name: string;
  is_default: boolean;
  item_count: number;
  total_duration_seconds: number;
}

interface RadioTrackSearchResult {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
}

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
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

const REPEAT_CYCLE: RadioRepeatMode[] = ["off", "playlist", "track"];

export default function RadioRemotePage() {
  const { t } = useAppSettings();
  const [lastCause, setLastCause] = useState("sync");
  const handleRadioEvent = (evt: RadioEvent) => setLastCause(evt.cause);
  const { state, connected, sendCommand } = useRadioSocket(handleRadioEvent);
  const livePosition = useInterpolatedPosition(state.position_seconds, state.playing, lastCause);

  const [playlists, setPlaylists] = useState<RadioPlaylistSummary[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [shuffleOnLoad, setShuffleOnLoad] = useState(false);
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const [volumeDragValue, setVolumeDragValue] = useState<number | null>(null);
  const [queueSearch, setQueueSearch] = useState("");
  const [queueResults, setQueueResults] = useState<RadioTrackSearchResult[]>([]);

  useEffect(() => {
    fetch(getApiUrl("/radio/playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, []);

  useEffect(() => {
    const query = queueSearch.trim();
    if (!query) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset volontaire quand la recherche est vidée
      setQueueResults([]);
      return;
    }
    const id = setTimeout(() => {
      fetch(getApiUrl(`/radio/tracks?q=${encodeURIComponent(query)}`), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : []))
        .then((data: RadioTrackSearchResult[]) => setQueueResults(data.slice(0, 8)))
        .catch(() => setQueueResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [queueSearch]);

  const currentTrack = state.current_track;
  const coverSrc = currentTrack?.cover_url ? getApiUrl(currentTrack.cover_url) : null;
  const duration = state.duration_seconds ?? currentTrack?.duration_seconds ?? 0;
  const displayPosition = seekDragValue ?? livePosition;
  const displayVolume = volumeDragValue ?? state.volume;
  const queue = state.index !== null ? state.order.slice(state.index + 1) : [];

  const handleLaunch = () => {
    if (!selectedPlaylistId) return;
    sendCommand("load_radio_playlist", { playlist_id: Number(selectedPlaylistId), shuffle: shuffleOnLoad });
  };

  const handlePlayPause = () => sendCommand(state.playing ? "pause" : "play");

  const handleRepeatCycle = () => {
    const next = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(state.repeat) + 1) % REPEAT_CYCLE.length];
    sendCommand("radio_set_repeat", { mode: next });
  };

  const repeatLabel =
    state.repeat === "track" ? t("radioRemote.repeatTrack") : state.repeat === "playlist" ? t("radioRemote.repeatPlaylist") : t("radioRemote.repeatOff");

  return (
    <div className="dashboard-container">
      <div className="live-block">
        <div className="live-header">
          <h3>
            <Icon name="graphic_eq" size={18} />
            {t("radioRemote.title")}
          </h3>
          <span className={`status-pill ${connected ? "ok" : "down"}`}>
            {!connected ? t("radioRemote.disconnected") : t(`radioRemote.stateLabels.${state.state}`)}
          </span>
        </div>

        {state.playlist_name && (
          <div
            style={{
              fontSize: "0.85rem",
              color: "var(--accent-primary)",
              fontWeight: 700,
              background: "color-mix(in srgb, var(--accent-primary) 3%, transparent)",
              padding: "10px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid color-mix(in srgb, var(--accent-primary) 15%, transparent)",
              marginBottom: "12px",
            }}
          >
            {t("radioRemote.playlistLabel", {
              name: state.playlist_name,
              index: (state.index ?? 0) + 1,
              total: state.order.length,
            })}
          </div>
        )}

        {currentTrack ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              {coverSrc ? (
                <img
                  src={coverSrc}
                  alt=""
                  style={{ width: "56px", height: "56px", objectFit: "cover", borderRadius: "var(--radius-sm)", flexShrink: 0, background: "#000" }}
                />
              ) : (
                <div
                  style={{
                    width: "56px", height: "56px", borderRadius: "var(--radius-sm)", flexShrink: 0,
                    background: "var(--bg-surface-hover)", display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Icon name="music_note" size={24} />
                </div>
              )}
              <div>
                <div className="live-title">{currentTrack.title}</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {currentTrack.artist || t("radioLibrary.unknownArtist")}
                  {currentTrack.album ? ` — ${currentTrack.album}` : ""}
                </div>
              </div>
            </div>

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
                  sendCommand("radio_seek", { position_seconds: value });
                  setSeekDragValue(null);
                }}
                className="seek-slider"
              />
              <span className="live-time">{formatTime(duration)}</span>
            </div>

            <div className="live-controls">
              <button className="btn btn-secondary control-btn" onClick={() => sendCommand("stop")}>
                <Icon name="stop" size={18} />
                {t("radioRemote.stop")}
              </button>
              <button className="btn btn-secondary control-btn" onClick={() => sendCommand("radio_previous_track")} title={t("radioRemote.previousTrack")}>
                <Icon name="skip_previous" size={18} filled />
              </button>
              <button className="btn btn-primary control-btn control-btn-main" onClick={handlePlayPause}>
                <Icon name={state.playing ? "pause" : "play_arrow"} size={20} filled />
                {state.playing ? t("radioRemote.pause") : t("radioRemote.play")}
              </button>
              <button className="btn btn-secondary control-btn" onClick={() => sendCommand("radio_next_track")} title={t("radioRemote.nextTrack")}>
                <Icon name="skip_next" size={18} filled />
              </button>
              <button
                className={`btn ${state.shuffle ? "btn-primary" : "btn-secondary"} control-btn`}
                onClick={() => sendCommand("radio_set_shuffle", { on: !state.shuffle })}
                title={t("radioRemote.shuffleLabel")}
              >
                <Icon name="shuffle" size={18} />
              </button>
              <button className={`btn ${state.repeat !== "off" ? "btn-primary" : "btn-secondary"} control-btn`} onClick={handleRepeatCycle} title={repeatLabel}>
                <Icon name={state.repeat === "track" ? "repeat_one" : "repeat"} size={18} />
              </button>
            </div>

            <div className="volume-row">
              <span>{t("radioRemote.volume")}</span>
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
        ) : (
          <div className="live-empty">{t("radioRemote.emptyNowPlaying")}</div>
        )}
      </div>

      <div className="launch-block">
        <h3>{t("radioRemote.loadPlaylistTitle")}</h3>
        <div className="launch-row">
          <select className="filter-select" style={{ flex: 1 }} value={selectedPlaylistId} onChange={(e) => setSelectedPlaylistId(e.target.value)}>
            <option value="">{t("radioRemote.choosePlaylist")}</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.item_count} — {formatDuration(p.total_duration_seconds)})
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={handleLaunch} disabled={!selectedPlaylistId}>
            <Icon name="play_arrow" size={16} filled />
            {t("radioRemote.launch")}
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", fontSize: "0.85rem", color: "var(--text-muted)" }}>
          <input type="checkbox" checked={shuffleOnLoad} onChange={(e) => setShuffleOnLoad(e.target.checked)} />
          {t("radioRemote.shuffleOnLoad")}
        </label>
        {/* Lecture aléatoire de TOUTE la bibliothèque, sans playlist (réf.
            demande user) : indépendant du sélecteur ci-dessus. */}
        <button className="btn btn-secondary" style={{ width: "100%", marginTop: "10px" }} onClick={() => sendCommand("radio_shuffle_all")}>
          <Icon name="shuffle" size={16} />
          {t("radioRemote.shuffleAll")}
        </button>
        {playlists.length === 0 && <p className="live-empty" style={{ marginTop: "12px" }}>{t("radioRemote.noPlaylists")}</p>}
      </div>

      <div className="live-block">
        <div className="live-header">
          <h3>{t("radioRemote.queueTitle")}</h3>
        </div>
        {queue.length === 0 ? (
          <p className="live-empty">{t("radioRemote.queueEmpty")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {queue.map((track, i) => (
              <div
                key={`${track.id}-${i}`}
                className="olc-card-hover"
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "10px 12px", background: "var(--bg-surface-elevated)",
                  borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)",
                }}
              >
                <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                  {track.title}
                  <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> — {track.artist || t("radioLibrary.unknownArtist")}</span>
                </span>
                <button
                  className="btn btn-secondary"
                  style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }}
                  onClick={() => sendCommand("radio_remove_from_queue", { index: (state.index ?? -1) + 1 + i })}
                >
                  <Icon name="close" size={14} />
                  {t("radioRemote.remove")}
                </button>
              </div>
            ))}
          </div>
        )}

        <h3 style={{ marginTop: "18px" }}>{t("radioRemote.addToQueueTitle")}</h3>
        <input
          type="text"
          className="filter-select"
          style={{ width: "100%" }}
          placeholder={t("radioRemote.addToQueueSearchPlaceholder")}
          value={queueSearch}
          onChange={(e) => setQueueSearch(e.target.value)}
        />
        {queueSearch.trim() && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
            {queueResults.length === 0 ? (
              <p className="live-empty">{t("radioRemote.noSearchResults")}</p>
            ) : (
              queueResults.map((track) => (
                <div
                  key={track.id}
                  className="olc-card-hover"
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 12px", background: "var(--bg-surface-elevated)",
                    borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                    {track.title}
                    <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> — {track.artist || t("radioLibrary.unknownArtist")}</span>
                  </span>
                  <button
                    className="btn btn-secondary"
                    style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }}
                    onClick={() => sendCommand("radio_add_to_queue", { track_id: track.id })}
                  >
                    <Icon name="add" size={14} />
                    {t("radioRemote.add")}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
