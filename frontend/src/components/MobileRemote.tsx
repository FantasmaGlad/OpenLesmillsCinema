"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CinemaRemoteState, PlaybackState } from "@/lib/usePlaybackSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";
import DisplayOutputSwitch from "@/components/DisplayOutputSwitch";
import Icon from "@/components/Icon";

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
  /** Position lissée (réf. retour utilisateur 2026-07-21 "la tête de lecture
   * tremblote") calculée par le parent — voir useInterpolatedPosition. */
  livePosition: number;
  connected: boolean;
  sendCommand: (command: string, params?: Record<string, unknown>) => void;
  videos: VideoSummary[];
  playlists: PlaylistSummary[];
  backgrounds: BackgroundSummary[];
  getApiUrl: (path: string) => string;
  displayOutputCable: "kiosk" | "cinema" | null;
  displayOutputNetwork: "kiosk" | "cinema" | null;
  /** Lecture en cours sur l'écran cinéma libre-service DE CE CANAL (réf.
   * retour utilisateur "afficher sur téléphone le cours en train d'être
   * joué, en kiosk ou en cinéma") — même source que le bloc "En direct" du
   * PC admin (`cinemaLive` de `DashboardScreen`), null si rien ne joue ou si
   * le dernier rapport date de plus de 8s (appareil cinéma fermé/déconnecté). */
  cinemaLive: CinemaRemoteState | null;
  /** Play/pause du cours cinéma avec état optimiste (géré par le parent, qui
   * détient l'état commandé-en-attente — réf. "les boutons ne marchent pas à
   * tous les coups") : `cinemaLive.playing` reflète déjà l'état COMMANDÉ. */
  onCinemaPlayPause: () => void;
  onSetDisplayOutput: (channel: "cable" | "network", output: "kiosk" | "cinema") => void;
  /** Canal contrôlé par cette instance (réf. mission "Tableau de bord Câblé/
   * Réseau" : deux écrans dédiés, chacun ne montre QUE le switch kiosk/cinéma
   * de son propre canal, comme sur le PC admin). Omis = comportement
   * historique (les deux canaux affichés ensemble), conservé pour "/". */
  channel?: "cable" | "network";
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
  livePosition,
  connected,
  sendCommand,
  videos,
  playlists,
  backgrounds,
  getApiUrl,
  displayOutputCable,
  displayOutputNetwork,
  cinemaLive,
  onCinemaPlayPause,
  onSetDisplayOutput,
  channel,
}: MobileRemoteProps) {
  const { t } = useAppSettings();
  const [sheet, setSheet] = useState<"none" | "launch">("none");
  const [launchSearch, setLaunchSearch] = useState("");
  const [holdingStop, setHoldingStop] = useState(false);
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const [cinemaSeekDrag, setCinemaSeekDrag] = useState<number | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Verrou cinéma PAR CANAL (réf. mission "Tableau de bord Câblé / Réseau") :
  // seul l'état du canal piloté par cette télécommande compte. Les actions
  // kiosk (lancer un cours/fond/playlist) n'ont pas de sens sur un canal en
  // libre-service — masquées plutôt que juste désactivées (réf. retour
  // utilisateur "masquer les fonctionnalités non disponibles en mode
  // cinéma"), remplacées par les infos/contrôles de l'écran cinéma.
  const channelCinema = (channel === "network" ? displayOutputNetwork : displayOutputCable) === "cinema";

  // Si le canal bascule en cinéma pendant que la feuille de lancement est
  // ouverte, elle n'a plus lieu d'être (plus de bouton pour l'ouvrir non
  // plus, mais l'état pourrait déjà être ouvert au moment de la bascule).
  useEffect(() => {
    if (channelCinema) setSheet("none");
  }, [channelCinema]);

  const isActive = state.current_video !== null || state.state === "playlist_waiting" || state.state === "background";
  const duration = state.current_video?.duration_seconds ?? 0;
  const displayPosition = seekDragValue ?? livePosition;

  // Nom de playlist + "à suivre" (réf. audit plan-corrections-bugs, point
  // 2b) : absent jusqu'ici du mobile, contrairement au PC.
  const nextPlaylistItem =
    state.playlist_items && state.playlist_index !== null && state.playlist_index !== undefined
      ? state.playlist_items[state.playlist_index + 1]
      : null;

  // Capture du pointeur (réf. correctif "le bouton Stop ne marche pas") :
  // sans setPointerCapture, un tremblement de doigt naturel pendant l'appui
  // long (650ms) fait glisser le point de contact hors des limites du
  // bouton, ce qui déclenche `pointerleave` et annule le hold avant son
  // terme — sur un écran tactile réel, quasiment IMPOSSIBLE à mener à bien.
  // La capture fixe tous les évènements suivants (up/cancel) sur ce bouton
  // quel que soit le déplacement du doigt, comme le pattern standard pour
  // les contrôles "maintenir pour confirmer".
  const startStopHold = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
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
      {connected && (
        <div className="mobile-remote-output olc-anim-in">
          {(!channel || channel === "cable") && (
            <DisplayOutputSwitch
              displayOutput={displayOutputCable}
              onSetDisplayOutput={(output) => onSetDisplayOutput("cable", output)}
              label={t("dashboard.displayOutputCableLabel")}
            />
          )}
          {(!channel || channel === "network") && (
            <DisplayOutputSwitch
              displayOutput={displayOutputNetwork}
              onSetDisplayOutput={(output) => onSetDisplayOutput("network", output)}
              label={t("dashboard.displayOutputNetworkLabel")}
            />
          )}
        </div>
      )}
      {!connected ? (
        <div className="mobile-remote-empty">{t("mobileRemote.connectingHint")}</div>
      ) : channelCinema ? (
        // Mode cinéma : lecture LOCALE à l'écran libre-service, rapportée par
        // la page /cinema du canal (même source que le bloc "En direct" du PC
        // admin) — pas de lancement possible depuis ici, juste lire/piloter
        // ce qui joue déjà (réf. "afficher sur téléphone le cours en train
        // d'être joué, en kiosk ou en cinéma").
        cinemaLive ? (
          // Structure en COLONNE, chaque bloc frère du suivant (réf. correctif
          // "l'interface se marche sur elle-même" : la première version
          // imbriquait la barre de progression et les boutons DANS
          // .mobile-remote-now, un conteneur flex HORIZONTAL prévu pour
          // vignette + titre — tout se retrouvait écrasé sur une seule
          // ligne). Même squelette que la vue kiosk ci-dessous.
          <>
            <div className="mobile-remote-now olc-anim-in">
              <span className="mobile-remote-title">{cinemaLive.title}</span>
            </div>

            <div className="mobile-remote-progress">
              <input
                type="range"
                min={0}
                max={cinemaLive.duration_seconds || 0}
                step={1}
                value={cinemaSeekDrag ?? cinemaLive.position_seconds}
                onChange={(e) => setCinemaSeekDrag(Number(e.target.value))}
                onMouseUp={(e) => {
                  sendCommand("cinema_command", { action: "seek", position_seconds: Number((e.target as HTMLInputElement).value) });
                  setCinemaSeekDrag(null);
                }}
                onTouchEnd={(e) => {
                  sendCommand("cinema_command", { action: "seek", position_seconds: Number((e.target as HTMLInputElement).value) });
                  setCinemaSeekDrag(null);
                }}
                className="seek-slider mobile-remote-seek"
              />
              <div className="mobile-remote-time-row">
                <span>{formatTime(cinemaSeekDrag ?? cinemaLive.position_seconds)}</span>
                <span>{formatTime(cinemaLive.duration_seconds)}</span>
              </div>
            </div>

            <div className="mobile-remote-controls" style={{ marginTop: 0 }}>
              <button
                className="coach-btn coach-btn-main olc-press"
                style={{ background: "var(--accent-primary)" }}
                onClick={onCinemaPlayPause}
              >
                <Icon name={cinemaLive.playing ? "pause" : "play_arrow"} size={38} filled />
              </button>
            </div>

            <button
              className="coach-btn coach-btn-wide mobile-remote-stop olc-press"
              onClick={() => sendCommand("cinema_command", { action: "stop" })}
              title={t("dashboard.cinemaStopHint")}
            >
              <Icon name="stop_circle" size={18} />
              {t("dashboard.stop")}
            </button>
          </>
        ) : (
          <div className="mobile-remote-empty olc-anim-in">
            <p>{t("dashboard.cinemaNoPlayback")}</p>
          </div>
        )
      ) : !isActive ? (
        <div className="mobile-remote-empty olc-anim-in">
          <p>{t("mobileRemote.noCourseHint")}</p>
          <button className="btn btn-primary" style={{ height: "56px", marginTop: "16px" }} onClick={() => setSheet("launch")}>
            <Icon name="play_circle" size={20} />
            {t("mobileRemote.launchCourse")}
          </button>
        </div>
      ) : (
        <>
          {state.playlist_name && (
            <div className="mobile-remote-playlist-badge olc-anim-in">
              <span className="mobile-remote-playlist-name">{state.playlist_name}</span>
              {nextPlaylistItem && state.state !== "playlist_waiting" && (
                <span className="mobile-remote-playlist-next">
                  {t("kiosk.nextCourseLabel")} {nextPlaylistItem.title}
                </span>
              )}
            </div>
          )}
          <div className="mobile-remote-now olc-anim-in">
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

      {/* Contrôles kiosk (précédent/lecture/suivant, stop, volume) : sans
          objet en mode cinéma, l'écran cinéma a ses propres contrôles
          affichés plus haut — masqués plutôt que désactivés (réf. retour
          utilisateur "masquer les fonctionnalités non disponibles en mode
          cinéma"). */}
      {!channelCinema && (
        <>
          <div className="mobile-remote-controls">
            <button
              className="coach-btn olc-press"
              onClick={() => sendCommand("previous_video")}
              disabled={state.playlist_index === null || state.playlist_index === 0}
            >
              <Icon name="skip_previous" size={28} filled />
            </button>
            <button
              className="coach-btn coach-btn-main olc-press"
              style={{ background: "var(--accent-primary)" }}
              onClick={() => sendCommand(state.state === "playing" ? "pause" : "play")}
              disabled={!isActive || state.state === "background"}
            >
              <Icon name={state.state === "playing" ? "pause" : "play_arrow"} size={38} filled />
            </button>
            <button
              className="coach-btn olc-press"
              onClick={() => sendCommand("next_video")}
              disabled={state.playlist_items === null || state.playlist_index === (state.playlist_items?.length ?? 1) - 1}
            >
              <Icon name="skip_next" size={28} filled />
            </button>
          </div>

          {/* Stop en appui long, sans confirmation (réf. UX4.2/UX5.2) */}
          <button
            className={`coach-btn coach-btn-wide mobile-remote-stop olc-press ${holdingStop ? "holding" : ""}`}
            style={{ touchAction: "none" }}
            disabled={!isActive}
            title={!isActive ? t("mobileRemote.noCourseHint") : undefined}
            onPointerDown={startStopHold}
            onPointerUp={cancelStopHold}
            onPointerCancel={cancelStopHold}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="stop_circle" size={18} />
            {holdingStop ? t("mobileRemote.holdToStop") : t("mobileRemote.stopHoldLabel")}
          </button>

          <div className="coach-volume-row" style={{ maxWidth: "none" }}>
            <button className="coach-btn coach-btn-square olc-press" onClick={() => sendCommand("volume", { volume: Math.max(0, state.volume - 10) })}>
              <Icon name="remove" size={20} />
            </button>
            <span className="coach-volume-value">
              <Icon name="volume_up" size={18} style={{ marginRight: "6px" }} />
              {state.volume}%
            </span>
            <button className="coach-btn coach-btn-square olc-press" onClick={() => sendCommand("volume", { volume: Math.min(100, state.volume + 10) })}>
              <Icon name="add" size={20} />
            </button>
          </div>

          <div className="mobile-remote-quick-row">
            <button className="btn btn-secondary mobile-remote-quick-btn" onClick={() => setSheet("launch")}>
              <Icon name="play_circle" size={18} />
              {t("mobileRemote.launchQuickBtn")}
            </button>
            {/* Mode coach réservé au canal câblé (réf. mission "Tableau de bord
                Câblé/Réseau") : la sortie réseau ne peut jamais s'en servir, le
                bouton n'apparaît donc pas sur la vue dédiée au canal réseau. */}
            {channel !== "network" && (
              // Link plutôt qu'un <a> classique (réf. correctif "quitte le
              // plein écran sur téléphone") : un <a href> natif recharge
              // toute la page et coupe la Fullscreen API du navigateur.
              <Link href="/coach/" className="btn btn-primary mobile-remote-quick-btn" style={{ textDecoration: "none" }}>
                <Icon name="mic" size={18} />
                {t("mobileRemote.coachQuickBtn")}
              </Link>
            )}
          </div>

          {/* Planning DE CE CANAL (réf. mission "Double Planning" — mobile
              n'avait jusqu'ici aucun moyen d'atteindre /schedule, seul le PC
              admin exposait ce lien). */}
          <a
            href={`/schedule/?channel=${channel ?? "cable"}`}
            className="btn btn-secondary mobile-remote-quick-btn"
            style={{ textDecoration: "none", width: "100%", marginTop: "10px" }}
          >
            <Icon name="calendar_month" size={18} />
            {t("dashboard.viewSchedule")}
          </a>
        </>
      )}

      {sheet !== "none" && (
        <div className="coach-sheet-overlay" onClick={() => setSheet("none")}>
          <div className="coach-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="coach-sheet-handle" />
            {(
              <>
                <h3 style={{ margin: "0 0 12px" }}>{t("mobileRemote.launchTitle")}</h3>
                <input
                  type="text"
                  className="search-input"
                  style={{ width: "100%", marginBottom: "12px" }}
                  placeholder={t("mobileRemote.searchPlaceholder")}
                  value={launchSearch}
                  onChange={(e) => setLaunchSearch(e.target.value)}
                />
                <div className="coach-sheet-list">
                  {filteredPlaylists.map((p) => (
                    <button key={`pl-${p.id}`} className="coach-sheet-track olc-press" onClick={() => { sendCommand("load_playlist", { playlist_id: p.id }); setSheet("none"); }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}><Icon name="playlist_play" size={18} />{p.name}</span>
                      <span style={{ color: "var(--text-muted)" }}>{t("mobileRemote.coursesCount", { count: p.item_count })}</span>
                    </button>
                  ))}
                  {filteredBackgrounds.map((b) => (
                    <button key={`bg-${b.id}`} className="coach-sheet-track olc-press" onClick={() => { sendCommand("load_background", { background_id: b.id }); setSheet("none"); }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}><Icon name="gradient" size={18} />{b.title}</span>
                      <span style={{ color: "var(--text-muted)" }}>{t("mobileRemote.backgroundLabel")}</span>
                    </button>
                  ))}
                  {filteredVideos.map((v) => (
                    <button key={`v-${v.id}`} className="coach-sheet-track olc-press" onClick={() => { sendCommand("load", { video_id: v.id }); setSheet("none"); }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}><Icon name="movie" size={18} />{v.title}</span>
                      <span style={{ color: "var(--text-muted)" }}>{v.program || t("mobileRemote.otherProgram")}</span>
                    </button>
                  ))}
                  {filteredVideos.length === 0 && filteredPlaylists.length === 0 && filteredBackgrounds.length === 0 && (
                    <p className="live-empty">{t("mobileRemote.noResults")}</p>
                  )}
                </div>
                <button className="btn btn-secondary" style={{ height: "48px", marginTop: "12px" }} onClick={() => setSheet("none")}>
                  {t("mobileRemote.close")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
