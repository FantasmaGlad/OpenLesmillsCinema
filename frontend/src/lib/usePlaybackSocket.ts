"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PlaybackStateValue =
  | "waiting"
  | "countdown"
  | "playing"
  | "paused"
  | "coach_mode"
  | "offline"
  | "playlist_waiting";

export interface PlaybackVideo {
  id: number;
  title: string;
  duration_seconds: number | null;
  program?: string | null;
}

export interface PlaybackState {
  state: PlaybackStateValue;
  current_video: PlaybackVideo | null;
  position_seconds: number;
  volume: number;
  speed: number;
  countdown_remaining: number | null;
  playlist_id: number | null;
  playlist_name: string | null;
  playlist_items: PlaybackVideo[] | null;
  playlist_index: number | null;
  playlist_waiting_remaining: number | null;
}

export interface PlaybackEvent {
  event: "state_change";
  cause: string;
  client_ts?: number;
  data: PlaybackState;
}

const DEFAULT_STATE: PlaybackState = {
  state: "waiting",
  current_video: null,
  position_seconds: 0,
  volume: 100,
  speed: 1.0,
  countdown_remaining: null,
  playlist_id: null,
  playlist_name: null,
  playlist_items: null,
  playlist_index: null,
  playlist_waiting_remaining: null,
};

function getWsUrl(): string {
  if (typeof window === "undefined") return "";
  const isDevServer = window.location.port === "3000";
  const host = isDevServer ? "localhost:8000" : window.location.host;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${host}/ws/playback`;
}

/**
 * Connexion WebSocket partagée à l'état de lecture (Lot 3). Utilisée à la
 * fois par l'écran kiosk (qui pilote un <video> réel) et par les
 * télécommandes (qui ne font que refléter/commander l'état).
 */
export function usePlaybackSocket(onEvent?: (evt: PlaybackEvent) => void) {
  const [state, setState] = useState<PlaybackState>(DEFAULT_STATE);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (evt) => {
        try {
          const parsed: PlaybackEvent = JSON.parse(evt.data);
          if (parsed.event === "state_change") {
            setState(parsed.data);
            onEventRef.current?.(parsed);
          }
        } catch (err) {
          console.error("Message WebSocket playback invalide", err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 2000);
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

  const sendCommand = useCallback((command: string, params: Record<string, unknown> = {}) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ command, params: { ...params, client_ts: Date.now() } }));
    }
  }, []);

  return { state, connected, sendCommand };
}
