"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PlaybackStateValue =
  | "waiting"
  | "playing"
  | "paused"
  | "coach_mode"
  | "offline"
  | "playlist_waiting"
  | "background";

export interface PlaybackVideo {
  id: number;
  title: string;
  duration_seconds: number | null;
  program?: string | null;
  thumbnail_url?: string | null;
}

export interface PlaybackBackground {
  id: number;
  title: string;
  /** Fond figé (png/jpg/webp) plutôt qu'une boucle vidéo — rendu via <img>
   * côté kiosk (réf. mission "fond figé ou animé depuis le mode coach"). */
  is_image?: boolean;
}

export type AudioChainMode = "auto" | "timer" | "manual";

/** Représente aussi bien un cours audio isolé qu'une playlist audio lancée
 * (réf. mission "playlists spéciales... des musiques de plusieurs RPM
 * différents") : une playlist est traitée côté serveur comme un cours
 * virtuel dont les pistes viennent de plusieurs cours (program=null dans ce
 * cas, faute de programme unique). */
export interface PlaybackAudioCourse {
  id: number;
  title: string;
  program: string | null;
  background_id: number | null;
}

export interface PlaybackAudioTrack {
  id: number;
  number: number | null;
  title: string;
  duration_seconds: number | null;
  /** Fond d'ambiance propre à CETTE piste au sein d'une playlist audio (réf.
   * mission "associer un fond animé à chaque musique") — absent/nul pour une
   * piste sans fond propre, qui affiche alors le fond du cours/playlist. */
  background_id?: number | null;
  background_title?: string | null;
  background_is_image?: boolean;
}

export interface PlaybackState {
  state: PlaybackStateValue;
  current_video: PlaybackVideo | null;
  position_seconds: number;
  volume: number;
  speed: number;
  playlist_id: number | null;
  playlist_name: string | null;
  playlist_items: PlaybackVideo[] | null;
  playlist_index: number | null;
  playlist_waiting_remaining: number | null;
  current_background: PlaybackBackground | null;
  current_audio_course: PlaybackAudioCourse | null;
  audio_tracks: PlaybackAudioTrack[] | null;
  audio_track_index: number | null;
  audio_playing: boolean;
  audio_position_seconds: number;
  audio_chain_mode: AudioChainMode;
  audio_chain_timer_seconds: number;
  audio_chain_wait_remaining: number | null;
}

export type PlaybackChannel = "cable" | "network";

/** Lecture locale rapportée par une page /cinema du canal (réf. mission
 * "contrôler le cours en mode cinéma") : purement déclaratif, le serveur ne
 * fait que relayer — null tant qu'aucun rapport n'est arrivé. */
export interface CinemaRemoteState {
  title: string | null;
  program: string | null;
  position_seconds: number;
  duration_seconds: number;
  playing: boolean;
  reported_at: number;
}

export type CinemaCommandAction = "play" | "pause" | "seek" | "stop";

export interface PlaybackEvent {
  event: "state_change" | "position_tick";
  cause: string;
  client_ts?: number;
  channel?: PlaybackChannel;
  data: PlaybackState;
  // Présent uniquement sur cause "load" (réf. mission "la vidéo de lancement
  // suffit à cadencer le lancement") : indique au kiosk s'il doit jouer
  // Lancement.mp4 avant de révéler ce cours, ou l'enchaîner directement
  // (suite de playlist, navigation préc./suiv., reprise interrompue).
  play_intro?: boolean;
}

const DEFAULT_STATE: PlaybackState = {
  state: "waiting",
  current_video: null,
  position_seconds: 0,
  volume: 100,
  speed: 1.0,
  playlist_id: null,
  playlist_name: null,
  playlist_items: null,
  playlist_index: null,
  playlist_waiting_remaining: null,
  current_background: null,
  current_audio_course: null,
  audio_tracks: null,
  audio_track_index: null,
  audio_playing: false,
  audio_position_seconds: 0,
  audio_chain_mode: "auto",
  audio_chain_timer_seconds: 20,
  audio_chain_wait_remaining: null,
};

