"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { isWiredDisplay, useDisplayOutputRedirect } from "@/lib/useDisplayOutputRedirect";
import { useHoverSound } from "@/lib/useHoverSound";
import { useThemeAccentForeground } from "@/lib/useThemeAccentForeground";
import Icon from "@/components/Icon";
import AppLogo from "@/components/AppLogo";

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
  }
  return `/api${path}`;
}

interface CinemaVideo {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  duration_seconds: number | null;
  thumbnail_path: string | null;
}

function formatTime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDurationMin(seconds: number | null) {
  if (!seconds) return "";
  return `${Math.round(seconds / 60)} min`;
}

function formatClock(date: Date) {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function thumbnailUrl(video: CinemaVideo): string | null {
  if (!video.thumbnail_path) return null;
  const filename = video.thumbnail_path.split("/").pop();
  return filename ? getApiUrl(`/thumbnails/${filename}`) : null;
}



// Délai d'inactivité souris avant de masquer la barre de contrôle en lecture.
const CONTROLS_HIDE_MS = 3000;
// "À suivre" (réf. mission cinéma) : délai avant lancement automatique du
// cours suggéré en fin de lecture, façon YouTube.
const UP_NEXT_AUTOPLAY_SECONDS = 5 * 60;
// "Scramble" de la suggestion à la une (réf. mission UI/UX) : nouveau tirage
// toutes les 15 minutes.
const SCRAMBLE_INTERVAL_MS = 15 * 60 * 1000;

type Phase = "grid" | "countdown" | "playing" | "ended";

// Fraction de la largeur visible parcourue à chaque clic sur une flèche.
const ROW_SCROLL_FRACTION = 0.85;

/**
 * Rangée horizontale avec flèches de défilement (réf. mission cinéma, point
 * 2) : remplace la dépendance à la barre de défilement native (peu visible,
 * malaisée à la souris) par des boutons gauche/droite façon Netflix. Chaque
 * rangée gère sa propre référence de scroll, d'où un composant dédié plutôt
 * qu'une simple boucle inline.
 */
// React.memo (réf. correctif "cinéma lent/lagué") : la grille de sélection
// reste montée (masquée en CSS) même pendant la lecture — sans mémoïsation,
// chaque mise à jour de position vidéo (plusieurs fois par seconde) forçait
// React à réconcilier toute la grille, invisible mais bien réelle dans le
// DOM, sur le CPU modeste du Wyse.
const CinemaRow = React.memo(function CinemaRow({
  programName,
  items,
  rowIndex,
  onSelect,
  onHover,
  coursesCountLabel,
}: {
  programName: string;
  items: CinemaVideo[];
  rowIndex: number;
  onSelect: (video: CinemaVideo) => void;
  onHover: () => void;
  coursesCountLabel: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = scrollRef.current;
    if (!el) return;
    const onResize = () => updateArrows();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateArrows, items.length]);

  const scrollBy = (direction: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * ROW_SCROLL_FRACTION, behavior: "smooth" });
  };

  return (
    <section className="cinema-row" style={{ animationDelay: `${rowIndex * 90}ms` }}>
      <div className="cinema-row-header">
        <h2 style={{ color: "var(--accent-primary)" }}>{programName}</h2>
        <span className="cinema-row-count">{coursesCountLabel}</span>
      </div>
      <div className="cinema-row-wrap">
        {canScrollLeft && (
          <button
            className="cinema-row-arrow cinema-row-arrow-left"
            onClick={() => scrollBy(-1)}
            aria-label="Précédent"
          >
            <Icon name="chevron_left" size={32} />
          </button>
        )}
        <div className="cinema-row-scroll" ref={scrollRef} onScroll={updateArrows}>
          {items.map((v, i) => {
            const thumb = thumbnailUrl(v);
            return (
              <button
                key={v.id}
                className="cinema-card"
                style={{ animationDelay: `${rowIndex * 90 + i * 45}ms` }}
                onClick={() => onSelect(v)}
                onMouseEnter={onHover}
                title={v.title}
              >
                <div className="cinema-card-thumb">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt="" loading="lazy" />
                  ) : (
                    <div className="cinema-card-thumb-fallback">
                      <Icon name="movie" size={40} color="var(--text-dim)" />
                    </div>
                  )}
                  <span className="cinema-card-play">
                    <Icon name="play_arrow" size={34} filled />
                  </span>
                  {v.duration_seconds ? (
                    <span className="cinema-card-duration">{formatDurationMin(v.duration_seconds)}</span>
                  ) : null}
                </div>
                <span className="cinema-card-title">{v.title}</span>
                <span className="cinema-card-meta">{v.release ?? ""}</span>
              </button>
            );
          })}
        </div>
        {canScrollRight && (
          <button
            className="cinema-row-arrow cinema-row-arrow-right"
            onClick={() => scrollBy(1)}
            aria-label="Suivant"
          >
            <Icon name="chevron_right" size={32} />
          </button>
        )}
      </div>
    </section>
  );
});

