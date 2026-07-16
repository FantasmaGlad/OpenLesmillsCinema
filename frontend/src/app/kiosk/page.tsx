"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePlaybackSocket, PlaybackEvent } from "@/lib/usePlaybackSocket";
import { useTimerSocket } from "@/lib/useTimerSocket";

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
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatClock(date: Date) {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

type OsdContent = { icon: string; label: string } | null;

interface NextCourse {
  run_at: string;
  title: string | null;
}

const PROGRAM_ACCENT: Record<string, string> = {
  RPM: "var(--accent-rpm)",
  Sprint: "var(--accent-sprint)",
  "The Trip": "var(--accent-trip)",
};

export default function KioskPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastReportRef = useRef(0);
  const lastAudioReportRef = useRef(0);
  const [osd, setOsd] = useState<OsdContent>(null);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now, setNow] = useState(new Date());
  const [nextCourse, setNextCourse] = useState<NextCourse | null>(null);

  // Horloge locale (hors ligne par nature, cf. §5.5) : une seule minuterie
  // réutilisée pour l'affichage de l'heure et le calcul du "prochain cours".
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchNext = () => {
      fetch(getApiUrl("/schedule/next"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled) setNextCourse(data);
        })
        .catch(() => {
          if (!cancelled) setNextCourse(null);
        });
    };
    fetchNext();
    const id = setInterval(fetchNext, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const showOsd = useCallback((content: OsdContent) => {
    setOsd(content);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsd(null), 3000);
  }, []);

  const handleEvent = useCallback(
    (evt: PlaybackEvent) => {
      const { cause, data, client_ts } = evt;
      const video = videoRef.current;
      const bgVideo = bgVideoRef.current;
      const audio = audioRef.current;

      if (client_ts) {
        // Instrumentation de latence commande -> effet écran (cible < 500 ms, réf. NF4 / tâche 3.10).
        console.log(`[latence] ${cause} appliqué en ${Date.now() - client_ts} ms`);
      }

      const currentTrack =
        data.audio_tracks && data.audio_track_index !== null && data.audio_track_index !== undefined
          ? data.audio_tracks[data.audio_track_index]
          : null;
      const backgroundId = data.current_background?.id ?? data.current_audio_course?.background_id ?? null;

      const syncAudioToTrack = (resetTime: boolean) => {
        if (!audio || !currentTrack) return;
        const src = getApiUrl(`/audio/tracks/${currentTrack.id}/stream`);
        if (!audio.src || !audio.src.endsWith(src)) {
          audio.src = src;
          audio.load();
        }
        if (resetTime) audio.currentTime = 0;
        audio.volume = data.volume / 100;
        if (data.audio_playing) audio.play().catch(() => {});
        else audio.pause();
      };

      switch (cause) {
        case "sync": {
          if (backgroundId && bgVideo) {
            const bgSrc = getApiUrl(`/backgrounds/${backgroundId}/stream`);
            if (!bgVideo.src || !bgVideo.src.endsWith(bgSrc)) bgVideo.src = bgSrc;
            bgVideo.play().catch(() => {});
          }
          if (data.current_audio_course && audio && currentTrack) {
            const aSrc = getApiUrl(`/audio/tracks/${currentTrack.id}/stream`);
            if (!audio.src || !audio.src.endsWith(aSrc)) audio.src = aSrc;
            audio.currentTime = data.audio_position_seconds;
            audio.volume = data.volume / 100;
            if (data.audio_playing) audio.play().catch(() => {});
          }
          if (!video || !data.current_video) break;
          const src = getApiUrl(`/videos/${data.current_video.id}/stream`);
          if (!video.src || !video.src.endsWith(src)) video.src = src;
          video.currentTime = data.position_seconds;
          video.volume = data.volume / 100;
          video.playbackRate = data.speed;
          if (data.state === "playing") video.play().catch(() => {});
          break;
        }
        case "load": {
          if (!video || !data.current_video) break;
          video.src = getApiUrl(`/videos/${data.current_video.id}/stream`);
          video.currentTime = 0;
          video.volume = data.volume / 100;
          video.playbackRate = data.speed;
          video.load();
          break;
        }
        case "load_background": {
          if (!bgVideo || !data.current_background) break;
          bgVideo.src = getApiUrl(`/backgrounds/${data.current_background.id}/stream`);
          bgVideo.load();
          bgVideo.play().catch(() => {});
          break;
        }
        case "load_audio_course": {
          if (backgroundId && bgVideo) {
            const bgSrc = getApiUrl(`/backgrounds/${backgroundId}/stream`);
            bgVideo.src = bgSrc;
            bgVideo.load();
            bgVideo.play().catch(() => {});
          }
          syncAudioToTrack(true);
          break;
        }
        case "audio_next_track":
        case "audio_previous_track":
        case "audio_jump_to_track":
        case "audio_restart_track":
          syncAudioToTrack(true);
          break;
        case "countdown_end":
        case "play":
          if (data.current_audio_course) audio?.play().catch(() => {});
          else video?.play().catch(() => {});
          break;
        case "pause":
          if (data.current_audio_course) audio?.pause();
          else video?.pause();
          break;
        case "stop":
          if (video) {
            video.pause();
            video.removeAttribute("src");
            video.load();
          }
          if (bgVideo) {
            bgVideo.pause();
            bgVideo.removeAttribute("src");
            bgVideo.load();
          }
          if (audio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
          }
          break;
        case "seek":
          if (video) video.currentTime = data.position_seconds;
          showOsd({
            icon: "⏩",
            label: `${formatTime(data.position_seconds)} / ${formatTime(data.current_video?.duration_seconds)}`,
          });
          break;
        case "volume":
          if (video) video.volume = data.volume / 100;
          if (audio) audio.volume = data.volume / 100;
          showOsd({ icon: "🔊", label: `${data.volume}%` });
          break;
        case "speed":
          if (video) video.playbackRate = data.speed;
          showOsd({ icon: "⏱", label: `${data.speed.toFixed(2)}x` });
          break;
        default:
          break;
      }
    },
    [showOsd]
  );

  const { state, sendCommand } = usePlaybackSocket(handleEvent);
  const { state: timerState } = useTimerSocket();

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const t = Date.now();
    if (t - lastReportRef.current > 1000) {
      lastReportRef.current = t;
      sendCommand("report_position", { position_seconds: video.currentTime });
    }
  };

  const handleAudioTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = Date.now();
    if (t - lastAudioReportRef.current > 1000) {
      lastAudioReportRef.current = t;
      sendCommand("audio_report_position", { position_seconds: audio.currentTime });
    }
  };

  const program = state.current_video?.program ?? state.current_audio_course?.program ?? undefined;
  const programAccent = (program && PROGRAM_ACCENT[program]) || "var(--accent-primary)";
  const isIdle = state.state === "waiting" || state.state === "offline";
  const isVideoLayer = state.state === "playing" || state.state === "paused";
  const isPaused = state.state === "paused";
  const isCoachMode = state.state === "coach_mode";
  const coachBackgroundId = state.current_audio_course?.background_id ?? null;
  const currentTrack =
    state.audio_tracks && state.audio_track_index !== null && state.audio_track_index !== undefined
      ? state.audio_tracks[state.audio_track_index]
      : null;
  const audioTrackRemaining = currentTrack?.duration_seconds
    ? Math.max(0, currentTrack.duration_seconds - state.audio_position_seconds)
    : null;

  const nextCourseRemaining = nextCourse
    ? Math.max(0, (new Date(nextCourse.run_at).getTime() - now.getTime()) / 1000)
    : null;

  const duration = state.current_video?.duration_seconds ?? 0;
  const pauseProgressPercent = duration > 0 ? Math.min(100, (state.position_seconds / duration) * 100) : 0;

  const showTimerOverlay = timerState.mode === "countdown" || timerState.mode === "countup";
  const timerValue =
    timerState.mode === "countdown"
      ? formatDuration(timerState.remaining_seconds ?? 0)
      : formatDuration(timerState.elapsed_seconds ?? 0);

  const nextPlaylistItem = state.playlist_items && state.playlist_index !== null && state.playlist_index !== undefined
    ? state.playlist_items[state.playlist_index + 1]
    : null;

  return (
    <div className="kiosk-root">
      <div className={`kiosk-layer kiosk-waiting ${isIdle ? "visible" : ""}`}>
        <span className="kiosk-clock">{formatClock(now)}</span>
        <span className="kiosk-brand">OPENLESMILLSCINEMA</span>
        {nextCourse ? (
          <div className="kiosk-next-course">
            <span className="kiosk-next-course-label">Prochain cours</span>
            <span className="kiosk-next-course-title">{nextCourse.title ?? "Cours programmé"}</span>
            <span className="kiosk-next-course-countdown">{formatDuration(nextCourseRemaining ?? 0)}</span>
          </div>
        ) : (
          <span className="kiosk-waiting-sub">En attente du prochain cours</span>
        )}
      </div>

      <div className={`kiosk-layer kiosk-playlist-waiting ${state.state === "playlist_waiting" ? "visible" : ""}`}>
        <span className="kiosk-clock">{formatClock(now)}</span>
        <div className="kiosk-playlist-info">
          <span className="kiosk-playlist-label">PLAYLIST ACTIVE</span>
          <span className="kiosk-playlist-name">{state.playlist_name}</span>
        </div>
        {nextPlaylistItem ? (
          <div className="kiosk-next-course">
            <span className="kiosk-next-course-label">Prochain cours</span>
            <span className="kiosk-next-course-title">{nextPlaylistItem.title}</span>
            <span className="kiosk-playlist-countdown-number" style={{ color: "var(--accent-primary)" }}>
              {Math.ceil(state.playlist_waiting_remaining ?? 0)}
            </span>
          </div>
        ) : (
          <span className="kiosk-waiting-sub">Fin de la playlist</span>
        )}
      </div>

      <div className={`kiosk-layer kiosk-countdown ${state.state === "countdown" ? "visible" : ""}`}>
        <span className="kiosk-countdown-number" style={{ color: programAccent }}>
          {Math.ceil(state.countdown_remaining ?? 0)}
        </span>
        <span className="kiosk-countdown-title">{state.current_video?.title}</span>
      </div>

      <div className={`kiosk-layer kiosk-video-layer ${isVideoLayer ? "visible" : ""}`}>
        <video
          ref={videoRef}
          className="kiosk-video"
          onTimeUpdate={handleTimeUpdate}
          onEnded={() => sendCommand("video_ended")}
          playsInline
        />
      </div>

      <div
        className={`kiosk-layer kiosk-video-layer ${
          state.state === "background" || (isCoachMode && coachBackgroundId) ? "visible" : ""
        }`}
      >
        <video ref={bgVideoRef} className="kiosk-video" loop muted playsInline autoPlay />
      </div>

      <div className={`kiosk-layer kiosk-coach-mode ${isCoachMode ? "visible" : ""}`}>
        <audio
          ref={audioRef}
          onTimeUpdate={handleAudioTimeUpdate}
          onEnded={() => sendCommand("audio_track_ended")}
        />
        <div className="coach-habillage" style={{ borderColor: programAccent }}>
          <span className="coach-course-title" style={{ color: programAccent }}>
            {state.current_audio_course?.title}
          </span>
          {currentTrack ? (
            <>
              <span className="coach-track-label">
                Piste {(state.audio_track_index ?? 0) + 1}
                {state.audio_tracks ? ` / ${state.audio_tracks.length}` : ""}
              </span>
              <span className="coach-track-title">{currentTrack.title}</span>
              <span className="coach-track-remaining">
                {audioTrackRemaining !== null ? `- ${formatTime(audioTrackRemaining)}` : "--:--"}
              </span>
              {!state.audio_playing && <span className="coach-paused-badge">PAUSE</span>}
              {state.audio_chain_wait_remaining !== null && (
                <span className="coach-track-label">
                  Piste suivante dans {Math.ceil(state.audio_chain_wait_remaining ?? 0)} s
                </span>
              )}
            </>
          ) : (
            <span className="coach-track-label">Aucune piste</span>
          )}
        </div>
      </div>

      {isPaused && (
        <div className="pause-overlay visible">
          <span className="pause-title">{state.current_video?.title}</span>
          <span className="pause-label">PAUSE</span>
          <div className="pause-progress-track">
            <div className="pause-progress-fill" style={{ width: `${pauseProgressPercent}%` }} />
          </div>
        </div>
      )}

      {showTimerOverlay && (
        <div className={`timer-overlay ${timerState.ended ? "timer-ended" : ""}`}>
          <span className="timer-value">{timerValue}</span>
        </div>
      )}

      {osd && (
        <div className="kiosk-osd">
          <span className="kiosk-osd-icon">{osd.icon}</span>
          <span className="kiosk-osd-label">{osd.label}</span>
        </div>
      )}
    </div>
  );
}