function getWsUrl(): string {
  if (typeof window === "undefined") return "";
  const isDevServer = window.location.port === "3000";
  const host = isDevServer ? "localhost:8001" : window.location.host;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${host}/ws/playback`;
}

function getApiUrl(path: string): string {
  if (typeof window === "undefined") return "";
  const isDevServer = window.location.port === "3000";
  return isDevServer ? `http://localhost:8001/api${path}` : `/api${path}`;
}

// Intervalle du filet de sécurité de resynchronisation (réf. audit
// plan-corrections-bugs, points 2a/3) : un `broadcast()` peut échouer
// silencieusement (accroc Redis) sans jamais faire tomber la connexion
// WebSocket — dans ce cas aucun `state_change` ne rattrape jamais l'état
// affiché. Ce re-fetch REST périodique recale l'état local sur l'état
// réel du serveur même quand aucun évènement WebSocket n'est perdu.
const RESYNC_INTERVAL_MS = 15000;

// Renouvellement du bail primaire (réf. correctif "freeze vidéo réseau") :
// doit rester nettement sous PRIMARY_LEASE_TTL_SECONDS (12s, backend
// ws_manager.py) pour ne jamais laisser le bail expirer pendant qu'un kiosk
// est toujours bien connecté.
const KIOSK_IDENTIFY_INTERVAL_MS = 5000;
const KIOSK_CLIENT_ID_STORAGE_KEY = "olc-kiosk-client-id";

/**
 * Identifiant stable de CET appareil/onglet kiosk, persistant across
 * reconnexions WebSocket (contrairement à l'objet WebSocket lui-même) — la
 * clé du bail primaire Redis côté backend (cf. ws_manager.py,
 * PRIMARY_LEASE_KEY_PREFIX). Sans lui, une reconnexion qui atterrit sur un
 * autre worker uvicorn ne serait pas reconnue comme le même kiosk.
 */
function getOrCreateKioskClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(KIOSK_CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `kiosk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(KIOSK_CLIENT_ID_STORAGE_KEY, created);
    return created;
  } catch {
    // localStorage indisponible (navigation privée stricte, etc.) : repli sur
    // un identifiant de session, perdu à la prochaine reconnexion — dégrade
    // gracieusement vers l'ancien comportement (pas de reprise cross-worker).
    return `kiosk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Connexion WebSocket partagée à l'état de lecture (Lot 3). Utilisée à la
 * fois par l'écran kiosk (qui pilote un <video> réel) et par les
 * télécommandes (qui ne font que refléter/commander l'état).
 *
 * @param onEvent  Callback appelé à chaque changement d'état reçu.
 * @param role     Rôle du client : "kiosk" pour un écran kiosk, omis pour
 *                 une télécommande/admin. Un kiosk envoie un message
 *                 d'identification à la connexion et reçoit en retour son
 *                 statut primaire/miroir (réf. correctif P4).
 * @param channel  Canal de diffusion suivi par ce client (réf. mission
 *                 "tableaux de bord Câblé / Réseau") : seuls les évènements
 *                 de CE canal sont appliqués, et chaque commande envoyée
 *                 porte ce canal — deux lectures totalement indépendantes.
 */
export function usePlaybackSocket(
  onEvent?: (evt: PlaybackEvent) => void,
  role?: "kiosk",
  channel: PlaybackChannel = "cable",
  onCinemaCommand?: (action: CinemaCommandAction, positionSeconds: number) => void,
) {
  const [state, setState] = useState<PlaybackState>(DEFAULT_STATE);
  const [connected, setConnected] = useState(false);
  // Dernier rapport de lecture cinéma du canal (réf. mission "contrôler le
  // cours en mode cinéma") — affiché par les tableaux de bord.
  const [cinemaState, setCinemaState] = useState<CinemaRemoteState | null>(null);
  // Sortie active par CANAL de diffusion (réf. canaux indépendants
  // câblé/réseau) : "kiosk" ou "cinema" chacun. Poussée en temps réel par
  // l'évènement display_output ; null tant que la valeur initiale n'a pas
  // été chargée (évite une redirection intempestive au montage avant de
  // connaître la vraie valeur).
  const [displayOutputCable, setDisplayOutputCable] = useState<"kiosk" | "cinema" | null>(null);
  const [displayOutputNetwork, setDisplayOutputNetwork] = useState<"kiosk" | "cinema" | null>(null);
  // Verrou du mode cinéma (mission /cinema, point 2) : vrai brièvement après
  // qu'un "load"/"load_playlist" manuel a été rejeté par le backend, pour
  // que l'admin affiche un avertissement. Se réinitialise seul.
  const [cinemaLocked, setCinemaLocked] = useState(false);
  const cinemaLockedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // isPrimary : vrai si ce kiosk est le kiosk primaire (seul autorisé à
  // envoyer report_position). Toujours false pour les télécommandes/admin.
  const [isPrimary, setIsPrimary] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Commandes émises pendant une (re)connexion, rejouées à l'ouverture si
  // récentes (< 5 s) — voir sendCommand.
  const pendingCommandsRef = useRef<{ payload: string; queuedAt: number }[]>([]);
  const onEventRef = useRef(onEvent);
  const onCinemaCommandRef = useRef(onCinemaCommand);
  // Miroir de `state` lisible en dehors du cycle de rendu React (correctif
  // "kiosk miroir figé") : le filet de sécurité REST ci-dessous compare
  // l'état serveur à ce qu'affiche VRAIMENT ce client pour décider s'il doit
  // réappliquer les données au <video> — comparer à `state` directement
  // capturerait une valeur obsolète (closure du premier rendu de l'effet).
  const stateRef = useRef<PlaybackState>(DEFAULT_STATE);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onCinemaCommandRef.current = onCinemaCommand;
  }, [onCinemaCommand]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    // Backoff exponentiel (1s -> 2s -> 4s ... plafonné à 30s) : évite de
    // marteler le backend de tentatives de reconnexion en cas de coupure
    // prolongée (réf. plan perf/concurrence Phase 3, P6). Réinitialisé à
    // chaque connexion réussie.
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 30000;

    let identifyInterval: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      const sendIdentify = () => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          command: "identify",
          params: { role: "kiosk", channel, client_id: getOrCreateKioskClientId() },
        }));
      };

      ws.onopen = () => {
        // Garde-fou "socket fantôme" (correctif "le bouton Stop ne marche
        // plus après une reconnexion") : si une connexion PRÉCÉDENTE encore
        // en cours d'établissement ouvre APRÈS avoir été remplacée par une
        // plus récente (StrictMode en dev, ou vrai aléa réseau en prod —
        // Wi-Fi qui coupe puis reprend sur un mobile), ses callbacks
        // continuaient jusqu'ici à écraser l'état partagé alors qu'elle
        // n'est plus la connexion réellement utilisée par sendCommand().
        if (wsRef.current !== ws) return;
        setConnected(true);
        retryDelay = 1000;
        // Identification du rôle kiosk (réf. correctif P4) : envoyée dès
        // l'ouverture de la connexion pour que le backend puisse assigner
        // le rôle primaire/miroir avant tout report_position, PUIS répétée
        // périodiquement (réf. correctif "freeze vidéo réseau") pour
        // renouveler le bail primaire Redis avant son expiration — sans ça,
        // un kiosk pourtant toujours connecté finirait par perdre son statut
        // primaire au bout de PRIMARY_LEASE_TTL_SECONDS.
        if (role === "kiosk") {
          sendIdentify();
          clearInterval(identifyInterval);
          identifyInterval = setInterval(sendIdentify, KIOSK_IDENTIFY_INTERVAL_MS);
        }
        // Rejoue les commandes mises en file pendant la coupure (voir
        // sendCommand) — uniquement les fraîches, dans l'ordre d'émission.
        const now = Date.now();
        const pending = pendingCommandsRef.current.filter((p) => now - p.queuedAt < 5000);
        pendingCommandsRef.current = [];
        for (const p of pending) ws.send(p.payload);
      };

      ws.onmessage = (evt) => {
        if (wsRef.current !== ws) return;
        try {
          const parsed = JSON.parse(evt.data);
          if (parsed.event === "ping") {
            // Keepalive serveur (réf. Phase 3, P7) : répondre immédiatement
            // pour signaler que cette connexion est toujours vivante.
            ws.send(JSON.stringify({ command: "pong" }));
            return;
          }
          if (parsed.event === "kiosk_role") {
            // Le backend nous indique si nous sommes kiosk primaire ou miroir.
            setIsPrimary(!!parsed.is_primary);
            return;
          }
          if (parsed.event === "promoted_primary") {
            // Le kiosk primaire du canal s'est déconnecté et a libéré son
            // bail — on retente immédiatement notre identify (au lieu
            // d'attendre le prochain renouvellement périodique) pour
            // réclamer le rôle sans délai ; le backend confirmera via
            // "kiosk_role".
            sendIdentify();
            return;
          }
          if (parsed.event === "display_output") {
            // Bascule kiosk/cinéma décidée depuis l'admin, par canal : chaque
            // page (kiosk, cinema) décide elle-même si elle doit naviguer,
            // selon qu'elle tourne sur l'écran câblé ou sur le réseau.
            if (parsed.output === "kiosk" || parsed.output === "cinema") {
              if (parsed.channel === "cable") setDisplayOutputCable(parsed.output);
              else if (parsed.channel === "network") setDisplayOutputNetwork(parsed.output);
            }
            return;
          }
          if (parsed.event === "command_rejected") {
            // Verrou du mode cinéma (mission /cinema, point 2) : le backend
            // a ignoré un "load"/"load_playlist" manuel car la sortie
            // câblée est en mode cinéma. N'arrive qu'au client émetteur (pas
            // de broadcast), donc uniquement pertinent pour l'admin qui a
            // cliqué "Lancer".
            if (parsed.reason === "cinema_locked") {
              setCinemaLocked(true);
              if (cinemaLockedTimerRef.current) clearTimeout(cinemaLockedTimerRef.current);
              cinemaLockedTimerRef.current = setTimeout(() => setCinemaLocked(false), 5000);
            }
            return;
          }
          if (parsed.event === "cinema_state") {
            // Rapport d'une page /cinema du canal (réf. mission "contrôler
            // le cours en mode cinéma") : simple reflet pour les tableaux
            // de bord, filtré par canal comme les états de lecture.
            if ((parsed.channel ?? "cable") !== channel) return;
            setCinemaState(parsed.data ?? null);
            return;
          }
          if (parsed.event === "cinema_command") {
            // Ordre admin appliqué par les pages /cinema du canal.
            if ((parsed.channel ?? "cable") !== channel) return;
            onCinemaCommandRef.current?.(parsed.action, parsed.position_seconds ?? 0);
            return;
          }
          if (parsed.event === "force_reload") {
            // Bouton de réinitialisation complète (réf. audit
            // plan-corrections-bugs, point 4) : recharge la page pour
            // reprendre à zéro (état React, connexion WebSocket, éventuelle
            // nouvelle version du build statique).
            window.location.reload();
            return;
          }
          if (parsed.event === "state_change" || parsed.event === "position_tick") {
            // Filtrage par canal (réf. mission "tableaux de bord Câblé /
            // Réseau") : le serveur diffuse les évènements des DEUX canaux
            // sur la même connexion, chacun étiqueté — ce client n'applique
            // que ceux de SON canal. Absence de champ = message d'une
            // version antérieure du backend → canal câblé.
            if ((parsed.channel ?? "cable") !== channel) return;
            setState(parsed.data);
            onEventRef.current?.(parsed as PlaybackEvent);
          }
        } catch (err) {
          console.error("Message WebSocket playback invalide", err);
        }
      };

      ws.onclose = () => {
        // Même garde-fou qu'à l'ouverture : une connexion déjà remplacée qui
        // se ferme tardivement ne doit ni toucher l'état partagé, ni
        // programmer une seconde reconnexion concurrente à celle éventuelle
        // de la connexion réellement active.
        if (wsRef.current !== ws) return;
        clearInterval(identifyInterval);
        setConnected(false);
        setIsPrimary(false);
        wsRef.current = null;
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      clearInterval(identifyInterval);
      if (cinemaLockedTimerRef.current) clearTimeout(cinemaLockedTimerRef.current);
      wsRef.current?.close();
    };
  }, [role, channel]);

  // Filet de sécurité de resynchronisation périodique (réf. audit
  // plan-corrections-bugs, points 2a/3) : indépendant du cycle de vie de la
  // connexion WebSocket ci-dessus. Recale l'état local sur `GET
  // /api/playback/state` à intervalle régulier, pour rattraper un
  // `broadcast()` perdu côté serveur (Redis en accroc) sans que la
  // connexion WebSocket elle-même n'ait jamais été coupée — dans ce cas
  // aucun `state_change` de rattrapage n'arriverait jamais autrement.
  useEffect(() => {
    let cancelled = false;
    const resync = () => {
      fetch(getApiUrl(`/playback/state?channel=${channel}`), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: PlaybackState | null) => {
          if (cancelled || !data) return;
          if (JSON.stringify(stateRef.current) === JSON.stringify(data)) return;
          setState(data);
          // Correctif "kiosk miroir figé" : jusqu'ici ce filet de sécurité
          // mettait à jour `state` (l'affichage textuel) mais n'appelait
          // jamais `onEvent` — le <video> du kiosk n'était donc JAMAIS
          // corrigé par ce chemin. Un `state_change` perdu (accroc Redis,
          // reconnexion WebSocket manquée) laissait alors la vidéo figée sur
          // sa dernière position connue indéfiniment, jusqu'au prochain
          // évènement WebSocket qui pouvait ne jamais arriver. On rejoue donc
          // ici un évènement "sync" synthétique, exactement comme au premier
          // rattachement de la connexion WebSocket.
          onEventRef.current?.({ event: "state_change", cause: "sync", data });
        })
        .catch(() => {
          // Pas de réseau/serveur injoignable : la reconnexion WebSocket
          // gère déjà ce cas, rien à faire de plus ici.
        });
    };
    const id = setInterval(resync, RESYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [channel]);

  // Valeurs initiales des deux canaux : chargées une fois au montage, les
  // changements suivants arrivent en push via l'évènement display_output.
  useEffect(() => {
    let cancelled = false;
    fetch(getApiUrl("/settings/display-output"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.cable === "kiosk" || data.cable === "cinema") {
          setDisplayOutputCable((prev) => prev ?? data.cable);
        }
        if (data.network === "kiosk" || data.network === "cinema") {
          setDisplayOutputNetwork((prev) => prev ?? data.network);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const sendCommand = useCallback((command: string, params: Record<string, unknown> = {}) => {
    const ws = wsRef.current;
    // Chaque commande porte son canal cible : le serveur route vers le
    // gestionnaire d'état du bon canal (zéro interférence entre les deux).
    const payload = JSON.stringify({ command, params: { channel, ...params, client_ts: Date.now() } });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      return;
    }
    // File d'attente courte (réf. "les boutons ne marchent pas à tous les
    // coups") : pendant une (re)connexion — fréquent sur téléphone dont le
    // Wi-Fi se rendort/reprend — les commandes étaient jetées SILENCIEUSEMENT,
    // le bouton semblait juste ne rien faire. On mémorise la commande avec
    // son heure d'émission et la boucle de connexion la rejoue à l'ouverture
    // si elle a moins de 5 s (au-delà, rejouer un play/pause périmé ferait
    // pire que de le perdre).
    pendingCommandsRef.current.push({ payload, queuedAt: Date.now() });
    if (pendingCommandsRef.current.length > 10) pendingCommandsRef.current.shift();
  }, [channel]);

  return { state, connected, sendCommand, isPrimary, displayOutputCable, displayOutputNetwork, cinemaLocked, cinemaState };
}

