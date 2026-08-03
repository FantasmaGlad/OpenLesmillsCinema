"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePlaybackSocket, PlaybackChannel, PlaybackEvent } from "@/lib/usePlaybackSocket";
import { useIsMobile } from "@/lib/useIsMobile";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useInterpolatedPosition } from "@/lib/useInterpolatedPosition";
import MobileRemote from "@/components/MobileRemote";
import DisplayOutputSwitch from "@/components/DisplayOutputSwitch";
import Icon from "@/components/Icon";

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

interface AudioPlaylistSummary {
  id: number;
  name: string;
  item_count: number;
  total_duration_seconds: number;
}

interface OccurrenceSummary {
  schedule_id: number;
  run_at: string;
  title: string | null;
  program: string | null;
  override_action: string | null;
}

interface BackgroundSummary {
  id: number;
  title: string;
}

interface InterruptedState {
  id: number;
  cause: string | null;
  interrupted_at: string;
  // Forme F5.3 (cause="schedule") : lecture manuelle interrompue par une programmation.
  video_id?: number | null;
  title?: string | null;
  position_seconds?: number | null;
  // Forme F10.7 (cause="coach_priority") : programmation reportée par le mode audio coach.
  target_type?: string | null;
  target_id?: number | null;
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

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2];

interface Props {
  /** Canal de diffusion piloté par ce tableau de bord (réf. mission
   * "Tableau de bord Câblé / Réseau") : toute cette page — état en direct,
   * lancements, planning à venir, bascule kiosk/cinéma — ne parle QUE de ce
   * canal, l'autre a sa propre page jumelle totalement indépendante. */
  channel: PlaybackChannel;
}

/**
 * Tableau de bord d'UN canal de diffusion (PC : page complète ; mobile :
 * télécommande dédiée). Réf. mission "Tableau de bord Câblé / Réseau" :
 * musique/playlist en direct, lancement de cours/playlist, planning et
 * bascule kiosk/cinéma, indépendants entre les deux canaux.
 */
