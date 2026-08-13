"use client";

import React, { useEffect, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import type { Language } from "@/lib/i18n";

interface ActivityLogEntry {
  id: number;
  timestamp: string;
  event_type: string;
  detail: string | null;
}

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
  }
  return `/api${path}`;
}

function formatTimestamp(iso: string, language: Language) {
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return d.toLocaleString(language === "fr" ? "fr-FR" : "en-US", { dateStyle: "short", timeStyle: "medium" });
}

export default function LogsPage() {
  const { t, language } = useAppSettings();
  const EVENT_LABELS: Record<string, string> = {
    video_imported: t("logs.eventLabels.video_imported"),
    background_imported: t("logs.eventLabels.background_imported"),
    audio_course_imported: t("logs.eventLabels.audio_course_imported"),
    video_started: t("logs.eventLabels.video_started"),
    background_started: t("logs.eventLabels.background_started"),
    audio_course_started: t("logs.eventLabels.audio_course_started"),
    playlist_started: t("logs.eventLabels.playlist_started"),
    playback_stopped: t("logs.eventLabels.playback_stopped"),
    playlist_created: t("logs.eventLabels.playlist_created"),
    playlist_updated: t("logs.eventLabels.playlist_updated"),
    playlist_deleted: t("logs.eventLabels.playlist_deleted"),
    schedule_created: t("logs.eventLabels.schedule_created"),
    schedule_updated: t("logs.eventLabels.schedule_updated"),
    schedule_deleted: t("logs.eventLabels.schedule_deleted"),
    schedule_override_created: t("logs.eventLabels.schedule_override_created"),
  };
  const [tab, setTab] = useState<"activity" | "technical">("activity");
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [technicalLog, setTechnicalLog] = useState("");
  const [technicalLoading, setTechnicalLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [purgeCount, setPurgeCount] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  const fetchActivity = () => {
    setLoading(true);
    setSelectedIds([]);
    const qs = filter ? `?event_type=${encodeURIComponent(filter)}` : "";
    fetch(getApiUrl(`/logs/activity${qs}`), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => (prev.length === entries.length ? [] : entries.map((e) => e.id)));
  };

  const deleteActivity = (params: { ids?: number[]; limit?: number }, confirmMessage: string) => {
    if (!window.confirm(confirmMessage)) return;
    setDeleting(true);
    setDeleteError(false);
    const qs = new URLSearchParams();
    if (params.ids) params.ids.forEach((id) => qs.append("ids", String(id)));
    if (params.limit) qs.set("limit", String(params.limit));
    fetch(getApiUrl(`/logs/activity?${qs.toString()}`), { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error("delete failed");
        setPurgeCount("");
        fetchActivity();
      })
      .catch(() => setDeleteError(true))
      .finally(() => setDeleting(false));
  };

  const clearTechnicalLog = () => {
    if (!window.confirm(t("logs.clearTechnicalConfirm"))) return;
    setDeleting(true);
    setDeleteError(false);
    fetch(getApiUrl("/logs/technical"), { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error("delete failed");
        fetchTechnical();
      })
      .catch(() => setDeleteError(true))
      .finally(() => setDeleting(false));
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
      .catch(() => setTechnicalLog(t("logs.technicalLoadError")))
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
          {t("logs.activityTab")}
        </button>
        <button className={`view-btn ${tab === "technical" ? "active" : ""}`} onClick={() => setTab("technical")}>
          {t("logs.technicalTab")}
        </button>
      </div>

      {tab === "activity" ? (
        <>
          <div className="library-toolbar">
            <div className="toolbar-filters">
              <select className="filter-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">{t("logs.allEventTypes")}</option>
                {eventTypes.map((eventType) => (
                  <option key={eventType} value={eventType}>
                    {EVENT_LABELS[eventType] || eventType}
                  </option>
                ))}
              </select>
              <button className="btn btn-secondary" onClick={fetchActivity}>
                {t("logs.refresh")}
              </button>
              <input
                type="number"
                min={1}
                className="form-control"
                style={{ width: "110px" }}
                placeholder={t("logs.purgeRecentPlaceholder")}
                title={t("logs.purgeRecentLabel")}
                value={purgeCount}
                onChange={(e) => setPurgeCount(e.target.value)}
              />
              <button
                className="btn btn-secondary"
                disabled={deleting || !purgeCount || Number(purgeCount) <= 0}
                onClick={() =>
                  deleteActivity(
                    { limit: Number(purgeCount) },
                    t("logs.purgeRecentConfirm", { count: Number(purgeCount) })
                  )
                }
              >
                {t("logs.purgeRecentButton")}
              </button>
              {selectedIds.length > 0 && (
                <button
                  className="btn btn-danger"
                  disabled={deleting}
                  onClick={() =>
                    deleteActivity(
                      { ids: selectedIds },
                      t("logs.deleteSelectionConfirm", { count: selectedIds.length })
                    )
                  }
                >
                  {t("logs.deleteSelection")} ({selectedIds.length})
                </button>
              )}
              <button
                className="btn btn-danger"
                disabled={deleting || entries.length === 0}
                onClick={() => deleteActivity({}, t("logs.clearActivityConfirm"))}
              >
                {t("logs.clearLogs")}
              </button>
            </div>
          </div>
          {deleteError && <p className="live-empty">{t("logs.deleteError")}</p>}

          {loading ? (
            <div className="live-empty">{t("logs.loadingActivity")}</div>
          ) : entries.length === 0 ? (
            <div className="live-empty">{t("logs.noActivity")}</div>
          ) : (
            <div className="table-wrapper">
              <table className="videos-table">
                <thead>
                  <tr>
                    <th style={{ width: "36px" }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.length === entries.length && entries.length > 0}
                        onChange={toggleSelectAll}
                        title={t("logs.selectAll")}
                      />
                    </th>
                    <th style={{ width: "180px" }}>{t("logs.timestampHeader")}</th>
                    <th style={{ width: "220px" }}>{t("logs.eventHeader")}</th>
                    <th>{t("logs.detailHeader")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(entry.id)}
                          onChange={() => toggleSelected(entry.id)}
                        />
                      </td>
                      <td style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {formatTimestamp(entry.timestamp, language)}
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
                {t("logs.refresh")}
              </button>
              <button className="btn btn-danger" disabled={deleting || !technicalLog} onClick={clearTechnicalLog}>
                {t("logs.clearLogs")}
              </button>
              <a href={getApiUrl("/logs/technical/download")} download className="btn btn-secondary">
                {t("logs.downloadFullLog")}
              </a>
            </div>
          </div>
          {deleteError && <p className="live-empty">{t("logs.deleteError")}</p>}
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
            {technicalLoading ? t("logs.loading") : technicalLog || t("logs.emptyTechnicalLog")}
          </div>
        </>
      )}
    </div>
  );
}
