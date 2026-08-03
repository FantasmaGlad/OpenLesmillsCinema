"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TimerMode = "next_course" | "countdown" | "countup" | "hidden";

export interface TimerState {
  mode: TimerMode;
  running: boolean;
  remaining_seconds: number | null;
  elapsed_seconds: number | null;
  ended: boolean;
  // Instants serveur absolus (epoch ms, réf. audit plan-corrections-bugs,
  // point 7) : permettent une interpolation locale fluide côté kiosk plutôt
  // que de dépendre du tick serveur à 1 Hz. null quand non pertinent
  // (arrêté/en pause).
  ends_at: number | null;
  started_at: number | null;
}

export interface TimerEvent {
  event: "timer_change";
  cause: string;
  data: TimerState;
}

const DEFAULT_STATE: TimerState = {
  mode: "next_course",
  running: false,
  remaining_seconds: null,
  elapsed_seconds: null,
  ended: false,
  ends_at: null,
  started_at: null,
};

function getWsUrl(): string {
  if (typeof window === "undefined") return "";
  const isDevServer = window.location.port === "3000";
  const host = isDevServer ? "localhost:8001" : window.location.host;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${host}/ws/timer`;
}

/**
 * Connexion WebSocket au minuteur/chronomètre (Lot 4), indépendante de la
 * lecture vidéo (Lot 3) — cf. usePlaybackSocket pour le même schéma.
 */
export function useTimerSocket(onEvent?: (evt: TimerEvent) => void) {
  const [state, setState] = useState<TimerState>(DEFAULT_STATE);
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
          const parsed: TimerEvent = JSON.parse(evt.data);
          if (parsed.event === "timer_change") {
            setState(parsed.data);
            onEventRef.current?.(parsed);
          }
        } catch (err) {
          console.error("Message WebSocket timer invalide", err);
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
      ws.send(JSON.stringify({ command, params }));
    }
  }, []);

  return { state, connected, sendCommand };
}
