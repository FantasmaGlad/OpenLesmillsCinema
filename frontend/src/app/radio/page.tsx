"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useInterpolatedPosition } from "@/lib/useInterpolatedPosition";
import { RadioEvent, RadioRepeatMode, useRadioSocket } from "@/lib/useRadioSocket";
import Icon from "@/components/Icon";
import AppLogo from "@/components/AppLogo";

// Écran du poste radio dédié (réf. docs/cahier-des-charges-radio.md, lot L4) :
// mise en page "type Spotify", lecteur PRIMAIRE (source de la position
// rapportée au serveur, comme le kiosk câblé/réseau — réf. correctif P4).
// Volontairement plus simple que /kiosk : un seul <audio>, pas de couches
// vidéo/fond/intro à synchroniser. Ouvert à la main dans un navigateur
// standard, PAS de service kiosk systemd dédié (arbitrage A5) — d'où l'écran
// de déverrouillage ci-dessous (politique d'autoplay des navigateurs).

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

function formatClock(date: Date) {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

/** Fondu de volume simple (réf. lot L6, D12 « fondu immédiat ») : anime
 * `el.volume` de `from` à `to` sur `durationMs`. Volontairement un ramp
 * <audio>.volume plutôt qu'un graphe Web Audio API (GainNode) — le vrai
 * crossfade/gapless (lot L5) sera la brique qui le remplacera. */
function rampVolume(el: HTMLAudioElement, from: number, to: number, durationMs: number) {
  const start = Math.max(0, Math.min(1, from));
  const end = Math.max(0, Math.min(1, to));
  el.volume = start;
  if (durationMs <= 0) {
    el.volume = end;
    return;
  }
  const startedAt = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - startedAt) / durationMs);
    el.volume = start + (end - start) * t;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const REPEAT_CYCLE: RadioRepeatMode[] = ["off", "playlist", "track"];

