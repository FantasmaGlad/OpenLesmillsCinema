"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePlaybackSocket, PlaybackEvent } from "@/lib/usePlaybackSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { isWiredDisplay, useDisplayOutputRedirect } from "@/lib/useDisplayOutputRedirect";
import Icon from "@/components/Icon";
import AppLogo from "@/components/AppLogo";

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

// Durée hh:mm:ss pour le compte à rebours « prochain cours » de l'écran
// d'attente (format identique à l'ancien habillage dynamique).
function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

type OsdContent = { icon: string; label: string } | null;

interface NextCourse {
  run_at: string;
  title: string | null;
}

export default function KioskPage() {
  const { t } = useAppSettings();
  // Canal de diffusion de CE kiosk (réf. mission "Tableau de bord Câblé /
  // Réseau") : l'écran câblé du Wyse (accès en 127.0.0.1/localhost) suit
  // l'état du canal câblé, tout autre appareil du LAN celui du canal réseau.
  // Chacun n'applique QUE les évènements de son canal — deux lectures
  // simultanées totalement indépendantes, zéro interférence.
  const [channel] = useState<"cable" | "network">(() => (isWiredDisplay() ? "cable" : "network"));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastReportRef = useRef(0);
  const lastAudioReportRef = useRef(0);
  // Rôle primaire lisible depuis handleEvent (défini avant l'appel du hook) :
  // le kiosk primaire est la SOURCE de la position rapportée au serveur — il
  // ne doit jamais se recaler dessus (boucle d'auto-correction pendant un
  // rebuffering), seuls les miroirs suivent (correctif "kiosk réseau figé").
  const isPrimaryRef = useRef(false);
  // Correctif "kiosk réseau figé" : le Chromium du kiosk câblé tourne avec
  // --autoplay-policy=no-user-gesture-required (voir kiosk-xinitrc), donc
  // .play() y réussit toujours. Un appareil réseau (téléphone/PC d'un
  // adhérent) applique la politique d'autoplay standard des navigateurs, qui
  // bloque silencieusement la lecture avec son sans geste utilisateur — la
  // vidéo restait alors juste sur sa première image, indéfiniment, sans
  // aucun repli. Un tap sur ce bandeau relance en son.
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [osd, setOsd] = useState<OsdContent>(null);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now, setNow] = useState(new Date());
  // Offset en ms entre l'heure serveur et l'heure locale du navigateur (réf.
  // correctif P2). Utilisé pour corriger la dérive d'horloge de la TV kiosk
  // dont l'horloge système peut être décalée si NTP n'a pas encore synchro.
  const clockOffsetRef = useRef<number>(0);
  const [nextCourse, setNextCourse] = useState<NextCourse | null>(null);
  // Vidéo d'animation de lancement (réf. mission point 4) : jouée à chaque
  // entrée en état "countdown", à la place de l'ancien anneau chiffré.
  const introRef = useRef<HTMLVideoElement | null>(null);
  // Tick rapide (réf. audit plan-corrections-bugs, point 7) : force un
  // re-rendu à 5 Hz pour que le compte à rebours avant lancement et le
  // minuteur s'affichent en interpolation locale continue plutôt que par
  // à-coups d'un tick serveur toutes les secondes (saccades en cas d'aléa
  // réseau). Aucune valeur portée par cet état, juste un déclencheur.
  const [, setFastTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFastTick((t) => (t + 1) % 1_000_000), 200);
    return () => clearInterval(id);
  }, []);

  // Horloge synchronisée avec le serveur (réf. correctif P2) : on calcule
  // l'offset server_ts - Date.now() au démarrage puis toutes les 5 minutes.
  // Utiliser l'heure serveur plutôt que new Date() permet de corriger la
  // dérive d'horloge RTC du kiosk TV qui peut ne pas avoir synchro NTP au
  // moment où le navigateur démarre.
  useEffect(() => {
    const syncClock = () => {
      fetch(getApiUrl("/time"), { cache: "no-store" })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => {
          if (data && typeof data.server_ts === "number") {
            clockOffsetRef.current = data.server_ts - Date.now();
          }
        })
        .catch((err) => {
          // L'heure serveur est inaccessible : l'offset précédent est conservé
          // (fallback sur l'heure locale si premier démarrage). Log pour debug.
          console.warn("[clock] Synchronisation heure serveur échouée :", err);
        });
    };
    syncClock();
    // Resync toutes les 60s (au lieu de 5 min) pour limiter la dérive visible
    // si NTP corrige l'horloge du serveur Wyse entre-temps (réf. Bug 5).
    const syncId = setInterval(syncClock, 60 * 1000);
    const tickId = setInterval(() => setNow(new Date(Date.now() + clockOffsetRef.current)), 1000);
    return () => {
      clearInterval(syncId);
      clearInterval(tickId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchNext = () => {
      // Prochain cours DU CANAL de ce kiosk uniquement (planning par canal).
      fetch(getApiUrl(`/schedule/next?channel=${channel}`), { cache: "no-store" })
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
  }, [channel]);

  const showOsd = useCallback((content: OsdContent) => {
    setOsd(content);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsd(null), 3000);
  }, []);

  /**
   * Lance la lecture d'un <video>/<audio> avec repli si l'autoplay avec son
   * est refusé (réf. correctif "kiosk réseau figé") : au lieu de rester
   * silencieusement figé sur la première image (l'ancien `.catch(() => {})`
   * n'avait aucun repli), on retente en muet — quasi toujours autorisé —
   * pour au moins faire avancer l'image, et on affiche un bandeau "Activer
   * le son" qui, une fois tapé, satisfait le geste utilisateur requis par le
   * navigateur pour les lectures suivantes.
   *
   * Réservé au canal RÉSEAU (réf. correctif "'aucun son' reste affiché en
   * permanence sur l'écran câblé, impossible à retirer") : l'écran câblé
   * n'a ni souris ni doigt pour taper ce bandeau (Chromium y tourne de toute
   * façon avec --autoplay-policy=no-user-gesture-required, cf. kiosk-xinitrc
   * — l'autoplay avec son n'y est normalement jamais refusé) ; si `.play()`
   * y échoue quand même une fois (course au chargement, etc.), afficher un
   * bandeau qu'aucun humain ne peut jamais satisfaire ne fait que polluer
   * l'affichage indéfiniment sans aucun moyen de le faire disparaître.
   */
  const tryPlay = useCallback((el: HTMLMediaElement | null | undefined) => {
    if (!el) return;
    el.play().catch(() => {
      el.muted = true;
      el.play().catch(() => {});
      if (channel === "network") setNeedsAudioUnlock(true);
    });
  }, [channel]);

  const handleUnlockAudio = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video && video.src) {
      video.muted = false;
      video.play().catch(() => {});
    }
    if (audio && audio.src) {
      audio.muted = false;
      audio.play().catch(() => {});
    }
    setNeedsAudioUnlock(false);
  }, []);

  const handleEvent = useCallback(
    (evt: PlaybackEvent) => {
      const { cause, data, client_ts, play_intro } = evt;
      const video = videoRef.current;
      const bgVideo = bgVideoRef.current;
      const audio = audioRef.current;
      const intro = introRef.current;

      if (client_ts) {
        // Instrumentation de latence commande -> effet écran (cible < 500 ms, réf. NF4 / tâche 3.10).
        console.log(`[latence] ${cause} appliqué en ${Date.now() - client_ts} ms`);
      }

      const currentTrack =
        data.audio_tracks && data.audio_track_index !== null && data.audio_track_index !== undefined
          ? data.audio_tracks[data.audio_track_index]
          : null;
      const backgroundId = data.current_background?.id ?? data.current_audio_course?.background_id ?? null;
      // Fond figé (png/jpg...) : rendu par <img> directement depuis l'état,
      // le <video> de fond ne doit alors JAMAIS recevoir de src (réf. mission
      // "fond figé ou animé depuis le mode coach").
      const backgroundIsImage = data.current_background?.is_image ?? false;

      // Décharge complètement un élément média (correctif bug "cours
      // fantôme") : les couches kiosk sont seulement masquées en CSS, donc un
      // <video>/<audio> non déchargé continue de jouer (son audible) sous la
      // nouvelle couche. Appelé à chaque changement de mode pour tout élément
      // qui n'est plus concerné par l'état serveur.
      const unloadMedia = (el: HTMLMediaElement | null) => {
        if (!el || (!el.src && !el.getAttribute("src"))) return;
        el.pause();
        el.removeAttribute("src");
        el.load();
      };

      // Chaque /kiosk (câblé ou réseau) est un canal de diffusion à part
      // entière (réf. correctif "pas de son sur le réseau") : un second
      // écran connecté depuis le réseau a ses propres enceintes et doit donc
      // rendre le son lui aussi, au même volume que l'état partagé — plus de
      // coupure forcée réservée au seul écran câblé au Wyse.
      const applyVolume = (el: HTMLMediaElement) => {
        el.muted = false;
        el.volume = data.volume / 100;
      };

      // Repli "métadonnées pas encore chargées" (réf. retour utilisateur
      // 2026-07-21 "le cours sur la télé (réseau) ne se lance jamais, ni
      // l'intro" — TV sur une liaison réseau lente qui reconnecte son
      // WebSocket toutes les ~30s tant que la mise en tampon n'a pas abouti) :
      // assigner `currentTime` avant HAVE_METADATA lève une exception dans
      // certains navigateurs/WebView embarqués, ce qui empêchait alors
      // silencieusement le tryPlay() suivant sur la même ligne — retenté à
      // chaque reconnexion, sans jamais aboutir. On diffère l'assignation
      // jusqu'à `loadedmetadata` plutôt que de suivre en aveugle.
      const seekWhenReady = (el: HTMLMediaElement, position: number) => {
        const apply = () => {
          try {
            el.currentTime = position;
          } catch {
            // Rattrapé par le prochain sync/tick si toujours pas prêt.
          }
        };
        if (el.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
        else el.addEventListener("loadedmetadata", apply, { once: true });
      };

      const syncAudioToTrack = (resetTime: boolean) => {
        if (!audio || !currentTrack) return;
        const src = getApiUrl(`/audio/tracks/${currentTrack.id}/stream`);
        if (!audio.src || !audio.src.endsWith(src)) {
          audio.src = src;
          audio.load();
        }
        if (resetTime) seekWhenReady(audio, 0);
        applyVolume(audio);
        if (data.audio_playing) tryPlay(audio);
        else audio.pause();
      };

      // Fond d'ambiance du mode coach (réf. mission "associer un fond animé
      // à chaque musique") : peut désormais changer À CHAQUE PISTE, pas
      // seulement au lancement du cours/de la playlist ou à un changement
      // manuel — appelé aussi depuis les causes de navigation de piste
      // ci-dessous. Ne recharge que si la source a réellement changé (deux
      // pistes consécutives partageant le même fond ne doivent pas
      // redémarrer sa boucle).
      const syncBackgroundLayer = () => {
        if (!bgVideo) return;
        if (!backgroundId || backgroundIsImage) {
          unloadMedia(bgVideo);
          return;
        }
        const bgSrc = getApiUrl(`/backgrounds/${backgroundId}/stream`);
        if (!bgVideo.src || !bgVideo.src.endsWith(bgSrc)) {
          bgVideo.src = bgSrc;
          bgVideo.load();
          // Réf. correctif "fond animé non mis en pause avec la musique" :
          // changer de fond PENDANT une pause (ex. depuis le sélecteur de
          // l'interface coach) ne doit pas relancer sa lecture tout seul.
          if (data.audio_playing) bgVideo.play().catch(() => {});
        }
      };

      switch (cause) {
        case "sync": {
          // Resynchronisation (reconnexion, redémarrage du serveur) : on
          // décharge d'abord tout média que l'état serveur ne référence plus,
          // sinon un cours chargé avant un redémarrage backend continuerait
          // de jouer alors que le serveur est repassé en attente. Pas de
          // rejeu de l'animation de lancement ici (elle n'est déclenchée que
          // par la cause "load" elle-même) : ce client rejoint directement
          // l'état réel du cours en cours, avance ou non.
          setIntroActive(false);
          if (!data.current_video) unloadMedia(video);
          if (!backgroundId || backgroundIsImage) unloadMedia(bgVideo);
          if (!data.current_audio_course) unloadMedia(audio);
          if (backgroundId && !backgroundIsImage && bgVideo) {
            const bgSrc = getApiUrl(`/backgrounds/${backgroundId}/stream`);
            if (!bgVideo.src || !bgVideo.src.endsWith(bgSrc)) bgVideo.src = bgSrc;
            // Réf. correctif "fond animé non mis en pause avec la musique" :
            // en mode coach, le fond suit l'état pause de la piste audio
            // plutôt qu'un autoplay inconditionnel — sans ce garde-fou, une
            // reconnexion (cause "sync") pendant une pause relançait le fond
            // tout seul. Hors mode coach (fond animé seul, pas de notion de
            // pause), il continue de démarrer directement.
            if (!data.current_audio_course || data.audio_playing) bgVideo.play().catch(() => {});
            else bgVideo.pause();
          }
          if (data.current_audio_course && audio && currentTrack) {
            const aSrc = getApiUrl(`/audio/tracks/${currentTrack.id}/stream`);
            // Ne recharger la piste audio que si la source a réellement changé
            // (réf. Bug 5 / B1b) : un sync de reconnexion ne doit pas remettre
            // à zéro une piste déjà en cours de lecture.
            if (!audio.src || !audio.src.endsWith(aSrc)) {
              audio.src = aSrc;
              audio.load();
              seekWhenReady(audio, data.audio_position_seconds);
            }
            applyVolume(audio);
            if (data.audio_playing) tryPlay(audio);
          }
          if (!video || !data.current_video) break;
          const src = getApiUrl(`/videos/${data.current_video.id}/stream`);
          applyVolume(video);
          video.playbackRate = data.speed;
          const targetPosition = data.position_seconds;
          const targetPlaying = data.state === "playing";
          // Ne recharger la vidéo que si la source a changé (réf. Bug 1 / B1a).
          // Appeler video.load() sur la même source interrompt la lecture en
          // cours et peut provoquer une reprise non voulue via le listener canplay.
          const srcChanged = !video.src || !video.src.endsWith(src);
          if (srcChanged) {
            video.src = src;
            video.load();
            const onVideoReady = () => {
              video.removeEventListener("canplay", onVideoReady);
              video.currentTime = targetPosition;
              if (targetPlaying) tryPlay(video);
            };
            video.addEventListener("canplay", onVideoReady);
          } else {
            // Même source : NE PAS recaler le kiosk PRIMAIRE (correctif
            // "saccades sur le réseau"). Le primaire est la SOURCE de la
            // position — il la rapporte au serveur avec ~1 s de retard (report
            // throttlé à 1/s). Se recaler sur cette position à chaque resync
            // (15 s) ou reconnexion le faisait sauter ~1 s en arrière, d'où des
            // saccades périodiques (aggravées par les reconnexions WS sur un
            // lien réseau instable). Seuls les miroirs se recalent, et
            // uniquement au-delà d'un seuil de dérive — même logique que
            // "position_tick" ci-dessous.
            if (!isPrimaryRef.current && Math.abs(video.currentTime - targetPosition) > 1.5) {
              seekWhenReady(video, targetPosition);
            }
            if (targetPlaying && video.paused) tryPlay(video);
            else if (!targetPlaying && !video.paused) video.pause();
          }
          break;
        }
        case "position_tick": {
          // Correctif "kiosk réseau jamais synchronisé / vidéo figée" :
          // jusqu'ici ce cause n'était traité par aucun cas ci-dessous — un
          // kiosk miroir (deuxième écran réseau, réf. rôle primaire/miroir)
          // recevait bien l'évènement mais son <video> local n'était jamais
          // corrigé, restant figé sur la position connue à sa connexion. Un
          // seuil de dérive évite de saccader une lecture déjà correcte par
          // des recalages incessants (~4 fois par seconde côté serveur).
          // Le kiosk primaire, source de cette position, ne se recale jamais.
          if (isPrimaryRef.current) break;
          const DRIFT_THRESHOLD_SECONDS = 1.5;
          if (data.current_audio_course && audio && currentTrack) {
            if (Math.abs(audio.currentTime - data.audio_position_seconds) > DRIFT_THRESHOLD_SECONDS) {
              seekWhenReady(audio, data.audio_position_seconds);
            }
            if (data.audio_playing && audio.paused) tryPlay(audio);
            else if (!data.audio_playing && !audio.paused) audio.pause();
            // Réf. correctif "fond animé non mis en pause avec la musique" :
            // un kiosk miroir qui rejoint APRÈS le play/pause d'origine (ou
            // qui rate l'évènement) doit aussi rattraper l'état pause du
            // fond via ce tick périodique, pas seulement via les causes
            // play/pause elles-mêmes.
            if (bgVideo && bgVideo.src) {
              if (data.audio_playing && bgVideo.paused) tryPlay(bgVideo);
              else if (!data.audio_playing && !bgVideo.paused) bgVideo.pause();
            }
          }
          if (video && data.current_video) {
            const targetPlaying = data.state === "playing";
            if (Math.abs(video.currentTime - data.position_seconds) > DRIFT_THRESHOLD_SECONDS) {
              seekWhenReady(video, data.position_seconds);
            }
            if (targetPlaying && video.paused) tryPlay(video);
            else if (!targetPlaying && !video.paused) video.pause();
          }
          break;
        }
        case "load": {
          // Un cours vidéo prend le relais : le serveur a déjà vidé fond animé
          // et mode coach de son état, on décharge leurs éléments média ici.
          unloadMedia(bgVideo);
          unloadMedia(audio);
          if (!video || !data.current_video) break;
          video.src = getApiUrl(`/videos/${data.current_video.id}/stream`);
          // Pas d'assignation explicite de currentTime ici (réf. correctif
          // "le cours sur la télé réseau ne se lance jamais, ni l'intro") :
          // une nouvelle src remet déjà la position à 0 nativement, et
          // l'assigner nous-mêmes avant HAVE_METADATA lève une exception
          // dans certains navigateurs/WebView embarqués — exactement le même
          // piège que seekWhenReady évite plus haut pour le cas "sync". Une
          // exception ici casserait silencieusement tout le reste du bloc, y
          // compris le tryPlay() qui lance réellement la lecture.
          applyVolume(video);
          video.playbackRate = data.speed;
          video.load();
          // Pacing du lancement (réf. mission "la vidéo de lancement suffit à
          // cadencer le lancement") : sur l'écran câblé, on joue Lancement.mp4
          // en overlay et c'est SA fin (onEnded) qui déclenche tryPlay(video)
          // ci-dessous.
          //
          // PAS sur le réseau (réf. correctif "critique kiosk/réseau — reste
          // gelé sur la première frame") : même une fois l'intro elle-même
          // protégée contre la mise en tampon (cf. onCanPlay plus bas), faire
          // dépendre le démarrage du COURS de la fin d'une SECONDE vidéo
          // (l'intro) ajoute un aller-retour de bufferisation de plus avant
          // que quoi que ce soit de réel ne s'affiche sur un appareil réseau
          // dont la bande passante est imprévisible — c'est justement cette
          // couche intermédiaire qui restait bloquée. Sur le réseau, on lance
          // donc directement le cours réel : il s'affiche dès que le
          // navigateur a assez mis en tampon pour peindre une image, sans
          // compte à rebours ni animation intercalée.
          if (play_intro && intro && channel === "cable") {
            const introAlreadyReady = intro.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
            setIntroReady(introAlreadyReady);
            setIntroActive(true);
            // Contrairement à `video`, `intro` garde la même src d'un cours à
            // l'autre : sa position ne revient donc pas à 0 toute seule et
            // doit être remise explicitement, mais via seekWhenReady pour ne
            // pas re-tomber dans le piège pré-métadonnées.
            seekWhenReady(intro, 0);
            intro.muted = false;
            if (introAlreadyReady) tryPlay(intro);
          } else {
            setIntroActive(false);
            tryPlay(video);
          }
          break;
        }
        case "load_background": {
          // Un fond (animé ou figé) prend le relais sur toute lecture en cours.
          unloadMedia(video);
          unloadMedia(audio);
          if (backgroundIsImage) {
            // Le fond figé est rendu par l'<img> du JSX, rien à charger ici.
            unloadMedia(bgVideo);
            break;
          }
          if (!bgVideo || !data.current_background) break;
          bgVideo.src = getApiUrl(`/backgrounds/${data.current_background.id}/stream`);
          bgVideo.load();
          bgVideo.play().catch(() => {});
          break;
        }
        case "load_audio_course":
        case "audio_set_background": {
          // Le mode coach prend le relais (ou change de fond en direct) : la
          // vidéo de cours éventuellement en lecture doit être déchargée, pas
          // seulement masquée.
          unloadMedia(video);
          syncBackgroundLayer();
          if (cause === "load_audio_course") syncAudioToTrack(true);
          break;
        }
        case "audio_next_track":
        case "audio_previous_track":
        case "audio_jump_to_track":
        case "audio_restart_track":
          // Réf. mission "associer un fond animé à chaque musique" : chaque
          // piste peut avoir son propre fond, à ressynchroniser à chaque
          // changement de piste — pas seulement au lancement du cours.
          syncBackgroundLayer();
          syncAudioToTrack(true);
          break;
        case "play":
          if (data.current_audio_course) {
            tryPlay(audio);
            // Réf. correctif "en pause, seule la musique s'arrête, pas le
            // fond animé" : le fond du mode coach (bgVideo) suit maintenant
            // le même play/pause que la piste audio, dans les deux sens.
            if (bgVideo && bgVideo.src) tryPlay(bgVideo);
          } else {
            tryPlay(video);
          }
          break;
        case "pause":
          if (data.current_audio_course) {
            audio?.pause();
            // Voir le commentaire du cas "play" ci-dessus : avant ce
            // correctif, le fond animé continuait de boucler derrière la
            // musique en pause.
            bgVideo?.pause();
          } else {
            video?.pause();
          }
          break;
        case "stop":
          setIntroActive(false);
          if (intro) intro.pause();
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
          // Noms d'icônes Material Symbols (réf. mission "retire tous les
          // emojis") — rendus par <Icon> dans le JSX de l'OSD.
          showOsd({
            icon: "fast_forward",
            label: `${formatTime(data.position_seconds)} / ${formatTime(data.current_video?.duration_seconds)}`,
          });
          break;
        case "volume":
          if (video) applyVolume(video);
          if (audio) applyVolume(audio);
          showOsd({ icon: "volume_up", label: `${data.volume}%` });
          break;
        case "speed":
          if (video) video.playbackRate = data.speed;
          showOsd({ icon: "speed", label: `${data.speed.toFixed(2)}x` });
          break;
        default:
          break;
      }
    },
    [showOsd, tryPlay]
  );

  const { state, sendCommand, isPrimary, displayOutputCable, displayOutputNetwork } = usePlaybackSocket(handleEvent, "kiosk", channel);
  useEffect(() => {
    isPrimaryRef.current = isPrimary;
  }, [isPrimary]);
  // Bascule kiosk/cinéma par canal (réf. canaux indépendants) : cette page
  // navigue vers /cinema si SON canal (câblé si c'est l'écran du Wyse,
  // réseau sinon) est passé en mode cinéma.
  useDisplayOutputRedirect("kiosk", displayOutputCable, displayOutputNetwork);

  // Animation de lancement Lancement.mp4 (réf. mission "la vidéo de
  // lancement suffit à cadencer le lancement") : plus de compte à rebours
  // serveur — `introActive` est piloté directement par handleEvent (cause
  // "load", cf. ci-dessus) et sa propre fin (onEnded, plus bas dans le JSX)
  // déclenche le démarrage du cours réel. Le pacing est donc entièrement
  // celui de cette vidéo, pas d'un minuteur découplé.
  const [introActive, setIntroActive] = useState(false);
  // introReady (réf. retour utilisateur "l'animation ne se lance pas sur le
  // réseau", 2026-07-20) : sur une connexion réseau lente/chargée, la vidéo
  // (~13 Mo) peut ne pas avoir bufferisé la moindre image tout de suite —
  // révéler ce calque avant ça produirait un écran NOIR (l'élément <video>
  // existe mais n'a rien à peindre). On ne le révèle donc qu'une fois
  // l'évènement `canplay` reçu, en laissant l'écran d'attente précédent
  // visible entre-temps plutôt qu'un noir garanti.
  const [introReady, setIntroReady] = useState(false);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !isPrimary) return;
    const now = Date.now();
    if (now - lastReportRef.current > 1000) {
      lastReportRef.current = now;
      sendCommand("report_position", { position_seconds: video.currentTime });
    }
  };

  const handleAudioTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || !isPrimary) return;
    const now = Date.now();
    if (now - lastAudioReportRef.current > 1000) {
      lastAudioReportRef.current = now;
      sendCommand("audio_report_position", { position_seconds: audio.currentTime });
    }
  };

  const program = state.current_video?.program ?? state.current_audio_course?.program ?? undefined;
  // Couleur du thème plutôt que du programme du cours (réf. correctif
  // "couleurs hardcodées associées à un cours" — le thème prime désormais,
  // ex. "En pause" restait rouge RPM même sur un cours Sprint ou un thème
  // clair).
  const programAccent = "var(--accent-primary)";
  const isIdle = state.state === "waiting" || state.state === "offline";
  // L'animation de lancement occulte la vraie vidéo tant qu'elle joue (réf.
  // "la vidéo de lancement suffit à cadencer le lancement") : le serveur
  // passe désormais directement en "playing" au chargement, sans état
  // intermédiaire — c'est ce drapeau LOCAL qui retarde la révélation.
  const isVideoLayer = (state.state === "playing" || state.state === "paused") && !introActive;
  const isPaused = state.state === "paused";
  const isCoachMode = state.state === "coach_mode";
  const coachBackgroundId = state.current_background?.id ?? state.current_audio_course?.background_id ?? null;
  const backgroundIsImage = state.current_background?.is_image ?? false;
  const backgroundLayerActive = state.state === "background" || (isCoachMode && coachBackgroundId !== null);
  const currentTrack =
    state.audio_tracks && state.audio_track_index !== null && state.audio_track_index !== undefined
      ? state.audio_tracks[state.audio_track_index]
      : null;
  const audioTrackRemaining = currentTrack?.duration_seconds
    ? Math.max(0, currentTrack.duration_seconds - state.audio_position_seconds)
    : null;
  const audioTrackProgress = currentTrack?.duration_seconds
    ? Math.min(100, (state.audio_position_seconds / currentTrack.duration_seconds) * 100)
    : 0;

  const nextCourseRemaining = nextCourse
    ? Math.max(0, (new Date(nextCourse.run_at).getTime() - now.getTime()) / 1000)
    : null;

  const duration = state.current_video?.duration_seconds ?? 0;
  const pauseProgressPercent = duration > 0 ? Math.min(100, (state.position_seconds / duration) * 100) : 0;

  const nextPlaylistItem = state.playlist_items && state.playlist_index !== null && state.playlist_index !== undefined
    ? state.playlist_items[state.playlist_index + 1]
    : null;

  return (
    <div className="kiosk-root">
      {/* Écran d'attente (réf. mission logo + prochain cours) : habillage figé
          rendu nativement — horloge, logo imposant et bloc « prochain cours ».
          Les tailles de texte sont en `cqh` (% de la hauteur de .kiosk-root,
          qui porte container-type: size), et les positions en % reprennent à
          l'identique l'ancien habillage. */}
      <div className={`kiosk-layer kiosk-waiting ${isIdle || (introActive && !introReady) ? "visible" : ""}`}>
        <div className="kiosk-waiting-stage">
          <div className="kiosk-waiting-cell" style={{ left: "20%", top: "20%", width: "60%", height: "14%" }}>
            <span className="kiosk-waiting-clock" style={{ fontSize: "8cqh" }}>{formatClock(now)}</span>
          </div>
          <div className="kiosk-waiting-cell" style={{ left: "28%", top: "37%", width: "44%", height: "16%" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- logo statique de l'app, pas un asset buildé */}
            <img src="/logo.png" alt="Logo" className="app-logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>
          <div className="kiosk-waiting-cell" style={{ left: "15%", top: "56%", width: "70%", height: "30%" }}>
            <div className="kiosk-waiting-next">
              {nextCourse ? (
                <>
                  <span className="kiosk-waiting-next-label" style={{ fontSize: "calc(2.2cqh * 0.45)" }}>
                    {t("kiosk.nextCourseLabel")}
                  </span>
                  <span className="kiosk-waiting-next-title" style={{ fontSize: "2.2cqh" }}>
                    {nextCourse.title ?? t("kiosk.scheduledCourseFallback")}
                  </span>
                  <span className="kiosk-waiting-next-countdown" style={{ fontSize: "calc(2.2cqh * 1.3)" }}>
                    {formatDuration(nextCourseRemaining ?? 0)}
                  </span>
                </>
              ) : (
                <span className="kiosk-waiting-next-empty" style={{ fontSize: "calc(2.2cqh * 0.55)" }}>
                  {t("kiosk.waitingForNextCourse")}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={`kiosk-layer kiosk-playlist-waiting ${state.state === "playlist_waiting" ? "visible" : ""}`}>
        <AppLogo size={110} className="kiosk-waiting-logo" />
        <span className="kiosk-clock">{formatClock(now)}</span>
        <div className="kiosk-playlist-info">
          <span className="kiosk-playlist-label">{t("kiosk.activePlaylist")}</span>
          <span className="kiosk-playlist-name">{state.playlist_name}</span>
        </div>
        {nextPlaylistItem ? (
          <div className="kiosk-next-course">
            <span className="kiosk-next-course-label">{t("kiosk.nextCourseLabel")}</span>
            <span className="kiosk-next-course-title">{nextPlaylistItem.title}</span>
            <span className="kiosk-playlist-countdown-number" style={{ color: "var(--accent-primary)" }}>
              {Math.ceil(state.playlist_waiting_remaining ?? 0)}
            </span>
          </div>
        ) : (
          <span className="kiosk-waiting-sub">{t("kiosk.playlistEnd")}</span>
        )}
      </div>

      {/* Animation de lancement (réf. mission "la vidéo de lancement suffit à
          cadencer le lancement") : jouée en overlay avant chaque cours lancé
          explicitement (pas entre deux vidéos d'une même playlist). C'est sa
          propre fin (onEnded) qui démarre le cours réel — plus de minuteur
          serveur découplé de sa durée. */}
      <div className={`kiosk-layer kiosk-countdown ${introActive && introReady ? "visible" : ""}`}>
        <video
          ref={introRef}
          className="kiosk-video"
          src="/lancement.mp4"
          preload="auto"
          playsInline
          onCanPlay={() => {
            // Démarre la lecture ICI plutôt qu'au moment du "load" (voir
            // handleEvent ci-dessus) quand l'intro n'était pas encore prête :
            // c'est exactement l'instant où la couche devient visible, donc
            // celui où sa lecture doit réellement commencer.
            setIntroReady(true);
            tryPlay(introRef.current);
          }}
          onEnded={() => {
            setIntroActive(false);
            tryPlay(videoRef.current);
          }}
        />
      </div>

      <div className={`kiosk-layer kiosk-video-layer ${isVideoLayer ? "visible" : ""}`}>
        <video
          ref={videoRef}
          className="kiosk-video"
          onTimeUpdate={handleTimeUpdate}
          onEnded={() => sendCommand("video_ended")}
          // preload="auto" : demande au navigateur de mettre en tampon en
          // avance plutôt qu'au tout dernier moment — atténue les saccades sur
          // l'écran RÉSEAU (lecture par-dessus le LAN/Wi-Fi, contrairement au
          // câblé servi en loopback 127.0.0.1). Le <video> du cinéma l'a déjà.
          preload="auto"
          playsInline
        />
      </div>

      <div className={`kiosk-layer kiosk-video-layer ${backgroundLayerActive && !backgroundIsImage ? "visible" : ""}`}>
        <video ref={bgVideoRef} className="kiosk-video" loop muted playsInline autoPlay />
      </div>

      {/* Fond figé (png/jpg/webp) : même couche plein écran que les fonds
          animés, mais rendue par une simple image (réf. mission "fond figé
          ou animé depuis le mode coach"). */}
      <div className={`kiosk-layer kiosk-video-layer ${backgroundLayerActive && backgroundIsImage ? "visible" : ""}`}>
        {backgroundIsImage && coachBackgroundId !== null && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="kiosk-video" src={getApiUrl(`/backgrounds/${coachBackgroundId}/stream`)} alt="" />
        )}
      </div>

      <div
        className={`kiosk-layer kiosk-coach-mode ${isCoachMode ? "visible" : ""} ${
          coachBackgroundId !== null ? "with-background" : ""
        }`}
      >
        <audio
          ref={audioRef}
          onTimeUpdate={handleAudioTimeUpdate}
          onEnded={() => sendCommand("audio_track_ended")}
        />
        <div
          className="coach-stage"
          style={{ "--coach-accent": programAccent } as React.CSSProperties}
        >
          <div className="coach-stage-glow" />
          <span className="coach-stage-eyebrow">{t("kiosk.coachModeLabel")}</span>
          <span className="coach-stage-course">{state.current_audio_course?.title}</span>
          {currentTrack ? (
            <>
              <span className="coach-stage-track-label">
                {t("kiosk.trackLabel", {
                  index: (state.audio_track_index ?? 0) + 1,
                  total: state.audio_tracks ? ` / ${state.audio_tracks.length}` : "",
                })}
              </span>
              <h1 className="coach-stage-track-title">{currentTrack.title}</h1>
              <div className="coach-stage-progress-track">
                <div className="coach-stage-progress-fill" style={{ width: `${audioTrackProgress}%` }} />
              </div>
              <div className="coach-stage-meta-row">
                <span className="coach-stage-time">{formatTime(state.audio_position_seconds)}</span>
                {!state.audio_playing && <span className="coach-stage-paused-badge">{t("kiosk.paused")}</span>}
                <span className="coach-stage-time">
                  {audioTrackRemaining !== null ? `-${formatTime(audioTrackRemaining)}` : "--:--"}
                </span>
              </div>
              {state.audio_chain_wait_remaining !== null && (
                <span className="coach-stage-next-hint">
                  {t("kiosk.nextTrackIn", { seconds: Math.ceil(state.audio_chain_wait_remaining ?? 0) })}
                </span>
              )}
            </>
          ) : (
            <span className="coach-stage-track-label">{t("kiosk.noTrack")}</span>
          )}
        </div>
      </div>

      {isPaused && (
        // Écran de pause façon plateforme de streaming (réf. mission UI/UX) :
        // vidéo assombrie visible en fond (pas de coupure brutale), gros
        // bouton central pour reprendre, bandeau d'info en bas à gauche
        // (logo, titre, programme, position), barre de progression pleine
        // largeur au tout bord inférieur — mise en page dédiée dont le texte
        // ne chevauche pas ces éléments (réf. correctif "informations qui se
        // chevauchent").
        <div className="pause-overlay visible">
          <div className="pause-overlay-glow" />
          <button
            className="pause-resume-btn"
            onClick={() => sendCommand("play")}
            title={t("kiosk.resume")}
          >
            <Icon name="play_arrow" size={44} filled />
          </button>
          <div className="pause-info-bar">
            <AppLogo size={64} className="pause-info-logo" />
            <div className="pause-info-text">
              <span className="pause-info-eyebrow" style={{ color: programAccent }}>
                {t("kiosk.pausedLabel")}
              </span>
              <span className="pause-info-title">{state.current_video?.title}</span>
              <span className="pause-info-meta">
                {[program, `${formatTime(state.position_seconds)} / ${formatTime(duration)}`]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          </div>
          <div className="pause-progress-track">
            <div className="pause-progress-fill" style={{ width: `${pauseProgressPercent}%` }} />
          </div>
        </div>
      )}

      {osd && (
        <div className="kiosk-osd">
          <Icon name={osd.icon} size={28} filled />
          <span className="kiosk-osd-label">{osd.label}</span>
        </div>
      )}

      {needsAudioUnlock && (
        <button className="kiosk-unlock-audio" onClick={handleUnlockAudio}>
          <Icon name="volume_off" size={22} />
          {t("kiosk.unlockAudioLabel")}
        </button>
      )}
    </div>
  );
}