// Idem CinemaRow : mémoïsé pour ne pas réconcilier toute la liste "Tous les
// cours" (potentiellement longue) à chaque mise à jour de position vidéo.
const CinemaAllList = React.memo(function CinemaAllList({
  videos,
  onSelect,
  onHover,
}: {
  videos: CinemaVideo[];
  onSelect: (video: CinemaVideo) => void;
  onHover: () => void;
}) {
  return (
    <div className="cinema-all-grid">
      {videos.map((v, i) => {
        const thumb = thumbnailUrl(v);
        const accent = "var(--accent-primary)";
        return (
          <button
            key={v.id}
            className="cinema-all-item"
            style={{ animationDelay: `${i * 30}ms` }}
            onClick={() => onSelect(v)}
            onMouseEnter={onHover}
          >
            <div className="cinema-all-thumb">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" loading="lazy" />
              ) : (
                <Icon name="movie" size={22} color="var(--text-dim)" />
              )}
            </div>
            <div className="cinema-all-text">
              <span className="cinema-all-title">{v.title}</span>
              <span className="cinema-all-meta" style={{ color: accent }}>
                {[v.program, formatDurationMin(v.duration_seconds)].filter(Boolean).join(" · ")}
              </span>
            </div>
            <Icon name="play_circle" size={26} color="var(--text-dim)" />
          </button>
        );
      })}
    </div>
  );
});

/**
 * Interface cinéma adhérents (mission /cinema). Contrairement à /kiosk, la
 * lecture est ENTIÈREMENT LOCALE à cet onglet/appareil — aucune commande
 * n'est envoyée à l'état de lecture partagé du serveur (playback_manager).
 * C'est un choix architectural délibéré (réf. mission, point 2) : plusieurs
 * adhérents doivent pouvoir chacun choisir et regarder un cours différent en
 * même temps, sur leur propre téléphone ou sur l'écran câblé, sans qu'un
 * lancement en écrase un autre. Le flux vidéo (`/api/videos/{id}/stream`)
 * supporte nativement des lectures concurrentes indépendantes.
 *
 * La sortie reste pilotée depuis l'admin PAR CANAL (réf. canaux indépendants
 * câblé/réseau) : cette page écoute les deux évènements pour savoir si elle
 * doit céder la place à /kiosk, selon qu'elle tourne sur l'écran câblé du
 * Wyse ou sur un appareil du réseau.
 */
