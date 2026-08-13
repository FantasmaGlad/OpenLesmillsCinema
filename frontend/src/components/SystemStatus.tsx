"use client";

import React, { useEffect, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";

// Statut système (surveillance du dossier + état de l'écran cinéma). Il vivait
// dans l'en-tête d'administration (retiré à la demande) : il est désormais
// exposé dans la page Paramètres. `usePlaybackSocket` observe le canal câblé
// comme le faisait l'en-tête (miroir, pas de report de position).

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
  }
  return `/api${path}`;
}

export default function SystemStatus() {
  const { t } = useAppSettings();
  const [isOnline, setIsOnline] = useState(true);
  const { state: playbackState, connected: playbackConnected } = usePlaybackSocket();

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(getApiUrl("/health"), { cache: "no-store" });
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const SCREEN_STATE_LABELS: Record<string, string> = {
    waiting: t("playbackState.waiting"),
    paused: t("playbackState.paused"),
    coach_mode: t("playbackState.coach_mode"),
    offline: t("playbackState.offline"),
  };
  const screenLabel = !playbackConnected
    ? t("playbackState.offline")
    : playbackState.state === "playing"
    ? t("playbackState.playing", { title: playbackState.current_video?.title ?? "" })
    : SCREEN_STATE_LABELS[playbackState.state] ?? playbackState.state;
  const screenDotClass = !playbackConnected ? "offline" : playbackState.state === "playing" ? "active" : "attente";

  return (
    <div className="settings-status-grid">
      <div className="settings-status-row">
        <span className="settings-status-key">{t("header.watcherLabel")}</span>
        <span className="settings-status-val">
          <span className={`status-dot ${isOnline ? "active" : "offline"}`} />
          {isOnline ? t("header.watcherActive") : t("header.watcherInactive")}
        </span>
      </div>
      <div className="settings-status-row">
        <span className="settings-status-key">{t("header.screenLabel")}</span>
        <span className="settings-status-val">
          <span className={`status-dot ${screenDotClass} ${screenDotClass === "active" ? "olc-live-dot" : ""}`} />
          {screenLabel}
        </span>
      </div>
    </div>
  );
}
