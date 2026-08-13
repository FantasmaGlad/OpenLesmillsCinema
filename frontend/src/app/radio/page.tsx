"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useInterpolatedPosition } from "@/lib/useInterpolatedPosition";
import { RadioEvent, RadioRepeatMode, RadioTrackInfo, useRadioSocket } from "@/lib/useRadioSocket";
import Icon from "@/components/Icon";
import AppLogo from "@/components/AppLogo";

// Écran du poste radio dédié (réf. docs/cahier-des-charges-radio.md, lots
// L4/L5) : mise en page "type Spotify", lecteur PRIMAIRE (source de la
// position rapportée au serveur, comme le kiosk câblé/réseau — réf. correctif
// P4). Ouvert à la main dans un navigateur standard, PAS de service kiosk
// systemd dédié (arbitrage A5) — d'où l'écran de déverrouillage ci-dessous
// (politique d'autoplay des navigateurs).
//
// Moteur audio (lot L5, §6) : DEUX <audio> ("slots" A=0/B=1) routés dans un
// graphe Web Audio API (MediaElementAudioSourceNode -> GainNode ->
// destination) — impossible de faire chevaucher deux lectures sur un seul
// élément. `activeSlotRef` désigne le slot que le SERVEUR considère comme la
// piste en cours ; l'autre sert de tampon pour précharger/fondre la piste
// suivante en avance (`crossfade_seconds` avant la fin réelle), sans jamais
// attendre la confirmation serveur pour démarrer le fondu — seule
// l'officialisation du changement de slot actif attend cette confirmation
// (cf. handleEvent), pour que la position rapportée reste cohérente avec
// l'état serveur pendant le chevauchement. Le rappel (lot L6, duck) réutilise
// le MÊME graphe : la « rampe de gain » n'est plus qu'une primitive partagée.

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

const REPEAT_CYCLE: RadioRepeatMode[] = ["off", "playlist", "track"];
const DUCK_LEVEL_DEFAULT = 15;
const DUCK_FADE_MS_DEFAULT = 1500;

type Slot = 0 | 1;
const OTHER_SLOT = (slot: Slot): Slot => (slot === 0 ? 1 : 0);

