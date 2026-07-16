"use client";

import React, { useEffect, useState } from "react";

interface ActivityLogEntry {
  id: number;
  timestamp: string;
  event_type: string;
  detail: string | null;
}

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8000/api${path}`;
  }
  return `/api${path}`;
}

const EVENT_LABELS: Record<string, string> = {
  video_imported: "Vidéo importée",
  background_imported: "Fond animé importé",
  audio_course_imported: "Cours audio importé",
  video_started: "Lecture démarrée",
  background_started: "Fond animé lancé",
  audio_course_started: "Mode coach démarré",
  playlist_started: "Playlist lancée",
  playback_stopped: "Lecture arrêtée",
  playlist_created: "Playlist créée",
  playlist_updated: "Playlist modifiée",
  playlist_deleted: "Playlist supprimée",
  schedule_created: "Programmation créée",
  schedule_updated: "Programmation modifiée",
  schedule_deleted: "Programmation supprimée",
  schedule_override_created: "Override de programmation",
};

function formatTimestamp(iso: string) {
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
}

export default function LogsPage() {
  const [tab, setTab] = useState<"activity" | "technical">("activity");
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [technicalLog, setTechnicalLog] = useState("");
  const [technicalLoading, setTechnicalLoading] = useState(false);

  const fetchActivity = () => {
    setLoading(true);
    const qs = filter ? `?event_type=${encodeURIComponent(filter)}` : "";
    fetch(getApiUrl(`/logs/activity${qs}`), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetch(getApiUrl("/logs/activity/event-types"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setEventTypes)
      .catch(() => setEventTypes([]));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchActivity() met setLoading(true) en premier, motif déjà utilisé ailleurs dans le projet
    if (tab === "activity") fetchActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filter]);

  const fetchTechnical = () => {
    setTechnicalLoading(true);
    fetch(getApiUrl("/logs/technical"), { cache: "no-store" })
      .then((res) => (res.ok ? res.text() : ""))
      .then(setTechnicalLog)
      .catch(() => setTechnicalLog("Impossible de charger le log technique."))
      .finally(() => setTechnicalLoading(false));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchTechnical() met setTechnicalLoading(true) en premier, même motif
    if (tab === "technical") fetchTechnical();
  }, [tab]);

  return (
    <div className="library-container">
      <div className="view-toggle" style={{ width: "fit-content" }}>
        <button className={`view-btn ${tab === "activity" ? "active" : ""}`} onClick={() => setTab("activity")}>
          Activité
        </button>
        <button className={`view-btn ${tab === "technical" ? "active" : ""}`} onClick={() => setTab("technical")}>
          Technique
        </button>
      </div>

      {tab === "activity" ? (
        <>
          <div className="library-toolbar">
            <div className="toolbar-filters">
              <select className="filter-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">Tous les types d&apos;évènement</option>
                {eventTypes.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_LABELS[t] || t}
                  </option>
                ))}
              </select>
              <button className="btn btn-secondary" onClick={fetchActivity}>
                Rafraîchir
              </button>
            </div>
          </div>

          {loading ? (
            <div className="live-empty">Chargement du log d&apos;activité...</div>
          ) : entries.length === 0 ? (
            <div className="live-empty">Aucune activité enregistrée pour le moment.</div>
          ) : (
            <div className="table-wrapper">
              <table className="videos-table">
                <thead>
                  <tr>
                    <th style={{ width: "180px" }}>Horodatage</th>
                    <th style={{ width: "220px" }}>Évènement</th>
                    <th>Détail</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td style={{ fontWeight: 700 }}>{EVENT_LABELS[entry.event_type] || entry.event_type}</td>
                      <td style={{ color: "var(--text-muted)" }}>{entry.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="library-toolbar">
            <div className="toolbar-filters">
              <button className="btn btn-secondary" onClick={fetchTechnical}>
                Rafraîchir
              </button>
              <a href={getApiUrl("/logs/technical/download")} download className="btn btn-secondary">
                Télécharger le log complet
              </a>
            </div>
          </div>
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-lg)",
              padding: "16px",
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: "var(--text-muted)",
              whiteSpace: "pre-wrap",
              overflowY: "auto",
              maxHeight: "calc(100vh - 260px)",
            }}
          >
            {technicalLoading ? "Chargement..." : technicalLog || "Log technique vide."}
          </div>
        </>
      )}
    </div>
  );
}