export default function RadioScreenPage() {
  const { t } = useAppSettings();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const announcementAudioRef = useRef<HTMLAudioElement | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [lastCause, setLastCause] = useState("sync");
  const lastReportRef = useRef(0);
  const isPrimaryRef = useRef(false);
  // Rappel actuellement chargé côté client (id + mode), pour détecter les
  // transitions démarrage/fin sans dépendre de l'ordre des évènements reçus.
  const activeAnnouncementRef = useRef<{ id: number; mode: string } | null>(null);
  // Réglages du duck (réf. lot L6, §9) : chargés une fois, pas encore
  // éditables à chaud depuis l'admin (cf. routers/settings.py).
  const duckSettingsRef = useRef({ level: 15, fadeMs: 1500 });
  useEffect(() => {
    fetch(getApiUrl("/settings"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        duckSettingsRef.current = {
          level: typeof data.radio_announcement_duck_level === "number" ? data.radio_announcement_duck_level : 15,
          fadeMs: typeof data.radio_announcement_fade_ms === "number" ? data.radio_announcement_fade_ms : 1500,
        };
      })
      .catch(() => {});
  }, []);

  const handleEvent = (evt: RadioEvent) => {
    setLastCause(evt.cause);
    const audio = audioRef.current;
    const announcementAudio = announcementAudioRef.current;
    if (!audio) return;
    const data = evt.data;
    const track = data.current_track;

    // Rappel (réf. lot L6) : traité avant la synchro piste ci-dessous, pour
    // pouvoir démarrer/couper le duck avant que le volume de la musique ne
    // soit réappliqué plus bas.
    const ann = data.current_announcement;
    const wasAnnouncing = activeAnnouncementRef.current;
    if (announcementAudio && ann && ann.id !== wasAnnouncing?.id) {
      activeAnnouncementRef.current = { id: ann.id, mode: ann.mode };
      const annSrc = getApiUrl(`/radio/announcements/${ann.id}/stream`);
      announcementAudio.src = annSrc;
      announcementAudio.volume = 1;
      announcementAudio.load();
      if (unlocked) announcementAudio.play().catch(() => {});
      if (ann.mode === "duck" && audio) {
        rampVolume(audio, audio.volume, duckSettingsRef.current.level / 100, duckSettingsRef.current.fadeMs);
      }
    } else if (announcementAudio && !ann && wasAnnouncing) {
      activeAnnouncementRef.current = null;
      announcementAudio.pause();
      announcementAudio.removeAttribute("src");
      announcementAudio.load();
      if (wasAnnouncing.mode === "duck" && audio) {
        rampVolume(audio, audio.volume, data.volume / 100, duckSettingsRef.current.fadeMs);
      }
    }
    // Volume de la musique : pas réappliqué pendant un duck en cours (le
    // ramp ci-dessus le pilote), sinon un tick de position écraserait le
    // fondu en cours à chaque rapport de position (~1/s).
    const isDucking = activeAnnouncementRef.current?.mode === "duck";

    if (!track) {
      if (audio.getAttribute("src")) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      return;
    }

    const src = getApiUrl(`/radio/tracks/${track.id}/stream`);
    const srcChanged = !audio.src || !audio.src.endsWith(src);
    if (!isDucking) audio.volume = data.volume / 100;

    if (srcChanged) {
      audio.src = src;
      audio.load();
      const onReady = () => {
        audio.removeEventListener("canplay", onReady);
        try {
          audio.currentTime = data.position_seconds || 0;
        } catch {
          // Rattrapé au prochain évènement si toujours pas prêt.
        }
        if (data.playing && unlocked) audio.play().catch(() => {});
      };
      audio.addEventListener("canplay", onReady);
      return;
    }

    // Même piste : ne recale le temps que sur une vraie discontinuité (seek/
    // redémarrage), jamais sur un simple tick de position (réf. correctif
    // "saccades kiosk réseau" — même principe pour la radio).
    if (evt.cause === "radio_seek" || evt.cause === "radio_restart_track") {
      try {
        audio.currentTime = data.position_seconds;
      } catch {
        // ignore
      }
    } else if (!isPrimaryRef.current && Math.abs(audio.currentTime - data.position_seconds) > 1.5) {
      // Dérive du lecteur MIROIR uniquement (réf. A3 : aucun miroir garanti
      // en pratique, mais on reste cohérent si un second onglet est ouvert).
      try {
        audio.currentTime = data.position_seconds;
      } catch {
        // ignore
      }
    }

    if (ann?.mode === "wait_end") {
      // La piste vient de se terminer et laisse place au rappel (D12) : ne
      // pas la relancer malgré `data.playing` resté à sa valeur d'avant
      // (le serveur ne le modifie pas pendant un rappel).
    } else if (data.playing && audio.paused) {
      if (unlocked) audio.play().catch(() => {});
    } else if (!data.playing && !audio.paused) {
      audio.pause();
    }
  };

  const { state, connected, sendCommand, isPrimary } = useRadioSocket(handleEvent, "kiosk");
  useEffect(() => {
    isPrimaryRef.current = isPrimary;
  }, [isPrimary]);

  const livePosition = useInterpolatedPosition(state.position_seconds, state.playing, lastCause);

  const [now, setNow] = useState(new Date());
  const clockOffsetRef = useRef(0);
  useEffect(() => {
    const syncClock = () => {
      fetch(getApiUrl("/time"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && typeof data.server_ts === "number") clockOffsetRef.current = data.server_ts - Date.now();
        })
        .catch(() => {});
    };
    syncClock();
    const syncId = setInterval(syncClock, 60 * 1000);
    const tickId = setInterval(() => setNow(new Date(Date.now() + clockOffsetRef.current)), 1000);
    return () => {
      clearInterval(syncId);
      clearInterval(tickId);
    };
  }, []);

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || !isPrimary) return;
    const now = Date.now();
    if (now - lastReportRef.current < 900) return;
    lastReportRef.current = now;
    sendCommand("report_position", { position_seconds: audio.currentTime });
  };

  const handleUnlock = () => {
    setUnlocked(true);
    const audio = audioRef.current;
    if (audio && state.playing && state.current_track) {
      audio.play().catch(() => {});
    }
    const announcementAudio = announcementAudioRef.current;
    if (announcementAudio && state.current_announcement) {
      announcementAudio.play().catch(() => {});
    }
  };

  const handlePlayAnnouncement = () => sendCommand("radio_play_announcement", {});

  const currentTrack = state.current_track;
  const coverSrc = currentTrack?.cover_url ? getApiUrl(currentTrack.cover_url) : null;
  const duration = state.duration_seconds ?? currentTrack?.duration_seconds ?? 0;
  const queue = state.index !== null ? state.order.slice(state.index + 1) : [];

  const handlePlayPause = () => sendCommand(state.playing ? "pause" : "play");
  const handleRepeatCycle = () => {
    const next = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(state.repeat) + 1) % REPEAT_CYCLE.length];
    sendCommand("radio_set_repeat", { mode: next });
  };
  const repeatLabel =
    state.repeat === "track" ? t("radioRemote.repeatTrack") : state.repeat === "playlist" ? t("radioRemote.repeatPlaylist") : t("radioRemote.repeatOff");

  return (
    <div className="radio-screen">
      <audio ref={audioRef} onTimeUpdate={handleTimeUpdate} onEnded={() => sendCommand("radio_track_ended")} />
      <audio ref={announcementAudioRef} onEnded={() => sendCommand("announcement_ended")} />

      {state.current_announcement && (
        <div className="radio-announcement-banner">
          <Icon name="campaign" size={18} />
          {state.current_announcement.description}
        </div>
      )}

      {!unlocked && (
        <div className="radio-unlock-overlay">
          <AppLogo size={72} />
          <div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800, marginBottom: "8px" }}>{t("radioScreen.unlockTitle")}</div>
            <div style={{ color: "var(--text-muted)" }}>{t("radioScreen.unlockHint")}</div>
          </div>
          <button className="radio-unlock-btn" onClick={handleUnlock}>
            <Icon name="play_circle" size={22} filled />
            {t("radioScreen.unlockButton")}
          </button>
        </div>
      )}

      {!currentTrack ? (
        <>
          <AppLogo size={90} />
          <span className="radio-screen-clock">{formatClock(now)}</span>
          <span className="radio-screen-idle-label">
            {connected ? t("radioScreen.idleHint") : t("radioRemote.disconnected")}
          </span>
        </>
      ) : (
        <>
          <div className="radio-cover">
            {coverSrc ? <img src={coverSrc} alt="" /> : <Icon name="music_note" size={64} />}
          </div>

          <div>
            <div className="radio-meta-title">{currentTrack.title}</div>
            <div className="radio-meta-artist">
              {currentTrack.artist || t("radioLibrary.unknownArtist")}
              {currentTrack.album ? ` — ${currentTrack.album}` : ""}
            </div>
          </div>

          <div className="radio-screen-progress">
            <span>{formatTime(livePosition)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={1}
              value={livePosition}
              onChange={(e) => sendCommand("radio_seek", { position_seconds: Number(e.target.value) })}
              className="seek-slider"
              style={{ flex: 1 }}
            />
            <span>{formatTime(duration)}</span>
          </div>

          <div className="radio-screen-controls">
            <button
              className={`radio-transport-btn ${state.shuffle ? "active" : ""}`}
              onClick={() => sendCommand("radio_set_shuffle", { on: !state.shuffle })}
              title={t("radioRemote.shuffleLabel")}
            >
              <Icon name="shuffle" size={20} />
            </button>
            <button className="radio-transport-btn" onClick={() => sendCommand("radio_previous_track")} title={t("radioRemote.previousTrack")}>
              <Icon name="skip_previous" size={22} filled />
            </button>
            <button className="radio-transport-btn main" onClick={handlePlayPause}>
              <Icon name={state.playing ? "pause" : "play_arrow"} size={30} filled />
            </button>
            <button className="radio-transport-btn" onClick={() => sendCommand("radio_next_track")} title={t("radioRemote.nextTrack")}>
              <Icon name="skip_next" size={22} filled />
            </button>
            <button
              className={`radio-transport-btn ${state.repeat !== "off" ? "active" : ""}`}
              onClick={handleRepeatCycle}
              title={repeatLabel}
            >
              <Icon name={state.repeat === "track" ? "repeat_one" : "repeat"} size={20} />
            </button>
            <button
              className="radio-transport-btn"
              onClick={handlePlayAnnouncement}
              disabled={!!state.current_announcement}
              title={t("radioAnnouncements.playNow")}
            >
              <Icon name="campaign" size={20} />
            </button>
          </div>

          <div className="radio-screen-volume">
            <Icon name="volume_up" size={18} />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={state.volume}
              onChange={(e) => sendCommand("volume", { volume: Number(e.target.value) })}
              className="volume-slider"
              style={{ flex: 1 }}
            />
            <span>{state.volume}%</span>
          </div>

          {queue.length > 0 && (
            <div className="radio-screen-queue">
              {queue.map((track, i) => (
                <div key={`${track.id}-${i}`} className="radio-screen-queue-item">
                  <span>{track.title}</span>
                  <span>{track.artist || t("radioLibrary.unknownArtist")}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