export default function RadioScreenPage() {
  const { t } = useAppSettings();

  // Deux éléments <audio> (slots A=0/B=1, réf. lot L5) plutôt qu'un seul :
  // le crossfade a besoin de faire chevaucher deux lectures. Refs NOMMÉES
  // individuellement (pas un tableau de refs) : nécessaire pour le binding
  // `ref=` en JSX, et plus lisible pour le lint hooks/refs.
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const announcementAudioRef = useRef<HTMLAudioElement | null>(null);
  // Accès générique par slot (utilisé uniquement dans des gestionnaires
  // d'évènements/effets, jamais pendant le rendu).
  const getAudioEl = (slot: Slot): HTMLAudioElement | null => (slot === 0 ? audioARef.current : audioBRef.current);

  // Graphe Web Audio (créé UNE FOIS au déverrouillage — un AudioContext exige
  // un geste utilisateur — jamais recréé ensuite).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainARef = useRef<GainNode | null>(null);
  const gainBRef = useRef<GainNode | null>(null);
  const getGain = (slot: Slot): GainNode | null => (slot === 0 ? gainARef.current : gainBRef.current);
  const setGainRef = (slot: Slot, node: GainNode) => {
    if (slot === 0) gainARef.current = node;
    else gainBRef.current = node;
  };
  const announcementGainRef = useRef<GainNode | null>(null);
  const graphReadyRef = useRef(false);

  const [unlocked, setUnlocked] = useState(false);
  const [lastCause, setLastCause] = useState("sync");
  const lastReportRef = useRef(0);
  const isPrimaryRef = useRef(false);

  // Slot que le SERVEUR considère comme actif, et id de piste chargé dans
  // chaque slot (pour savoir si une piste annoncée est déjà en cours de
  // fondu — avance anticipée — ou doit être chargée à neuf).
  const activeSlotRef = useRef<Slot>(0);
  const slotTrackIdRef = useRef<[number | null, number | null]>([null, null]);
  const crossfadingRef = useRef(false);

  const activeAnnouncementRef = useRef<{ id: number; mode: string } | null>(null);
  // Fondu d'entrée/sortie du RAPPEL LUI-MÊME (réf. correctif "vitesse de fade
  // réglable" — jusqu'ici seule la musique de fond était atténuée en mode
  // duck, le gain du rappel restait fixé à 1). Le timeout de fin de fondu de
  // sortie est annulable : un nouveau rappel qui démarrerait avant son
  // expiration (dos-à-dos, écart < fadeMs) ne doit pas se faire couper par un
  // pause() différé destiné à l'ancien.
  const announcementFadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const duckSettingsRef = useRef({ level: DUCK_LEVEL_DEFAULT, fadeMs: DUCK_FADE_MS_DEFAULT });
  useEffect(() => {
    fetch(getApiUrl("/settings"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        duckSettingsRef.current = {
          level: typeof data.radio_announcement_duck_level === "number" ? data.radio_announcement_duck_level : DUCK_LEVEL_DEFAULT,
          fadeMs: typeof data.radio_announcement_fade_ms === "number" ? data.radio_announcement_fade_ms : DUCK_FADE_MS_DEFAULT,
        };
      })
      .catch(() => {});
  }, []);

  // ------------------------------------------------------------------
  // Graphe Web Audio (réf. lot L5)
  // ------------------------------------------------------------------
  const ensureAudioGraph = (initialVolume: number) => {
    if (graphReadyRef.current) return;
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return; // navigateur sans Web Audio API : dégradation silencieuse (pas de fondu, l'enchaînement net de L3/L4 reste fonctionnel via onEnded)
    const ctx = new AudioContextClass();
    audioCtxRef.current = ctx;
    for (const slot of [0, 1] as Slot[]) {
      const el = getAudioEl(slot);
      if (!el) continue;
      el.volume = 1; // le volume réel passe désormais par le GainNode, jamais par l'élément
      const gain = ctx.createGain();
      gain.gain.value = slot === activeSlotRef.current ? initialVolume / 100 : 0;
      gain.connect(ctx.destination);
      ctx.createMediaElementSource(el).connect(gain);
      setGainRef(slot, gain);
    }
    const annEl = announcementAudioRef.current;
    if (annEl) {
      annEl.volume = 1;
      const annGain = ctx.createGain();
      annGain.gain.value = 1;
      annGain.connect(ctx.destination);
      ctx.createMediaElementSource(annEl).connect(annGain);
      announcementGainRef.current = annGain;
    }
    graphReadyRef.current = true;
  };

  const setGainNow = (slot: Slot, value: number) => {
    const gain = getGain(slot);
    const ctx = audioCtxRef.current;
    if (!gain || !ctx) return;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(value, ctx.currentTime);
  };

  const rampGain = (slot: Slot, to: number, durationMs: number) => {
    const gain = getGain(slot);
    const ctx = audioCtxRef.current;
    if (!gain || !ctx) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(to, now + Math.max(0.001, durationMs / 1000));
  };

  // ------------------------------------------------------------------
  // Chargement direct (pas de fondu) : nouvelle playlist, saut manuel
  // (suivant/précédent/file d'attente), reprise après un rappel.
  // ------------------------------------------------------------------
  const loadDirect = (track: RadioTrackInfo, positionSeconds: number, playing: boolean, volumePercent: number) => {
    const slot = activeSlotRef.current;
    const el = getAudioEl(slot);
    if (!el) return;
    slotTrackIdRef.current[slot] = track.id;
    el.src = getApiUrl(`/radio/tracks/${track.id}/stream`);
    el.load();
    setGainNow(slot, volumePercent / 100);
    const onReady = () => {
      el.removeEventListener("canplay", onReady);
      try {
        el.currentTime = positionSeconds || 0;
      } catch {
        // Rattrapé au prochain évènement si toujours pas prêt.
      }
      if (playing && unlocked) el.play().catch(() => {});
    };
    el.addEventListener("canplay", onReady);
  };

  // ------------------------------------------------------------------
  // Fondu enchaîné (réf. lot L5, D6) : démarré CÔTÉ CLIENT, en avance sur la
  // confirmation serveur (qui n'arrive qu'à la fin réelle de la piste
  // sortante). `activeSlotRef` ne bascule qu'à cette confirmation (cf.
  // handleEvent) — pendant le chevauchement, la position rapportée reste
  // celle de la piste officiellement en cours côté serveur.
  // ------------------------------------------------------------------
  const startCrossfade = (nextTrack: RadioTrackInfo, volumePercent: number, crossfadeSeconds: number) => {
    if (crossfadingRef.current) return;
    const fromSlot = activeSlotRef.current;
    const toSlot = OTHER_SLOT(fromSlot);
    const toEl = getAudioEl(toSlot);
    if (!toEl || !audioCtxRef.current) return;
    crossfadingRef.current = true;
    slotTrackIdRef.current[toSlot] = nextTrack.id;
    toEl.src = getApiUrl(`/radio/tracks/${nextTrack.id}/stream`);
    toEl.currentTime = 0;
    setGainNow(toSlot, 0);
    toEl.play().catch(() => {});
    const durationMs = Math.max(200, crossfadeSeconds * 1000);
    rampGain(fromSlot, 0, durationMs);
    rampGain(toSlot, volumePercent / 100, durationMs);
  };

  const abortCrossfadeIfAny = (restoreVolumePercent: number) => {
    if (!crossfadingRef.current) return;
    const otherSlot = OTHER_SLOT(activeSlotRef.current);
    getAudioEl(otherSlot)?.pause();
    setGainNow(otherSlot, 0);
    setGainNow(activeSlotRef.current, restoreVolumePercent / 100);
    slotTrackIdRef.current[otherSlot] = null;
    crossfadingRef.current = false;
  };

  const handleEvent = (evt: RadioEvent) => {
    setLastCause(evt.cause);
    const data = evt.data;
    const announcementAudio = announcementAudioRef.current;

    // --- Rappels (réf. lot L6) : le duck réutilise le graphe Web Audio du
    // crossfade (rampGain) au lieu du ramp <audio>.volume du lot L6. ---
    const ann = data.current_announcement;
    const wasAnnouncing = activeAnnouncementRef.current;
    if (announcementAudio && ann && ann.id !== wasAnnouncing?.id) {
      activeAnnouncementRef.current = { id: ann.id, mode: ann.mode };
      // Un fondu anticipé qui n'a pas eu le temps de se confirmer avant
      // qu'un rappel ne s'insère est annulé : on revient plein volume sur la
      // piste officiellement active, pour laisser la place au rappel.
      abortCrossfadeIfAny(data.volume);
      // Un rappel qui démarre avant l'expiration du fondu de sortie du
      // précédent (dos-à-dos) annule le pause() différé qui lui était destiné.
      if (announcementFadeOutTimeoutRef.current) {
        clearTimeout(announcementFadeOutTimeoutRef.current);
        announcementFadeOutTimeoutRef.current = null;
      }
      announcementAudio.src = getApiUrl(`/radio/announcements/${ann.id}/stream`);
      announcementAudio.load();
      if (unlocked) announcementAudio.play().catch(() => {});
      const fadeMs = duckSettingsRef.current.fadeMs;
      const annGain = announcementGainRef.current;
      const ctx = audioCtxRef.current;
      if (annGain && ctx) {
        annGain.gain.cancelScheduledValues(ctx.currentTime);
        annGain.gain.setValueAtTime(0, ctx.currentTime);
        annGain.gain.linearRampToValueAtTime(1, ctx.currentTime + Math.max(0.001, fadeMs / 1000));
      }
      if (ann.mode === "duck") {
        rampGain(activeSlotRef.current, duckSettingsRef.current.level / 100, fadeMs);
      }
    } else if (announcementAudio && !ann && wasAnnouncing) {
      activeAnnouncementRef.current = null;
      const fadeMs = duckSettingsRef.current.fadeMs;
      const annGain = announcementGainRef.current;
      const ctx = audioCtxRef.current;
      if (annGain && ctx) {
        annGain.gain.cancelScheduledValues(ctx.currentTime);
        annGain.gain.setValueAtTime(annGain.gain.value, ctx.currentTime);
        annGain.gain.linearRampToValueAtTime(0, ctx.currentTime + Math.max(0.001, fadeMs / 1000));
      }
      // pause()/removeAttribute différés jusqu'à la fin du fondu de sortie,
      // sinon l'audio se coupe net avant même que le gain ait eu le temps de
      // descendre (Web Audio ne coupe pas la lecture, seulement le volume).
      announcementFadeOutTimeoutRef.current = setTimeout(() => {
        announcementAudio.pause();
        announcementAudio.removeAttribute("src");
        announcementAudio.load();
        announcementFadeOutTimeoutRef.current = null;
      }, fadeMs);
      if (wasAnnouncing.mode === "duck") {
        rampGain(activeSlotRef.current, data.volume / 100, fadeMs);
      }
    }
    const isDucking = activeAnnouncementRef.current?.mode === "duck";

    const track = data.current_track;
    if (!track) {
      for (const slot of [0, 1] as Slot[]) {
        const el = getAudioEl(slot);
        if (el && el.getAttribute("src")) {
          el.pause();
          el.removeAttribute("src");
          el.load();
        }
        slotTrackIdRef.current[slot] = null;
      }
      crossfadingRef.current = false;
      return;
    }

    const activeSlot = activeSlotRef.current;
    const otherSlot = OTHER_SLOT(activeSlot);

    if (track.id === slotTrackIdRef.current[activeSlot]) {
      // Piste déjà active : cas courant (tick de position, volume,
      // pause/reprise, seek...) — rien à charger.
      const el = getAudioEl(activeSlot);
      if (!el) return;
      if (!isDucking) setGainNow(activeSlot, data.volume / 100);

      if (evt.cause === "radio_seek" || evt.cause === "radio_restart_track") {
        try {
          el.currentTime = data.position_seconds;
        } catch {
          // ignore
        }
      } else if (!isPrimaryRef.current && Math.abs(el.currentTime - data.position_seconds) > 1.5) {
        try {
          el.currentTime = data.position_seconds;
        } catch {
          // ignore
        }
      }

      if (ann?.mode === "wait_end") {
        // La piste vient de se terminer et laisse place au rappel (D12) : ne
        // pas la relancer malgré `data.playing` resté à sa valeur d'avant.
      } else if (data.playing && el.paused) {
        if (unlocked) el.play().catch(() => {});
      } else if (!data.playing && !el.paused) {
        el.pause();
      }
      return;
    }

    if (crossfadingRef.current && slotTrackIdRef.current[otherSlot] === track.id) {
      // Le serveur confirme la piste vers laquelle un fondu était déjà en
      // cours (réf. lot L5) : on officialise le changement de slot actif,
      // rien à recharger — tout l'intérêt du fondu anticipé.
      setGainNow(activeSlot, 0);
      setGainNow(otherSlot, isDucking ? duckSettingsRef.current.level / 100 : data.volume / 100);
      getAudioEl(activeSlot)?.pause();
      activeSlotRef.current = otherSlot;
      crossfadingRef.current = false;
      const newEl = getAudioEl(otherSlot);
      if (newEl && !data.playing && !newEl.paused) newEl.pause();
      return;
    }

    // Chargement direct : nouvelle playlist, saut manuel, ou reprise après
    // un rappel. Annule un fondu en cours s'il y en avait un.
    abortCrossfadeIfAny(data.volume);
    loadDirect(track, data.position_seconds || 0, data.playing, isDucking ? duckSettingsRef.current.level : data.volume);
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

  // Ferme proprement le contexte Web Audio si la page se démonte (hygiène —
  // ce poste reste normalement ouvert en permanence, comme un kiosk).
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  const maybeStartCrossfade = (el: HTMLAudioElement) => {
    if (crossfadingRef.current || !graphReadyRef.current || activeAnnouncementRef.current) return;
    if (state.repeat === "track") return; // boucle sur elle-même (radio_restart_track), pas de fondu
    const { duration, currentTime } = el;
    if (!isFinite(duration) || duration <= 0) return;
    const crossfadeSeconds = Math.max(0, state.crossfade_seconds || 0);
    if (crossfadeSeconds <= 0 || duration - currentTime > crossfadeSeconds) return;

    const { order, index } = state;
    if (index === null) return;
    let nextTrack: RadioTrackInfo | null = null;
    if (index + 1 < order.length) nextTrack = order[index + 1];
    else if (state.repeat === "playlist" && order.length > 0) nextTrack = order[0];
    if (!nextTrack) return;

    startCrossfade(nextTrack, state.volume, crossfadeSeconds);
  };

  // Gestionnaires pré-liés (pas de curryfication appelée pendant le rendu,
  // ex. `onTimeUpdate={f(0)}` — évite les faux positifs du lint hooks/refs
  // sur les fonctions invoquées au rendu qui referment sur des refs).
  const handleTimeUpdateForSlot = (slot: Slot) => {
    const el = getAudioEl(slot);
    if (!el || slot !== activeSlotRef.current) return;
    if (isPrimaryRef.current) {
      const nowMs = Date.now();
      if (nowMs - lastReportRef.current >= 900) {
        lastReportRef.current = nowMs;
        sendCommand("report_position", { position_seconds: el.currentTime });
      }
    }
    maybeStartCrossfade(el);
  };
  const handleTimeUpdateA = () => handleTimeUpdateForSlot(0);
  const handleTimeUpdateB = () => handleTimeUpdateForSlot(1);

  const handleEndedForSlot = (slot: Slot) => {
    if (slot === activeSlotRef.current) sendCommand("radio_track_ended");
  };
  const handleEndedA = () => handleEndedForSlot(0);
  const handleEndedB = () => handleEndedForSlot(1);

  const handleUnlock = () => {
    setUnlocked(true);
    ensureAudioGraph(state.volume);
    audioCtxRef.current?.resume().catch(() => {});
    const el = getAudioEl(activeSlotRef.current);
    if (el && state.playing && state.current_track) {
      el.play().catch(() => {});
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

  const handlePlayPause = () => sendCommand(state.playing ? "pause" : "play");
  const handleRepeatCycle = () => {
    const next = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(state.repeat) + 1) % REPEAT_CYCLE.length];
    sendCommand("radio_set_repeat", { mode: next });
  };
  const repeatLabel =
    state.repeat === "track" ? t("radioRemote.repeatTrack") : state.repeat === "playlist" ? t("radioRemote.repeatPlaylist") : t("radioRemote.repeatOff");

  return (
    <div className="radio-screen">
      <audio ref={audioARef} onTimeUpdate={handleTimeUpdateA} onEnded={handleEndedA} />
      <audio ref={audioBRef} onTimeUpdate={handleTimeUpdateB} onEnded={handleEndedB} />
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
        </>
      )}
    </div>
  );
}
