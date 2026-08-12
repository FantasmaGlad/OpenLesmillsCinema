"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Réf. docs/cahier-des-charges-radio.md, lot L3 — état du 3e canal `radio`,
 * moteur INDÉPENDANT du câblé/réseau (RadioPlaybackManager côté backend).
 * Partage la même connexion WebSocket `/ws/playback` que usePlaybackSocket
 * (filtrée sur `channel: "radio"`), mais un vocabulaire d'état et de
 * commandes propre — pas de vidéo/cours, une playlist de morceaux. */

export interface RadioTrackInfo {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
  cover_url: string | null;
}

export type RadioRepeatMode = "off" | "playlist" | "track";

export interface RadioState {
  state: "idle" | "playing" | "paused";
  playlist_id: number | null;
  playlist_name: string | null;
  order: RadioTrackInfo[];
  index: number | null;
  current_track: RadioTrackInfo | null;
  position_seconds: number;
  duration_seconds: number | null;
  volume: number;
  shuffle: boolean;
  repeat: RadioRepeatMode;
  playing: boolean;
  crossfade_seconds: number;
}

const DEFAULT_STATE: RadioState = {
  state: "idle",
  playlist_id: null,
  playlist_name: null,
  order: [],
  index: null,
  current_track: null,
  position_seconds: 0,
  duration_seconds: null,
  volume: 100,
  shuffle: false,
  repeat: "off",
  playing: false,
  crossfade_seconds: 4,
};

export interface RadioEvent {
  event: "state_change";
  cause: string;
  channel: "radio";
  data: RadioState;
  client_ts?: number;
}

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

// Même filet de sécurité que usePlaybackSocket (réf. audit
// plan-corrections-bugs) : recale l'état sur GET /api/radio/state à
// intervalle régulier, au cas où un broadcast() aurait été perdu.
const RESYNC_INTERVAL_MS = 15000;

export function useRadioSocket(onEvent?: (evt: RadioEvent) => void) {
  const [state, setState] = useState<RadioState>(DEFAULT_STATE);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingCommandsRef = useRef<{ payload: string; queuedAt: number }[]>([]);
  const onEventRef = useRef(onEvent);
  const stateRef = useRef<RadioState>(DEFAULT_STATE);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 30000;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setConnected(true);
        retryDelay = 1000;
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
            ws.send(JSON.stringify({ command: "pong" }));
            return;
          }
          // Évènements pertinents pour d'autres canaux (kiosk_role,
          // display_output, cinema_*...) : sans objet ici, ignorés.
          if (parsed.event === "force_reload") {
            window.location.reload();
            return;
          }
          if (parsed.event === "state_change" && parsed.channel === "radio") {
            setState(parsed.data);
            onEventRef.current?.(parsed as RadioEvent);
          }
        } catch (err) {
          console.error("Message WebSocket radio invalide", err);
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        setConnected(false);
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
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resync = () => {
      fetch(getApiUrl("/radio/state"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: RadioState | null) => {
          if (cancelled || !data) return;
          if (JSON.stringify(stateRef.current) === JSON.stringify(data)) return;
          setState(data);
          onEventRef.current?.({ event: "state_change", cause: "sync", channel: "radio", data });
        })
        .catch(() => {});
    };
    const id = setInterval(resync, RESYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const sendCommand = useCallback((command: string, params: Record<string, unknown> = {}) => {
    const ws = wsRef.current;
    const payload = JSON.stringify({
      command,
      params: { channel: "radio", ...params, client_ts: Date.now() },
    });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      return;
    }
    pendingCommandsRef.current.push({ payload, queuedAt: Date.now() });
    if (pendingCommandsRef.current.length > 10) pendingCommandsRef.current.shift();
  }, []);

  return { state, connected, sendCommand };
}