export default function CinemaPage() {
  const { t } = useAppSettings();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videos, setVideos] = useState<CinemaVideo[]>([]);
  const [phase, setPhase] = useState<Phase>("grid");
  const [selected, setSelected] = useState<CinemaVideo | null>(null);

  // Horloge de l'écran d'attente « bibliothèque vide » (voir plus bas) :
  // quand aucun cours n'est disponible, la vitrine n'a ni héros ni logo et se
  // réduisait à un mince texte sur fond noir — perçu comme un écran éteint sur
  // la TV. On affiche à la place un vrai écran d'attente (grand logo + heure).
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // Vidéo d'animation de lancement, rejouée du début à chaque sélection.
  // introReady : voir kiosk/page.tsx (même correctif, réf. retour utilisateur
  // "l'animation ne se lance pas sur le réseau") — sur une connexion lente,
  // ce calque peut ne rien avoir à peindre au tout début ; on ne le révèle
  // qu'une fois une image réellement décodée (`canplay`). C'est la fin de
  // cette vidéo (onEnded, réf. mission "la vidéo de lancement suffit à
  // cadencer le lancement") qui démarre le cours, pas un minuteur séparé.
  const introRef = useRef<HTMLVideoElement | null>(null);
  const [introReady, setIntroReady] = useState(false);
  useEffect(() => {
    const el = introRef.current;
    if (!el) return;
    if (phase === "countdown") {
      setIntroReady(el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
      el.currentTime = 0;
      el.muted = false;
      el.play().catch(() => {
        el.muted = true;
        el.play().catch(() => {});
      });
    } else {
      el.pause();
      setIntroReady(false);
    }
  }, [phase]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
  const [position, setPosition] = useState(0);
  // Dernière mise à jour de `position` (réf. correctif "cinéma lent/lagué") :
  // l'évènement natif `timeupdate` se déclenche plusieurs fois par seconde,
  // chaque déclenchement re-rendait tout le composant (dont la grille de
  // sélection masquée mais toujours montée). Limité à 1 fois/seconde,
  // largement suffisant pour l'affichage de la position.
  const lastPositionUpdateRef = useRef(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  // "À suivre" : suggestion aléatoire en fin de cours + compte à rebours
  // d'autoplay (annulable d'un clic, réf. mission).
  const [upNext, setUpNext] = useState<CinemaVideo | null>(null);
  const [upNextRemaining, setUpNextRemaining] = useState(UP_NEXT_AUTOPLAY_SECONDS);
  const upNextTaskRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Partagé avec le reste de l'app : la sortie active des deux canaux (pour
  // suivre la bascule kiosk/cinéma décidée depuis l'admin), et depuis la
  // mission "contrôler le cours en mode cinéma", un canal de supervision —
  // cette page RAPPORTE sa lecture locale (titre/position) et OBÉIT aux
  // commandes admin (play/pause/seek/stop). La lecture reste locale : le
  // playback_manager du serveur n'est jamais impliqué. Le canal suivi est
  // celui de CET appareil : câblé si écran du Wyse, réseau sinon.
  const [channel] = useState<"cable" | "network">(() => (isWiredDisplay() ? "cable" : "network"));
  // Implémentation réelle installée plus bas, une fois les handlers définis.
  const cinemaCmdRef = useRef<((action: string, positionSeconds: number) => void) | null>(null);
  const { displayOutputCable, displayOutputNetwork, sendCommand } = usePlaybackSocket(
    undefined,
    undefined,
    channel,
    (action, positionSeconds) => cinemaCmdRef.current?.(action, positionSeconds),
  );
  useDisplayOutputRedirect("cinema", displayOutputCable, displayOutputNetwork);
  // Son de survol des cartes de cours (réf. mission UI/UX).
  const playHoverSound = useHoverSound("/sounds/survole.mp3");

  // Rafraîchissement LIVE de la vitrine : la page cinéma est un écran passif
  // qui ne se recharge jamais ; sans ce sondage, un cours importé depuis un
  // autre poste n'apparaissait qu'après un rechargement manuel (réf. « les
  // cours ne se mettent pas à jour en direct »). On ne remplace l'état que si
  // la liste a réellement changé, pour ne pas re-rendre la vitrine (ni couper
  // un survol/scroll) à chaque tick.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(getApiUrl("/videos?sort_by=title&order=asc"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : []))
        .then((data: CinemaVideo[]) => {
          if (cancelled || !Array.isArray(data)) return;
          setVideos((prev) =>
            prev.length === data.length && prev.every((v, i) => v.id === data[i]?.id) ? prev : data,
          );
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const clearUpNextTask = () => {
    if (upNextTaskRef.current) clearInterval(upNextTaskRef.current);
    upNextTaskRef.current = null;
  };

  const startPlayback = useCallback((video: CinemaVideo) => {
    const el = videoRef.current;
    if (!el) return;
    el.src = getApiUrl(`/videos/${video.id}/stream`);
    el.currentTime = 0;
    el.load();
    setNeedsTapToPlay(false);
    el.play()
      .then(() => setIsPlaying(true))
      .catch(() => {
        // Autoplay refusé par le navigateur (fréquent hors kiosk Chromium,
        // ex. Safari mobile sans interaction directe) : on affiche un bouton
        // de lancement manuel plutôt que de rester silencieusement figé.
        setIsPlaying(false);
        setNeedsTapToPlay(true);
      });
  }, []);

  // Lancement direct sans compte à rebours (bouton "Lancer maintenant" et
  // autoplay du "À suivre" : l'attente a déjà eu lieu, pas de double délai).
  const playImmediately = useCallback(
    (video: CinemaVideo) => {
      clearUpNextTask();
      setUpNext(null);
      setSelected(video);
      setPhase("playing");
      setPosition(0);
      startPlayback(video);
    },
    [startPlayback],
  );

  // useCallback (réf. correctif "cinéma lent/lagué") : une référence stable
  // permet à CinemaRow (React.memo ci-dessous) de ne PAS se re-rendre à
  // chaque tick de position vidéo — sans ça, chaque frappe de `onTimeUpdate`
  // recréait cette fonction, invalidant la mémoïsation et forçant React à
  // réconcilier toute la grille (potentiellement des dizaines de cartes),
  // pourtant masquée derrière la vidéo, sur le CPU/GPU modeste du Wyse.
  const handleSelect = useCallback((video: CinemaVideo) => {
    clearUpNextTask();
    setUpNext(null);
    setSelected(video);
    setPosition(0);
    // Animation de lancement (réf. mission "la vidéo de lancement suffit à
    // cadencer le lancement") : sa propre fin (onEnded, plus bas dans le
    // JSX) démarre la lecture — plus de minuteur découplé de sa durée.
    setPhase("countdown");
  }, []);

  const handleBackToMenu = useCallback(() => {
    clearUpNextTask();
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setPhase("grid");
    setSelected(null);
    setUpNext(null);
    setIsPlaying(false);
    setNeedsTapToPlay(false);
    setPosition(0);
  }, []);

  // Fin naturelle du cours : suggestion aléatoire façon YouTube parmi les
  // autres cours, lancée automatiquement après 5 minutes — un clic sur
  // "Retour au menu" annule, "Lancer maintenant" court-circuite l'attente.
  const handleEnded = useCallback(() => {
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setIsPlaying(false);
    const candidates = videos.filter((v) => v.id !== selected?.id);
    if (candidates.length === 0) {
      handleBackToMenu();
      return;
    }
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    setUpNext(next);
    setUpNextRemaining(UP_NEXT_AUTOPLAY_SECONDS);
    setPhase("ended");
    clearUpNextTask();
    upNextTaskRef.current = setInterval(() => {
      setUpNextRemaining((prev) => {
        if (prev <= 1) {
          clearUpNextTask();
          playImmediately(next);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [videos, selected, handleBackToMenu, playImmediately]);

  useEffect(() => () => clearUpNextTask(), []);

  const handlePlayPause = () => {
    const el = videoRef.current;
    if (!el) return;
    if (needsTapToPlay) {
      el.play().then(() => { setIsPlaying(true); setNeedsTapToPlay(false); }).catch(() => {});
      return;
    }
    if (el.paused) {
      el.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);

  // Commandes admin reçues du tableau de bord (réf. mission "contrôler le
  // cours en mode cinéma") : appliquées à la lecture LOCALE de cet appareil.
  useEffect(() => {
    cinemaCmdRef.current = (action, positionSeconds) => {
      const el = videoRef.current;
      if (action === "stop") {
        handleBackToMenu();
        return;
      }
      if (!el || phase !== "playing") return;
      if (action === "pause") {
        el.pause();
        setIsPlaying(false);
      } else if (action === "play") {
        el.play().then(() => setIsPlaying(true)).catch(() => {});
      } else if (action === "seek") {
        el.currentTime = positionSeconds;
        setPosition(positionSeconds);
      }
    };
  }, [phase, handleBackToMenu]);

  // Rapport périodique vers les tableaux de bord du canal : ce que joue CET
  // appareil. Un rapport "vide" est envoyé en quittant la lecture pour que
  // l'affichage admin s'efface immédiatement.
  //
  // reportNowRef (réf. "les boutons admin ne marchent pas à tous les coups") :
  // avec un rapport UNIQUEMENT périodique, l'admin qui pressait pause voyait
  // l'état "en lecture" persister jusqu'à 2 s — croyant le bouton sans effet,
  // il re-pressait et annulait sa propre commande. Les évènements onPlay/
  // onPause/onSeeked du <video> (plus bas) déclenchent désormais un rapport
  // IMMÉDIAT à chaque changement d'état réel, qu'il vienne d'une commande
  // admin ou d'une action locale de l'adhérent — l'admin voit l'effet en
  // ~100 ms. L'intervalle ne sert plus que de battement de fond.
  const reportNowRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (phase !== "playing") {
      reportNowRef.current = null;
      sendCommand("cinema_report", { title: null, playing: false, position_seconds: 0, duration_seconds: 0 });
      return;
    }
    const report = () => {
      const el = videoRef.current;
      sendCommand("cinema_report", {
        title: selected?.title ?? null,
        program: selected?.program ?? null,
        position_seconds: el?.currentTime ?? 0,
        duration_seconds: selected?.duration_seconds ?? el?.duration ?? 0,
        playing: el ? !el.paused : false,
      });
    };
    reportNowRef.current = report;
    report();
    const id = setInterval(report, 2000);
    return () => {
      reportNowRef.current = null;
      clearInterval(id);
    };
  }, [phase, selected, sendCommand]);

  const isPlayingLayer = phase === "playing";
  const isCountdown = phase === "countdown";
  const isEnded = phase === "ended";
  const showGrid = phase === "grid" || (phase === "countdown" && !introReady);

  const programAccent = "var(--accent-primary)";
  const duration = selected?.duration_seconds ?? 0;
  const displayPosition = seekDragValue ?? position;

  const rows = React.useMemo(() => {
    const byProgram = new Map<string, CinemaVideo[]>();
    for (const v of videos) {
      const key = v.program || t("cinema.otherProgram");
      if (!byProgram.has(key)) byProgram.set(key, []);
      byProgram.get(key)!.push(v);
    }
    return [...byProgram.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [videos, t]);

  // Cours "À la une" du héros : léger algorithme de "scramble" (réf. mission
  // UI/UX) qui fait tourner la suggestion toutes les 15 minutes plutôt
  // qu'une seule fois par jour — un adhérent qui repasse devant l'écran cinéma
  // plusieurs fois dans la journée voit une vitrine renouvelée. Le tirage
  // reste déterministe (hachage multiplicatif du créneau de 15 min, pas
  // Math.random) : tous les appareils affichent la même suggestion au même
  // moment, et un rafraîchissement de page ne fait pas sauter la sélection.
  const [scrambleTick, setScrambleTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setScrambleTick((v) => v + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const featured = React.useMemo(() => {
    if (videos.length === 0) return null;
    const bucket = Math.floor(Date.now() / SCRAMBLE_INTERVAL_MS);
    const hash = Math.abs((bucket * 2654435761) % videos.length);
    return videos[hash];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrambleTick ne sert qu'à forcer le recalcul périodique, Date.now() n'est pas une dépendance stable
  }, [videos, scrambleTick]);
  const featuredThumb = featured ? thumbnailUrl(featured) : null;

  const upNextThumb = upNext ? thumbnailUrl(upNext) : null;
  const upNextAccent = "var(--accent-primary)";
  // Progression de l'anneau d'autoplay (conic-gradient, 0 -> 360deg).
  const upNextProgressDeg = (1 - upNextRemaining / UP_NEXT_AUTOPLAY_SECONDS) * 360;

  // Fond du badge "À la une" et du bouton "Lancer le cours" (réf. mission
  // "intégrer au thème") : accent du THÈME actif, pas du programme — la
  // teinte change donc avec le thème choisi, identique pour tous les cours.
  const themeFg = useThemeAccentForeground();

  return (
    <div className="cinema-root" onMouseMove={isPlayingLayer ? wakeControls : undefined}>
      {/* Écran d'attente « bibliothèque vide » : recouvre la vitrine tant
          qu'aucun cours n'est importé (sinon la TV n'affiche qu'un mince texte
          sur fond noir — « rien » côté salle). Grand logo + heure + message,
          dans l'esprit de l'écran d'attente du poste radio/kiosk. */}
      {videos.length === 0 && (
        <div className="cinema-empty-screen">
          <AppLogo className="cinema-empty-logo" />
          <span className="cinema-empty-clock">{formatClock(now)}</span>
          <span className="cinema-empty-message">{t("cinema.empty")}</span>
        </div>
      )}

      {/* Vitrine de sélection : héros + rangées par programme + grille complète */}
      <div className={`cinema-layer cinema-grid-layer ${showGrid ? "visible" : ""}`}>
        {featured && (
          <section className="cinema-hero">
            {featuredThumb && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="cinema-hero-backdrop" src={featuredThumb} alt="" />
            )}
            <div className="cinema-hero-scrim" />
            <div className="cinema-hero-content">
              <AppLogo size={72} className="cinema-brand" />
              <span className="cinema-hero-badge" style={{ color: themeFg }}>{t("cinema.featured")}</span>
              <h1 className="cinema-hero-title">{featured.title}</h1>
              <p className="cinema-hero-meta">
                {[featured.program, featured.release, formatDurationMin(featured.duration_seconds)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <button className="cinema-hero-play" style={{ color: themeFg }} onClick={() => handleSelect(featured)}>
                <Icon name="play_arrow" size={26} color={themeFg} filled />
                {t("cinema.launchCourse")}
              </button>
            </div>
          </section>
        )}

        <div className="cinema-sections">
          <p className="cinema-subtitle">{t("cinema.subtitle")}</p>
          {rows.length === 0 && <p className="cinema-empty">{t("cinema.empty")}</p>}

          {rows.map(([programName, items], rowIndex) => (
            <CinemaRow
              key={programName}
              programName={programName}
              items={items}
              rowIndex={rowIndex}
              onSelect={handleSelect}
              onHover={playHoverSound}
              coursesCountLabel={t("cinema.coursesCount", { count: items.length })}
            />
          ))}

          {videos.length > 0 && (
            <section className="cinema-all">
              <h2>{t("cinema.allCourses")}</h2>
              <CinemaAllList videos={videos} onSelect={handleSelect} onHover={playHoverSound} />
            </section>
          )}
        </div>
      </div>

      {/* Animation de lancement (réf. mission "la vidéo de lancement suffit
          à cadencer le lancement") : sa propre fin (onEnded) démarre le
          cours choisi, plus de compte à rebours minuté séparément. */}
      <div className={`cinema-layer cinema-countdown ${isCountdown && introReady ? "visible" : ""}`}>
        <video
          ref={introRef}
          className="cinema-video"
          src="/lancement.mp4"
          preload="auto"
          playsInline
          onCanPlay={() => setIntroReady(true)}
          onEnded={() => {
            if (selected) {
              setPhase("playing");
              startPlayback(selected);
            }
          }}
        />
      </div>

      {/* Lecture vidéo plein écran, locale à cet appareil */}
      <div className={`cinema-layer cinema-video-layer ${isPlayingLayer ? "visible" : ""}`}>
        <video
          ref={videoRef}
          className="cinema-video"
          onTimeUpdate={(e) => {
            const now = Date.now();
            if (now - lastPositionUpdateRef.current < 1000) return;
            lastPositionUpdateRef.current = now;
            setPosition(e.currentTarget.currentTime);
          }}
          onEnded={handleEnded}
          onPlay={() => {
            setIsPlaying(true);
            reportNowRef.current?.();
          }}
          onPause={() => {
            setIsPlaying(false);
            reportNowRef.current?.();
          }}
          onSeeked={() => reportNowRef.current?.()}
          onClick={handlePlayPause}
          playsInline
        />
        {needsTapToPlay && (
          <button className="cinema-tap-to-play" onClick={handlePlayPause}>
            <Icon name="play_arrow" size={56} filled />
            <span>{t("cinema.play")}</span>
          </button>
        )}
        <div className={`cinema-controls ${isPlayingLayer && (controlsVisible || !isPlaying) ? "visible" : ""}`}>
          {/* Correctif "mention du cours en double" : le titre était déjà
              répété ici en haut à droite alors qu'il apparaît sur la vidéo
              elle-même (habillage du cours) — retiré, ne garde que le retour
              au menu. */}
          <div className="cinema-controls-top">
            <button className="cinema-ctl-btn" onClick={handleBackToMenu} title={t("cinema.backToMenu")}>
              <Icon name="arrow_back" size={26} />
              <span>{t("cinema.backToMenu")}</span>
            </button>
          </div>
          <div className="cinema-controls-bottom">
            <button
              className="cinema-ctl-btn cinema-ctl-round"
              onClick={handlePlayPause}
              title={isPlaying ? t("cinema.pause") : t("cinema.play")}
            >
              <Icon name={isPlaying ? "pause" : "play_arrow"} size={30} filled />
            </button>
            <span className="cinema-time">{formatTime(displayPosition)}</span>
            <input
              type="range"
              className="cinema-seek"
              min={0}
              max={duration || 0}
              step={1}
              value={Math.min(displayPosition, duration || 0)}
              onChange={(e) => setSeekDragValue(Number(e.target.value))}
              onMouseUp={(e) => {
                const value = Number((e.target as HTMLInputElement).value);
                setSeekDragValue(null);
                if (videoRef.current) videoRef.current.currentTime = value;
                setPosition(value);
              }}
              style={{ accentColor: programAccent }}
            />
            <span className="cinema-time">{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {/* Fin de cours : suggestion "À suivre" avec autoplay annulable */}
      <div className={`cinema-layer cinema-upnext ${isEnded ? "visible" : ""}`}>
        {upNext && (
          <div className="cinema-upnext-card" style={{ "--upnext-accent": upNextAccent } as React.CSSProperties}>
            <span className="cinema-upnext-label">{t("cinema.upNext")}</span>
            <button className="cinema-upnext-thumb" onClick={() => playImmediately(upNext)} title={t("cinema.playNow")}>
              {upNextThumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={upNextThumb} alt="" />
              ) : (
                <Icon name="movie" size={48} color="var(--text-dim)" />
              )}
              <span
                className="cinema-upnext-ring"
                style={{ background: `conic-gradient(var(--upnext-accent) ${upNextProgressDeg}deg, rgba(255,255,255,0.18) 0deg)` }}
              >
                <span className="cinema-upnext-ring-inner">
                  <Icon name="play_arrow" size={34} filled />
                </span>
              </span>
            </button>
            <h2 className="cinema-upnext-title">{upNext.title}</h2>
            <p className="cinema-upnext-meta">
              {[upNext.program, upNext.release, formatDurationMin(upNext.duration_seconds)].filter(Boolean).join(" · ")}
            </p>
            <p className="cinema-upnext-autoplay">
              {t("cinema.autoPlayIn", { time: formatTime(upNextRemaining) })}
            </p>
            <div className="cinema-upnext-actions">
              <button className="cinema-hero-play" style={{ color: themeFg }} onClick={() => playImmediately(upNext)}>
                <Icon name="play_arrow" size={22} color={themeFg} filled />
                {t("cinema.playNow")}
              </button>
              <button className="cinema-ctl-btn" onClick={handleBackToMenu}>
                <Icon name="arrow_back" size={20} color="currentColor" />
                {t("cinema.backToMenu")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