export default function DashboardScreen({ channel }: Props) {
  const isMobile = useIsMobile();
  const { t, language } = useAppSettings();
  const STATE_LABELS: Record<string, string> = {
    waiting: t("dashboard.stateLabels.waiting"),
    playing: t("dashboard.stateLabels.playing"),
    paused: t("dashboard.stateLabels.paused"),
    coach_mode: t("dashboard.stateLabels.coach_mode"),
    offline: t("dashboard.stateLabels.offline"),
    playlist_waiting: t("dashboard.stateLabels.playlist_waiting"),
  };
  // Cause du dernier évènement reçu (réf. retour utilisateur 2026-07-21 "la
  // tête de lecture tremblote") : seul un rapport de routine ("position_tick")
  // doit être lissé sans jamais reculer, une vraie discontinuité (chargement,
  // recherche, arrêt...) doit au contraire s'appliquer immédiatement — voir
  // useInterpolatedPosition.
  const [lastCause, setLastCause] = useState<string>("sync");
  const handlePlaybackEvent = (evt: PlaybackEvent) => setLastCause(evt.cause);
  const { state, connected, sendCommand, displayOutputCable, displayOutputNetwork, cinemaLocked, cinemaState } =
    usePlaybackSocket(handlePlaybackEvent, undefined, channel);
  const livePosition = useInterpolatedPosition(state.position_seconds, state.state === "playing", lastCause);
  // Glissement en cours sur la barre de position du bloc cinéma (réf.
  // mission "contrôler le cours en mode cinéma").
  const [cinemaSeekDrag, setCinemaSeekDrag] = useState<number | null>(null);
  // Un rapport cinéma est considéré périmé après 8 s sans nouvelles (la page
  // /cinema rapporte toutes les 2 s) : l'appareil a été fermé ou a perdu le
  // réseau, on cesse d'afficher une lecture qui n'existe sans doute plus.
  // Fraîcheur mesurée à la RÉCEPTION locale (pas au timestamp serveur du
  // rapport, sujet au décalage d'horloge entre machines).
  const cinemaReceivedAtRef = useRef(0);
  // Play/pause optimiste (réf. "les boutons ne marchent pas à tous les
  // coups") : l'état affiché ne bougeait qu'au rapport suivant de la page
  // cinéma — le bouton semblait mort, l'admin re-cliquait et annulait sa
  // propre commande. On affiche l'état COMMANDÉ immédiatement, et le premier
  // rapport reçu ensuite (désormais quasi instantané côté cinéma) reprend la
  // main comme source de vérité.
  const [cinemaPendingPlaying, setCinemaPendingPlaying] = useState<boolean | null>(null);
  useEffect(() => {
    cinemaReceivedAtRef.current = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset volontaire à chaque rapport reçu (le rapport redevient la vérité)
    setCinemaPendingPlaying(null);
  }, [cinemaState]);
  // 250 ms (au lieu de 2 s) : cadence l'interpolation locale de la tête de
  // lecture ci-dessous — au tick 2 s, la barre avançait par sauts.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const cinemaLiveRaw =
    cinemaState && cinemaState.title && nowTick - cinemaReceivedAtRef.current < 8000 ? cinemaState : null;
  // Position interpolée localement entre deux rapports (même principe que le
  // compte à rebours kiosk) : position rapportée + temps écoulé depuis la
  // RÉCEPTION locale si la lecture est en cours. L'objet enrichi est aussi
  // celui transmis au mobile — mêmes corrections partout.
  const cinemaLive = cinemaLiveRaw
    ? {
        ...cinemaLiveRaw,
        playing: cinemaPendingPlaying ?? cinemaLiveRaw.playing,
        position_seconds: Math.min(
          cinemaLiveRaw.duration_seconds || Infinity,
          cinemaLiveRaw.position_seconds +
            (cinemaLiveRaw.playing ? Math.max(0, (nowTick - cinemaReceivedAtRef.current) / 1000) : 0),
        ),
      }
    : null;
  const handleCinemaPlayPause = () => {
    if (!cinemaLive) return;
    const next = !cinemaLive.playing;
    setCinemaPendingPlaying(next);
    sendCommand("cinema_command", { action: next ? "play" : "pause" });
  };
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  // Réf. correctif "fonctionnalité des playlists [audio] sur l'interface pc" :
  // le mode coach (donc les playlists audio) est réservé au canal câblé —
  // seule DashboardScreen("cable") en a besoin, mais l'état reste inconditionnel
  // ici (comme `backgrounds` ci-dessous) pour ne pas complexifier les hooks.
  const [audioPlaylists, setAudioPlaylists] = useState<AudioPlaylistSummary[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string>("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [selectedAudioPlaylistId, setSelectedAudioPlaylistId] = useState<string>("");
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const [volumeDragValue, setVolumeDragValue] = useState<number | null>(null);
  const [interrupted, setInterrupted] = useState<InterruptedState | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [upcoming, setUpcoming] = useState<OccurrenceSummary[]>([]);
  const [backgrounds, setBackgrounds] = useState<BackgroundSummary[]>([]);
  const [selectedBackgroundId, setSelectedBackgroundId] = useState<string>("");

  const isCable = channel === "cable";
  // Sortie active de CE canal uniquement : le verrou cinéma et le switch
  // n'observent jamais l'autre canal (zéro interférence).
  const displayOutput = isCable ? displayOutputCable : displayOutputNetwork;
  const channelCinema = displayOutput === "cinema";

  const fetchInterrupted = () => {
    fetch(getApiUrl(`/playback/interrupted?channel=${channel}`), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setInterrupted)
      .catch(() => setInterrupted(null));
  };

  useEffect(() => {
    // Bloc « Prochainement » : les 3 prochaines occurrences actives DU CANAL
    // (réf. UX3.4 + mission "un planning pour le câblé, un pour le réseau").
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    fetch(
      getApiUrl(
        `/schedule/occurrences?start=${now.toISOString()}&end=${horizon.toISOString()}&channel=${channel}`
      ),
      { cache: "no-store" }
    )
      .then((res) => (res.ok ? res.json() : []))
      .then((data: OccurrenceSummary[]) =>
        setUpcoming(data.filter((o) => o.override_action !== "cancelled").slice(0, 3))
      )
      .catch(() => setUpcoming([]));

    fetch(getApiUrl("/backgrounds"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setBackgrounds)
      .catch(() => setBackgrounds([]));

    fetch(getApiUrl("/videos?sort_by=imported_at&order=desc"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setVideos)
      .catch(() => setVideos([]));

    fetch(getApiUrl("/playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]));

    fetch(getApiUrl("/audio-playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setAudioPlaylists)
      .catch(() => setAudioPlaylists([]));

    // F5.3 : une programmation peut interrompre une lecture manuelle à tout
    // moment pendant que ce tableau de bord est ouvert — on vérifie donc
    // périodiquement plutôt qu'au seul chargement de la page.
    fetchInterrupted();
    const id = setInterval(fetchInterrupted, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchInterrupted stable (référence recréée mais comportement identique)
  }, [channel]);

  const handleResumeInterrupted = async () => {
    setIsResuming(true);
    try {
      const res = await fetch(getApiUrl(`/playback/interrupted/resume?channel=${channel}`), { method: "POST" });
      if (res.ok) {
        setInterrupted(null);
      }
    } finally {
      setIsResuming(false);
    }
  };

  const handleDismissInterrupted = async () => {
    await fetch(getApiUrl(`/playback/interrupted?channel=${channel}`), { method: "DELETE" });
    setInterrupted(null);
  };

  const isActive =
    state.current_video !== null || state.state === "playlist_waiting" || state.state === "background";
  const duration = state.current_video?.duration_seconds ?? 0;
  const displayPosition = seekDragValue ?? livePosition;
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

  const handleLaunchAudioPlaylist = () => {
    if (!selectedAudioPlaylistId) return;
    sendCommand("load_audio_playlist", { audio_playlist_id: Number(selectedAudioPlaylistId) });
  };

  const handlePlayPause = () => {
    sendCommand(state.state === "playing" ? "pause" : "play");
  };

  // Bascule kiosk/cinéma de CE canal : le retour visuel vient de l'évènement
  // display_output rediffusé par le backend — toutes les interfaces admin
  // ouvertes se mettent à jour en même temps.
  const handleSetDisplayOutput = (output: "kiosk" | "cinema") => {
    fetch(getApiUrl("/settings/display-output"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, output }),
    }).catch(() => {});
  };

  if (isMobile) {
    return (
      <MobileRemote
        state={state}
        livePosition={livePosition}
        connected={connected}
        sendCommand={sendCommand}
        videos={videos}
        playlists={playlists}
        backgrounds={backgrounds}
        getApiUrl={getApiUrl}
        displayOutputCable={displayOutputCable}
        displayOutputNetwork={displayOutputNetwork}
        cinemaLive={cinemaLive}
        onCinemaPlayPause={handleCinemaPlayPause}
        onSetDisplayOutput={(ch, output) => {
          fetch(getApiUrl("/settings/display-output"), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: ch, output }),
          }).catch(() => {});
        }}
        channel={channel}
      />
    );
  }

  return (
    <div className="dashboard-container">
      {interrupted && (
        <div className="interrupted-block">
          <div className="interrupted-text">
            {interrupted.cause === "coach_priority" ? (
              <>
                <span className="interrupted-label">{t("dashboard.interruptedCoachLabel")}</span>
                <span className="interrupted-title">{interrupted.title ?? t("dashboard.scheduledCourseFallback")}</span>
              </>
            ) : (
              <>
                <span className="interrupted-label">{t("dashboard.interruptedScheduleLabel")}</span>
                <span className="interrupted-title">
                  {interrupted.title ?? t("dashboard.courseFallback")} — {formatTime(interrupted.position_seconds)}
                </span>
              </>
            )}
          </div>
          <div className="interrupted-actions">
            <button className="btn btn-primary" onClick={handleResumeInterrupted} disabled={isResuming}>
              <Icon name="play_arrow" size={16} filled />
              {isResuming ? t("dashboard.resuming") : interrupted.cause === "coach_priority" ? t("dashboard.launchNow") : t("dashboard.resume")}
            </button>
            <button className="btn btn-secondary" onClick={handleDismissInterrupted} disabled={isResuming}>
              <Icon name="close" size={16} />
              {t("dashboard.dismiss")}
            </button>
          </div>
        </div>
      )}

      {/* Bascule kiosk/cinéma de CE canal (réf. mission "changer le mode
          entre Kiosk et Cinéma, tout indépendamment"). */}
      <div className="live-block channel-card">
        <div className="live-header">
          <h3>
            <Icon name={isCable ? "cable" : "wifi"} size={18} />
            {isCable ? t("dashboard.liveCableTitle") : t("dashboard.liveNetworkTitle")}
          </h3>
          <span className={`status-pill ${connected ? (channelCinema ? "neutral" : "ok") : "down"}`}>
            {!connected
              ? t("dashboard.disconnected")
              : channelCinema
              ? t("dashboard.channelCinemaActive")
              : STATE_LABELS[state.state] ?? state.state}
          </span>
        </div>
        <DisplayOutputSwitch
          displayOutput={displayOutput}
          onSetDisplayOutput={handleSetDisplayOutput}
          label={isCable ? t("dashboard.displayOutputCableLabel") : t("dashboard.displayOutputNetworkLabel")}
        />
      </div>

      <div className="live-block">
        <div className="live-header">
          <h3>{t("dashboard.liveTitle")}</h3>
          <p className="live-block-hint" style={{ margin: 0 }}>
            {isCable ? t("dashboard.liveChannelHintCable") : t("dashboard.liveChannelHintNetwork")}
          </p>
        </div>

        {channelCinema ? (
          // Mode cinéma : la lecture est LOCALE à l'écran libre-service, mais
          // la page /cinema du canal rapporte ce qu'elle joue et obéit aux
          // commandes admin (réf. mission "contrôler le cours en mode
          // cinéma") — play/pause/seek/stop relayés tels quels, sans passer
          // par l'état de lecture partagé du serveur.
          cinemaLive ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <div className="live-title">{cinemaLive.title}</div>
              </div>
              <div className="live-progress">
                <span className="live-time">{formatTime(cinemaSeekDrag ?? cinemaLive.position_seconds)}</span>
                <input
                  type="range"
                  min={0}
                  max={cinemaLive.duration_seconds || 0}
                  step={1}
                  value={cinemaSeekDrag ?? cinemaLive.position_seconds}
                  onChange={(e) => setCinemaSeekDrag(Number(e.target.value))}
                  onMouseUp={(e) => {
                    const value = Number((e.target as HTMLInputElement).value);
                    sendCommand("cinema_command", { action: "seek", position_seconds: value });
                    setCinemaSeekDrag(null);
                  }}
                  className="seek-slider"
                />
                <span className="live-time">{formatTime(cinemaLive.duration_seconds)}</span>
              </div>
              <div className="live-controls">
                <button
                  className="btn btn-secondary control-btn"
                  onClick={() => sendCommand("cinema_command", { action: "stop" })}
                  title={t("dashboard.cinemaStopHint")}
                >
                  <Icon name="stop" size={18} />
                  {t("dashboard.stop")}
                </button>
                <button
                  className="btn btn-primary control-btn control-btn-main"
                  onClick={handleCinemaPlayPause}
                >
                  <Icon name={cinemaLive.playing ? "pause" : "play_arrow"} size={20} filled />
                  {cinemaLive.playing ? t("dashboard.pause") : t("dashboard.play")}
                </button>
              </div>
            </>
          ) : (
            <div className="live-empty">{t("dashboard.cinemaNoPlayback")}</div>
          )
        ) : isActive ? (
          <>
            {/* Playlist Indicator & Quick Navigation */}
            {state.playlist_name && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "color-mix(in srgb, var(--accent-primary) 3%, transparent)", padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid color-mix(in srgb, var(--accent-primary) 15%, transparent)", marginBottom: "12px" }}>
                <span style={{ fontSize: "0.85rem", color: "var(--accent-primary)", fontWeight: 700 }}>
                  {t("dashboard.playlistLabel", {
                    name: state.playlist_name,
                    index: (state.playlist_index ?? 0) + 1,
                    total: state.playlist_items?.length ?? 0,
                  })}
                </span>
                {state.playlist_items && state.playlist_index !== null && (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      className="btn btn-secondary"
                      style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "4px" }}
                      onClick={() => sendCommand("previous_video")}
                      disabled={state.playlist_index === 0}
                      title={t("dashboard.previousCourse")}
                    >
                      <Icon name="skip_previous" size={16} />
                      {t("dashboard.previousShort")}
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "4px" }}
                      onClick={() => sendCommand("next_video")}
                      disabled={state.playlist_index === state.playlist_items.length - 1}
                      title={t("dashboard.nextCourse")}
                    >
                      {t("dashboard.nextShort")}
                      <Icon name="skip_next" size={16} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* "À suivre" persistant pendant la lecture normale d'une playlist
                (réf. audit plan-corrections-bugs, point 2b). */}
            {state.playlist_name && state.state !== "playlist_waiting" && nextPlaylistItem && (
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "12px" }}>
                {t("dashboard.nextCourseLabel", { title: nextPlaylistItem.title })}
              </div>
            )}

            {/* If in playlist wait transition, show dedicated overlay control */}
            {state.state === "playlist_waiting" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "center", justifyContent: "center", padding: "20px", background: "var(--bg-surface-hover)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)" }}>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
                  {t("dashboard.transitionRemaining")}
                </span>
                <span style={{ fontSize: "2.5rem", fontWeight: 900, color: "var(--accent-primary)", fontVariantNumeric: "tabular-nums" }}>
                  {Math.ceil(state.playlist_waiting_remaining ?? 0)} s
                </span>
                {nextPlaylistItem ? (
                  <span style={{ fontSize: "0.9rem", color: "var(--text-main)", fontWeight: 700, textAlign: "center" }}>
                    {t("dashboard.nextCourseLabel", { title: nextPlaylistItem.title })}
                  </span>
                ) : (
                  <span style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
                    {t("dashboard.playlistEnd")}
                  </span>
                )}
                <div style={{ display: "flex", gap: "10px", width: "100%", marginTop: "8px" }}>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, height: "40px", fontSize: "0.85rem" }}
                    onClick={() => sendCommand("skip_waiting")}
                  >
                    <Icon name="fast_forward" size={16} />
                    {t("dashboard.launchImmediately")}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ height: "40px", padding: "0 16px", fontSize: "0.85rem" }}
                    onClick={() => sendCommand("stop")}
                  >
                    <Icon name="stop" size={16} />
                    {t("dashboard.stop")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                  {state.current_video?.thumbnail_url && (
                    <img
                      src={getApiUrl(`/thumbnails/${state.current_video.thumbnail_url}`)}
                      alt=""
                      style={{ width: "88px", height: "50px", objectFit: "cover", borderRadius: "var(--radius-sm)", flexShrink: 0, background: "#000" }}
                    />
                  )}
                  {/* Repli sur le titre du fond animé : state.current_video
                      est null en mode "background", sinon le titre restait vide. */}
                  <div className="live-title">
                    {state.current_video?.title || (state.state === "background" ? state.current_background?.title : "")}
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
                    disabled={state.state === "background"}
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
                    <Icon name="stop" size={18} />
                    {t("dashboard.stop")}
                  </button>
                  <button
                    className="btn btn-primary control-btn control-btn-main"
                    onClick={handlePlayPause}
                    disabled={state.state === "background"}
                  >
                    <Icon name={state.state === "playing" ? "pause" : "play_arrow"} size={20} filled />
                    {state.state === "playing" ? t("dashboard.pause") : t("dashboard.play")}
                  </button>
                  <div className="speed-group">
                    {SPEED_OPTIONS.map((s) => (
                      <button
                        key={s}
                        className={`speed-btn ${state.speed === s ? "active" : ""}`}
                        onClick={() => sendCommand("speed", { speed: s })}
                        disabled={state.state === "background"}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>

                <div className="volume-row">
                  <span>{t("dashboard.volume")}</span>
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
            {t("dashboard.emptyLive")}
          </div>
        )}
      </div>

      <div className="live-block">
        <div className="live-header">
          <h3>{t("dashboard.upcomingTitle")}</h3>
          <a href={`/schedule/?channel=${channel}`} className="status-pill" style={{ textDecoration: "none" }}>
            {t("dashboard.viewSchedule")}
          </a>
        </div>
        {upcoming.length === 0 ? (
          <p className="live-empty">{t("dashboard.noUpcoming")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {upcoming.map((o, idx) => (
              <div
                key={`${o.schedule_id}-${idx}`}
                className="olc-card-hover"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  background: "var(--bg-surface-elevated)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>{o.title ?? t("dashboard.courseFallback")}</span>
                <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums" }}>
                  {new Date(o.run_at).toLocaleString(language === "fr" ? "fr-FR" : "en-US", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Raccourcis fond animé / mode coach : pilotent tous deux l'écran
          kiosk, sans objet en mode cinéma (l'écran affiche le libre-service)
          — masqués plutôt que juste désactivés (réf. retour utilisateur
          "masquer les fonctionnalités non disponibles en mode cinéma"). */}
      {!channelCinema && (
        <div className="live-block">
          <h3>{t("dashboard.shortcutsTitle")}</h3>
          <div className="launch-row" style={{ flexWrap: "wrap" }}>
            <select className="filter-select" style={{ flex: 1, minWidth: "180px" }} value={selectedBackgroundId} onChange={(e) => setSelectedBackgroundId(e.target.value)}>
              <option value="">{t("dashboard.chooseBackground")}</option>
              {backgrounds.map((bg) => (
                <option key={bg.id} value={bg.id}>{bg.title}</option>
              ))}
            </select>
            <button
              className="btn btn-secondary"
              disabled={!selectedBackgroundId}
              onClick={() => selectedBackgroundId && sendCommand("load_background", { background_id: Number(selectedBackgroundId) })}
            >
              <Icon name="gradient" size={16} />
              {t("dashboard.launchBackground")}
            </button>
            {/* Mode coach : réservé au canal câblé (le coach anime la salle
                physique) — le raccourci n'apparaît pas sur le tableau réseau. */}
            {isCable && (
              // Link plutôt qu'un <a> classique (réf. correctif "quitte le
              // plein écran sur téléphone") : un <a href> natif recharge
              // toute la page et coupe la Fullscreen API du navigateur.
              <Link href="/coach/" className="btn btn-primary" style={{ textDecoration: "none", display: "flex", alignItems: "center" }}>
                <Icon name="mic" size={16} />
                {t("dashboard.switchToCoach")}
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Lancement de cours/playlist : action kiosk uniquement, sans objet
          en mode cinéma (les adhérents choisissent eux-mêmes) — masqué. */}
      {!channelCinema && (
        <>
          <div className="launch-block">
            <h3>
              <Icon name={isCable ? "cable" : "wifi"} size={18} />
              {isCable ? t("dashboard.launchCourseCableTitle") : t("dashboard.launchCourseNetworkTitle")}
            </h3>
            <p className="launch-block-hint">
              {isCable ? t("dashboard.launchCourseCableHint") : t("dashboard.launchCourseNetworkHint")}
            </p>
            <div className="launch-row">
              <select
                className="filter-select"
                style={{ flex: 1 }}
                value={selectedVideoId}
                onChange={(e) => setSelectedVideoId(e.target.value)}
              >
                <option value="">{t("dashboard.chooseVideo")}</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title} {v.program ? `— ${v.program}` : ""} {v.release ? `#${v.release}` : ""}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary"
                onClick={handleLaunch}
                disabled={!selectedVideoId || cinemaLocked}
                title={cinemaLocked ? t("dashboard.channelCinemaLockedHint") : undefined}
              >
                <Icon name="play_arrow" size={16} filled />
                {t("dashboard.launch")}
              </button>
            </div>
            {videos.length === 0 && (
              <p className="live-empty" style={{ marginTop: "12px" }}>{t("dashboard.noVideos")}</p>
            )}
            {cinemaLocked && (
              <p className="live-empty" style={{ marginTop: "12px", color: "var(--accent-primary)" }}>
                {t("dashboard.channelCinemaLockedHint")}
              </p>
            )}
          </div>

          <div className="launch-block">
            <h3>{t("dashboard.launchPlaylistTitle")}</h3>
            <div className="launch-row">
              <select
                className="filter-select"
                style={{ flex: 1 }}
                value={selectedPlaylistId}
                onChange={(e) => setSelectedPlaylistId(e.target.value)}
              >
                <option value="">{t("dashboard.choosePlaylist")}</option>
                {playlists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.item_count} cours — {formatDuration(p.total_duration_seconds)})
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary"
                onClick={handleLaunchPlaylist}
                disabled={!selectedPlaylistId || cinemaLocked}
                title={cinemaLocked ? t("dashboard.channelCinemaLockedHint") : undefined}
              >
                <Icon name="playlist_play" size={16} />
                {t("dashboard.launch")}
              </button>
            </div>
            {playlists.length === 0 && (
              <p className="live-empty" style={{ marginTop: "12px" }}>
                {t("dashboard.noPlaylists")}
              </p>
            )}
          </div>

          {/* Réf. correctif "fonctionnalité des playlists [audio] sur
              l'interface pc" : la page permettait déjà de créer/éditer des
              playlists audio (/audio-playlists) et de les lancer depuis le
              mode coach (/coach) ou le téléphone, mais aucun raccourci de
              lancement direct n'existait ici, contrairement aux playlists
              vidéo juste au-dessus. Réservé au câblé, comme "Passer en mode
              coach" ci-dessus : le mode audio coach n'existe que sur cet
              écran. */}
          {isCable && (
            <div className="launch-block">
              <h3>{t("dashboard.launchAudioPlaylistTitle")}</h3>
              <div className="launch-row">
                <select
                  className="filter-select"
                  style={{ flex: 1 }}
                  value={selectedAudioPlaylistId}
                  onChange={(e) => setSelectedAudioPlaylistId(e.target.value)}
                >
                  <option value="">{t("dashboard.chooseAudioPlaylist")}</option>
                  {audioPlaylists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.item_count} piste(s) — {formatDuration(p.total_duration_seconds)})
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-primary"
                  onClick={handleLaunchAudioPlaylist}
                  disabled={!selectedAudioPlaylistId}
                >
                  <Icon name="queue_music" size={16} />
                  {t("dashboard.launch")}
                </button>
              </div>
              {audioPlaylists.length === 0 && (
                <p className="live-empty" style={{ marginTop: "12px" }}>
                  {t("dashboard.noAudioPlaylists")}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
