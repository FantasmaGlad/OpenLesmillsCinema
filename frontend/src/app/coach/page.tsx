"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePlaybackSocket, PlaybackState } from "@/lib/usePlaybackSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useThemeAccentForeground } from "@/lib/useThemeAccentForeground";
import { navLinks, footerNavLinks } from "@/lib/navLinks";
import Icon from "@/components/Icon";

interface AudioCourseSummary {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  track_count: number;
  total_duration_seconds: number;
}

interface AudioPlaylistSummary {
  id: number;
  name: string;
  item_count: number;
  total_duration_seconds: number;
}

interface BackgroundSummary {
  id: number;
  title: string;
  is_image: boolean;
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

export default function CoachModePage() {
  const { t } = useAppSettings();
  const CHAIN_MODE_LABELS: Record<string, string> = {
    auto: t("coach.chainModeLabels.auto"),
    timer: t("coach.chainModeLabels.timer"),
    manual: t("coach.chainModeLabels.manual"),
  };
  // hasSynced (correctif "le bouton stop du mode coach ne marche pas") :
  // marque la réception du tout premier évènement websocket réel. Avant ce
  // correctif, `state` retombait sur `snapshotState` (pré-hydratation REST
  // figée au montage) dès que `wsState.current_audio_course` redevenait null
  // — ce qui est justement le cas normal après un Stop — donc l'écran
  // restait bloqué sur le cours coach obsolète au lieu de revenir au picker.
  const [hasSynced, setHasSynced] = useState(false);
  const { state: wsState, connected, sendCommand } = usePlaybackSocket(() => setHasSynced(true));
  const [courses, setCourses] = useState<AudioCourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Playlists audio ("éditions mixées", réf. mission "création de playlists
  // spéciales juste avec les cours audios") : onglet séparé du picker de
  // cours isolés, plutôt qu'une longue liste mélangée.
  const [audioPlaylists, setAudioPlaylists] = useState<AudioPlaylistSummary[]>([]);
  const [pickerTab, setPickerTab] = useState<"courses" | "playlists">("courses");
  const [showTrackList, setShowTrackList] = useState(false);
  // Sélecteur de fond d'écran (réf. mission "afficher un fond, figé ou animé,
  // directement depuis le mode coach") : liste les fonds importés dans
  // l'admin, appliqués en direct sur l'écran câblé via audio_set_background.
  const [showBackgrounds, setShowBackgrounds] = useState(false);
  const [backgrounds, setBackgrounds] = useState<BackgroundSummary[]>([]);
  const [search, setSearch] = useState("");
  // Accès aux autres fonctions de l'admin sans quitter le mode coach (réf.
  // retour utilisateur "aucun bouton pour naviguer hors du mode coach sur le
  // téléphone") : ClientLayout masque sidebar/tiroir sur cette route en
  // plein écran, ce menu local est donc la seule porte de sortie vers les
  // autres pages — la navigation elle-même reste non destructive, le cours
  // coach continue de tourner côté serveur qu'on y revienne ou non.
  const [showNav, setShowNav] = useState(false);
  // État de snapshot HTTP (réf. Bug 4 / B4) : pré-hydrate l'interface avant
  // que le premier message WebSocket ne soit reçu. Sans cela, tous les boutons
  // de navigation de piste audio sont disabled car DEFAULT_STATE a
  // audio_tracks=null. Le WS prend le relais dès sa première notification.
  const [snapshotState, setSnapshotState] = useState<PlaybackState | null>(null);
  const state = hasSynced ? wsState : (snapshotState ?? wsState);

  useEffect(() => {
    fetch(getApiUrl("/playback/state"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PlaybackState | null) => {
        if (data && data.state) setSnapshotState(data);
      })
      .catch(() => { /* échec silencieux, le WS prendra le relais */ });
  }, []);

  useEffect(() => {
    fetch(getApiUrl("/audio"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setCourses)
      .catch(() => setCourses([]))
      .finally(() => setLoading(false));

    fetch(getApiUrl("/backgrounds"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setBackgrounds)
      .catch(() => setBackgrounds([]));

    fetch(getApiUrl("/audio-playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setAudioPlaylists)
      .catch(() => setAudioPlaylists([]));
  }, []);

  const isCoachMode = state.state === "coach_mode";
  const course = state.current_audio_course;
  // Couleur du thème plutôt que du programme du cours (réf. correctif
  // "couleurs hardcodées associées à un cours" — le thème prime désormais).
  const accent = "var(--accent-primary)";
  const accentFg = useThemeAccentForeground();
  const tracks = state.audio_tracks || [];
  const trackIndex = state.audio_track_index ?? 0;
  const currentTrack = tracks[trackIndex] || null;
  const remaining = currentTrack?.duration_seconds
    ? Math.max(0, currentTrack.duration_seconds - state.audio_position_seconds)
    : null;
  const filteredCourses = courses.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));

  const filteredAudioPlaylists = audioPlaylists.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  // Tap 2/2 : le choix du cours suffit à le lancer (réf. F10.4/UX4.9).
  const launchCourse = (courseId: number) => {
    sendCommand("load_audio_course", { audio_course_id: courseId });
  };

  // Idem pour une playlist audio ("édition mixée", réf. mission "playlists
  // spéciales... musiques de plusieurs RPM différents") : traitée côté
  // serveur comme un cours virtuel dont les pistes viennent de plusieurs
  // cours — même flux de lecture qu'un cours normal, pas de notion de
  // "cours suivant" à enchaîner.
  const launchAudioPlaylist = (playlistId: number) => {
    sendCommand("load_audio_playlist", { audio_playlist_id: playlistId });
  };

  const navSheet = showNav && (
    <div className="coach-sheet-overlay" onClick={() => setShowNav(false)}>
      <div className="coach-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="coach-sheet-handle" />
        <h3 style={{ margin: "0 0 12px" }}>{t("coach.otherFunctions")}</h3>
        <div className="coach-sheet-list">
          {[...navLinks, ...footerNavLinks].map((link) => (
            <Link key={link.href} href={link.href} className="nav-link" onClick={() => setShowNav(false)}>
              <Icon name={link.iconName} size={20} />
              <span>{t(link.labelKey)}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );

  if (!isCoachMode) {
    return (
      <div className="coach-screen coach-picker-screen">
        <div className="coach-picker-topbar">
          {/* Link (navigation cliente) plutôt qu'un <a> classique (réf.
              correctif "quitte le plein écran sur téléphone") : un <a href>
              natif force un rechargement complet de la page, ce qui coupe la
              Fullscreen API du navigateur en plus de perdre l'état React. */}
          <Link href="/" className="coach-icon-btn olc-press" title={t("coach.backToDashboard")}>
            <Icon name="arrow_back" size={20} />
          </Link>
          <button className="coach-icon-btn olc-press" onClick={() => setShowNav(true)} title={t("coach.otherFunctions")}>
            <Icon name="menu" size={20} />
          </button>
        </div>
        <div className="coach-picker-header">
          <h1 className="coach-picker-title">{t("coach.title")}</h1>
          <p className="coach-picker-subtitle">
            {connected ? t("coach.chooseCourseHint") : t("coach.connectingHint")}
          </p>
          <input
            type="text"
            className="search-input coach-picker-search"
            placeholder={t("coach.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {/* Onglet Cours isolés / Playlists audio (réf. mission "éditions
              mixées") : deux listes distinctes plutôt qu'une seule mélangée. */}
          <div className="coach-picker-tabs">
            <button
              type="button"
              className={`speed-btn ${pickerTab === "courses" ? "active" : ""}`}
              onClick={() => setPickerTab("courses")}
            >
              {t("coach.coursesTab")}
            </button>
            <button
              type="button"
              className={`speed-btn ${pickerTab === "playlists" ? "active" : ""}`}
              onClick={() => setPickerTab("playlists")}
            >
              {t("coach.playlistsTab")}
            </button>
          </div>
        </div>
        <div className="coach-picker-list">
          {pickerTab === "courses" ? (
            loading ? (
              <p className="live-empty">{t("coach.loadingCourses")}</p>
            ) : filteredCourses.length === 0 ? (
              <p className="live-empty">{t("coach.noCoursesAvailable")}</p>
            ) : (
              filteredCourses.map((c, i) => (
                <button
                  key={c.id}
                  className="coach-course-item olc-press olc-card-hover olc-anim-in"
                  style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                  onClick={() => launchCourse(c.id)}
                >
                  <span className="coach-course-item-accent" style={{ background: "var(--accent-primary)" }} />
                  <span className="coach-course-item-body">
                    <span className="coach-course-item-title">{c.title}</span>
                    <span className="coach-course-item-meta">
                      {c.program || t("coach.otherProgram")} · {t("coach.tracksCount", { count: c.track_count })}
                    </span>
                  </span>
                  <Icon name="play_circle" size={22} />
                </button>
              ))
            )
          ) : filteredAudioPlaylists.length === 0 ? (
            <p className="live-empty">{t("coach.noPlaylistsAvailable")}</p>
          ) : (
            filteredAudioPlaylists.map((p, i) => (
              <button
                key={p.id}
                className="coach-course-item olc-press olc-card-hover olc-anim-in"
                style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                onClick={() => launchAudioPlaylist(p.id)}
              >
                <span className="coach-course-item-accent" style={{ background: "var(--accent-primary)" }} />
                <span className="coach-course-item-body">
                  <span className="coach-course-item-title">{p.name}</span>
                  <span className="coach-course-item-meta">
                    {t("coach.tracksInPlaylist", { count: p.item_count })}
                  </span>
                </span>
                <Icon name="play_circle" size={22} />
              </button>
            ))
          )}
        </div>
        {navSheet}
      </div>
    );
  }

  return (
    <div className="coach-screen coach-live-screen" style={{ borderTopColor: accent }}>
      <div className="coach-live-header">
        {/* Retour non destructif (réf. correctif "le cours coach s'arrête si
            on quitte la page par mégarde") : navigue vers le tableau de bord
            SANS jamais arrêter le cours — le mode coach continue de tourner
            côté serveur, on peut revenir dessus à tout moment (cet écran
            réaffiche automatiquement l'état live dès qu'il est monté). Avant
            ce correctif, seul un bouton "X" ARRÊTANT le cours occupait cette
            position en haut à droite — l'endroit naturel où on tape pour
            "sortir", d'où l'arrêt accidentel signalé.
            Link plutôt qu'un <a> classique (réf. correctif "quitte le plein
            écran sur téléphone") : un rechargement complet couperait la
            Fullscreen API en plus de l'état React. */}
        <Link href="/" className="coach-icon-btn olc-press" title={t("coach.backToDashboard")}>
          <Icon name="arrow_back" size={20} />
        </Link>
        <span className="coach-live-course-title" style={{ color: accent }}>
          {course?.title}
        </span>
        {/* Menu d'accès aux autres fonctions (réf. correctif "aucun bouton
            pour naviguer hors du mode coach sur le téléphone") : remplace
            l'ancien espaceur muet — même non-destructivité que le retour à
            gauche, le cours coach continue de tourner côté serveur. */}
        <button className="coach-icon-btn olc-press" onClick={() => setShowNav(true)} title={t("coach.otherFunctions")}>
          <Icon name="menu" size={20} />
        </button>
      </div>

      <div className="coach-live-track-block olc-anim-in" key={currentTrack?.id}>
        <span className="coach-live-track-label">
          {currentTrack ? t("coach.trackLabel", { index: trackIndex + 1, total: tracks.length }) : t("coach.noTrack")}
        </span>
        <span className="coach-live-track-title">{currentTrack?.title}</span>
        <span className="coach-live-track-time">- {formatTime(remaining)}</span>
      </div>

      <div className="coach-controls-grid">
        <button className="coach-btn olc-press" onClick={() => sendCommand("audio_previous_track")} disabled={trackIndex <= 0}>
          <Icon name="skip_previous" size={28} filled />
        </button>
        <button
          className="coach-btn coach-btn-main olc-press"
          style={{ background: accent, color: accentFg }}
          onClick={() => sendCommand(state.audio_playing ? "pause" : "play")}
        >
          <Icon name={state.audio_playing ? "pause" : "play_arrow"} size={36} color={accentFg} filled />
        </button>
        <button
          className="coach-btn olc-press"
          onClick={() => sendCommand("audio_next_track")}
          disabled={trackIndex >= tracks.length - 1}
        >
          <Icon name="skip_next" size={28} filled />
        </button>
      </div>

      <button className="coach-btn coach-btn-wide olc-press" onClick={() => sendCommand("audio_restart_track")}>
        <Icon name="restart_alt" size={18} />
        {t("coach.restartTrack")}
      </button>

      <div className="coach-volume-row">
        <button className="coach-btn coach-btn-square olc-press" onClick={() => sendCommand("volume", { volume: Math.max(0, state.volume - 10) })}>
          <Icon name="remove" size={18} />
        </button>
        <span className="coach-volume-value">
          <Icon name="volume_up" size={16} style={{ marginRight: "4px" }} />
          {state.volume}%
        </span>
        <button className="coach-btn coach-btn-square olc-press" onClick={() => sendCommand("volume", { volume: Math.min(100, state.volume + 10) })}>
          <Icon name="add" size={18} />
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

      <button className="coach-tracklist-toggle olc-press" onClick={() => setShowTrackList(true)}>
        <Icon name="queue_music" size={18} />
        {t("coach.viewTracks", { count: tracks.length })}
      </button>

      <button className="coach-tracklist-toggle olc-press" onClick={() => setShowBackgrounds(true)}>
        <Icon name="wallpaper" size={18} />
        {t("coach.backgroundBtn")}
        {state.current_background && (
          <span style={{ color: "var(--text-muted)" }}> · {state.current_background.title}</span>
        )}
      </button>

      {/* Action destructive isolée du reste de l'écran (réf. correctif "le
          cours coach s'arrête si on quitte la page par mégarde") : seul
          bouton qui arrête réellement le cours, clairement libellé plutôt
          qu'une icône ambiguë, placé en bas loin du geste naturel de retour. */}
      <button className="coach-disable-btn olc-press" onClick={() => sendCommand("stop")}>
        <Icon name="power_settings_new" size={18} />
        {t("coach.disableCoachMode")}
      </button>

      {showBackgrounds && (
        <div className="coach-sheet-overlay" onClick={() => setShowBackgrounds(false)}>
          <div className="coach-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="coach-sheet-handle" />
            <h3 style={{ margin: "0 0 12px" }}>{t("coach.backgroundsTitle")}</h3>
            <div className="coach-sheet-list">
              <button
                className={`coach-sheet-track olc-press ${!state.current_background ? "active" : ""}`}
                onClick={() => {
                  sendCommand("audio_set_background", { background_id: null });
                  setShowBackgrounds(false);
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Icon name="hide_image" size={18} />
                  {t("coach.noBackground")}
                </span>
              </button>
              {backgrounds.map((bg) => (
                <button
                  key={bg.id}
                  className={`coach-sheet-track olc-press ${state.current_background?.id === bg.id ? "active" : ""}`}
                  onClick={() => {
                    sendCommand("audio_set_background", { background_id: bg.id });
                    setShowBackgrounds(false);
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Icon name={bg.is_image ? "image" : "gradient"} size={18} />
                    {bg.title}
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {bg.is_image ? t("coach.backgroundImageTag") : t("coach.backgroundVideoTag")}
                  </span>
                </button>
              ))}
            </div>
            <button className="btn btn-secondary" style={{ height: "48px", marginTop: "12px" }} onClick={() => setShowBackgrounds(false)}>
              {t("coach.close")}
            </button>
          </div>
        </div>
      )}

      {showTrackList && (
        <div className="coach-sheet-overlay" onClick={() => setShowTrackList(false)}>
          <div className="coach-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="coach-sheet-handle" />
            <h3 style={{ margin: "0 0 12px" }}>{t("coach.courseTracksTitle")}</h3>
            <div className="coach-sheet-list">
              {tracks.map((track, idx) => (
                <button
                  key={track.id}
                  className={`coach-sheet-track olc-press ${idx === trackIndex ? "active" : ""}`}
                  onClick={() => {
                    sendCommand("audio_jump_to_track", { index: idx });
                    setShowTrackList(false);
                  }}
                >
                  <span>{idx + 1}. {track.title}</span>
                  <span style={{ color: "var(--text-muted)" }}>{formatTime(track.duration_seconds)}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-secondary" style={{ height: "48px", marginTop: "12px" }} onClick={() => setShowTrackList(false)}>
              {t("coach.close")}
            </button>
          </div>
        </div>
      )}

      {navSheet}
    </div>
  );
}
