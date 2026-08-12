"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import Icon from "@/components/Icon";

// Onglet « Rappels » (réf. docs/cahier-des-charges-radio.md §7, lot L6) :
// import des annonces de bienséance (fichier + description obligatoire),
// activation/retrait, règles de déclenchement (N musiques / X minutes /
// heures fixes) et déclenchement manuel.

interface Announcement {
  id: number;
  description: string;
  duration_seconds: number | null;
  enabled: boolean;
}

type RuleType = "every_n_tracks" | "every_x_minutes" | "fixed_times";

interface Rule {
  id: number;
  rule_type: RuleType;
  n_tracks: number | null;
  interval_minutes: number | null;
  times_of_day: string[] | null;
  enabled: boolean;
}

interface ToastState { message: string; type: "success" | "error" | "warning"; }

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
  }
  return `/api${path}`;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RadioAnnouncementsPage() {
  const { t } = useAppSettings();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fetchAll = () => {
    Promise.all([
      fetch(getApiUrl("/radio/announcements"), { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
      fetch(getApiUrl("/radio/announcement-rules"), { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([a, r]) => {
        setAnnouncements(a);
        setRules(r);
      })
      .catch(() => showToast(t("radioAnnouncements.genericError"), "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chargement initial uniquement
  }, []);

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file || !description.trim()) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("description", description.trim());
      const res = await fetch(getApiUrl("/radio/announcements/upload"), { method: "POST", body: fd });
      if (res.ok) {
        showToast(t("radioAnnouncements.importedToast"));
        setDescription("");
        if (fileInputRef.current) fileInputRef.current.value = "";
        fetchAll();
      } else {
        showToast(t("radioAnnouncements.importError"), "error");
      }
    } catch {
      showToast(t("radioAnnouncements.importError"), "error");
    } finally {
      setUploading(false);
    }
  };

  const toggleEnabled = async (a: Announcement) => {
    const res = await fetch(getApiUrl(`/radio/announcements/${a.id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !a.enabled }),
    });
    if (res.ok) {
      setAnnouncements((prev) => prev.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)));
    } else {
      showToast(t("radioAnnouncements.genericError"), "error");
    }
  };

  const startEdit = (a: Announcement) => {
    setEditingId(a.id);
    setEditValue(a.description);
  };

  const saveEdit = async (id: number) => {
    if (!editValue.trim()) return;
    const res = await fetch(getApiUrl(`/radio/announcements/${id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: editValue.trim() }),
    });
    if (res.ok) {
      showToast(t("radioAnnouncements.updatedToast"));
      setEditingId(null);
      fetchAll();
    } else {
      showToast(t("radioAnnouncements.genericError"), "error");
    }
  };

  const handleDelete = async (id: number) => {
    const res = await fetch(getApiUrl(`/radio/announcements/${id}`), { method: "DELETE" });
    if (res.ok) {
      showToast(t("radioAnnouncements.deletedToast"));
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    } else {
      showToast(t("radioAnnouncements.genericError"), "error");
    }
    setConfirmDeleteId(null);
  };

  const handlePlayNow = async (announcementId?: number) => {
    const res = await fetch(getApiUrl("/radio/announcements/play-now"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ announcement_id: announcementId ?? null }),
    });
    if (res.ok) {
      const data = await res.json();
      showToast(t("radioAnnouncements.playNowToast", { description: data.description }));
    } else {
      showToast(t("radioAnnouncements.playNowError"), "error");
    }
  };

  const [newRuleType, setNewRuleType] = useState<RuleType>("every_n_tracks");
  const [newNTracks, setNewNTracks] = useState("5");
  const [newIntervalMinutes, setNewIntervalMinutes] = useState("30");
  const [newTimes, setNewTimes] = useState<string[]>([]);
  const [newTimeInput, setNewTimeInput] = useState("09:00");

  const handleAddRule = async () => {
    const payload: Record<string, unknown> = { rule_type: newRuleType, enabled: true };
    if (newRuleType === "every_n_tracks") payload.n_tracks = Number(newNTracks);
    if (newRuleType === "every_x_minutes") payload.interval_minutes = Number(newIntervalMinutes);
    if (newRuleType === "fixed_times") payload.times_of_day = newTimes;

    const res = await fetch(getApiUrl("/radio/announcement-rules"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showToast(t("radioAnnouncements.ruleSavedToast"));
      setNewTimes([]);
      fetchAll();
    } else {
      const data = await res.json().catch(() => null);
      showToast(data?.detail || t("radioAnnouncements.ruleError"), "error");
    }
  };

  const toggleRuleEnabled = async (rule: Rule) => {
    const res = await fetch(getApiUrl(`/radio/announcement-rules/${rule.id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rule_type: rule.rule_type, n_tracks: rule.n_tracks, interval_minutes: rule.interval_minutes,
        times_of_day: rule.times_of_day, enabled: !rule.enabled,
      }),
    });
    if (res.ok) {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    } else {
      showToast(t("radioAnnouncements.ruleError"), "error");
    }
  };

  const handleDeleteRule = async (id: number) => {
    const res = await fetch(getApiUrl(`/radio/announcement-rules/${id}`), { method: "DELETE" });
    if (res.ok) {
      showToast(t("radioAnnouncements.ruleDeletedToast"));
      setRules((prev) => prev.filter((r) => r.id !== id));
    } else {
      showToast(t("radioAnnouncements.genericError"), "error");
    }
  };

  const ruleLabel = (type: RuleType) =>
    type === "every_n_tracks"
      ? t("radioAnnouncements.ruleTypeEveryNTracks")
      : type === "every_x_minutes"
      ? t("radioAnnouncements.ruleTypeEveryXMinutes")
      : t("radioAnnouncements.ruleTypeFixedTimes");

  const ruleDetail = (rule: Rule) =>
    rule.rule_type === "every_n_tracks"
      ? `${rule.n_tracks}`
      : rule.rule_type === "every_x_minutes"
      ? `${rule.interval_minutes} min`
      : (rule.times_of_day || []).join(", ");

  return (
    <div className="dashboard-container">
      <div className="live-block">
        <div className="live-header">
          <h3>
            <Icon name="campaign" size={18} />
            {t("radioAnnouncements.title")}
          </h3>
          <button className="btn btn-primary" onClick={() => handlePlayNow()}>
            <Icon name="play_arrow" size={16} filled />
            {t("radioAnnouncements.playNow")}
          </button>
        </div>
        <p className="live-block-hint" style={{ margin: 0 }}>{t("radioAnnouncements.subtitle")}</p>
      </div>

      <div className="launch-block">
        <h3>{t("radioAnnouncements.importTitle")}</h3>
        <div className="launch-row" style={{ flexWrap: "wrap" }}>
          <input ref={fileInputRef} type="file" accept="audio/*" className="filter-select" style={{ flex: 1, minWidth: "200px" }} />
          <input
            type="text"
            className="filter-select"
            style={{ flex: 2, minWidth: "220px" }}
            placeholder={t("radioAnnouncements.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleUpload} disabled={uploading || !description.trim()}>
            <Icon name="upload" size={16} />
            {t("radioAnnouncements.importButton")}
          </button>
        </div>
      </div>

      <div className="live-block">
        <div className="live-header">
          <h3>{t("radioAnnouncements.title")}</h3>
        </div>
        {loading ? (
          <p className="live-empty">{t("radioAnnouncements.loading")}</p>
        ) : announcements.length === 0 ? (
          <p className="live-empty">{t("radioAnnouncements.empty")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {announcements.map((a) => (
              <div
                key={a.id}
                className="olc-card-hover"
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px",
                  padding: "10px 12px", background: "var(--bg-surface-elevated)",
                  borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)",
                }}
              >
                {editingId === a.id ? (
                  <input
                    type="text"
                    className="filter-select"
                    style={{ flex: 1 }}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    autoFocus
                  />
                ) : (
                  <span style={{ fontWeight: 700, fontSize: "0.9rem", flex: 1 }}>
                    {a.description}
                    <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: "8px" }}>
                      {formatDuration(a.duration_seconds)}
                    </span>
                  </span>
                )}
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    <input type="checkbox" checked={a.enabled} onChange={() => toggleEnabled(a)} />
                    {t("radioAnnouncements.enabledLabel")}
                  </label>
                  <button
                    className="btn btn-secondary"
                    style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }}
                    onClick={() => handlePlayNow(a.id)}
                    disabled={!a.enabled}
                  >
                    <Icon name="play_arrow" size={14} filled />
                  </button>
                  {editingId === a.id ? (
                    <>
                      <button className="btn btn-primary" style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }} onClick={() => saveEdit(a.id)}>
                        {t("radioAnnouncements.save")}
                      </button>
                      <button className="btn btn-secondary" style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }} onClick={() => setEditingId(null)}>
                        {t("radioAnnouncements.cancel")}
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-secondary" style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }} onClick={() => startEdit(a)}>
                      <Icon name="edit" size={14} />
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }}
                    onClick={() => setConfirmDeleteId(a.id)}
                  >
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="launch-block">
        <h3>{t("radioAnnouncements.rulesTitle")}</h3>
        {rules.length === 0 && <p className="live-empty" style={{ marginBottom: "12px" }}>{t("radioAnnouncements.noRules")}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="olc-card-hover"
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px",
                padding: "10px 12px", background: "var(--bg-surface-elevated)",
                borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)",
              }}
            >
              <span style={{ fontSize: "0.9rem" }}>
                <strong>{ruleLabel(rule.rule_type)}</strong> — {ruleDetail(rule)}
              </span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  <input type="checkbox" checked={rule.enabled} onChange={() => toggleRuleEnabled(rule)} />
                  {t("radioAnnouncements.enabledLabel")}
                </label>
                <button className="btn btn-secondary" style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }} onClick={() => handleDeleteRule(rule.id)}>
                  <Icon name="delete" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="launch-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <select className="filter-select" value={newRuleType} onChange={(e) => setNewRuleType(e.target.value as RuleType)}>
            <option value="every_n_tracks">{t("radioAnnouncements.ruleTypeEveryNTracks")}</option>
            <option value="every_x_minutes">{t("radioAnnouncements.ruleTypeEveryXMinutes")}</option>
            <option value="fixed_times">{t("radioAnnouncements.ruleTypeFixedTimes")}</option>
          </select>

          {newRuleType === "every_n_tracks" && (
            <input
              type="number"
              min={1}
              className="filter-select"
              style={{ width: "140px" }}
              value={newNTracks}
              onChange={(e) => setNewNTracks(e.target.value)}
              placeholder={t("radioAnnouncements.nTracksLabel")}
            />
          )}
          {newRuleType === "every_x_minutes" && (
            <input
              type="number"
              min={1}
              className="filter-select"
              style={{ width: "140px" }}
              value={newIntervalMinutes}
              onChange={(e) => setNewIntervalMinutes(e.target.value)}
              placeholder={t("radioAnnouncements.intervalMinutesLabel")}
            />
          )}
          {newRuleType === "fixed_times" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="time"
                  className="filter-select"
                  value={newTimeInput}
                  onChange={(e) => setNewTimeInput(e.target.value)}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    if (newTimeInput && !newTimes.includes(newTimeInput)) setNewTimes((prev) => [...prev, newTimeInput].sort());
                  }}
                >
                  {t("radioAnnouncements.addTime")}
                </button>
              </div>
              {newTimes.length === 0 ? (
                <span className="live-empty">{t("radioAnnouncements.noTimes")}</span>
              ) : (
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {newTimes.map((tm) => (
                    <span
                      key={tm}
                      className="status-pill"
                      style={{ cursor: "pointer" }}
                      onClick={() => setNewTimes((prev) => prev.filter((x) => x !== tm))}
                      title={t("radioAnnouncements.deleteRule")}
                    >
                      {tm} ✕
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handleAddRule}
            disabled={newRuleType === "fixed_times" && newTimes.length === 0}
          >
            <Icon name="add" size={16} />
            {t("radioAnnouncements.addRule")}
          </button>
        </div>
      </div>

      {confirmDeleteId !== null && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "420px" }}>
            <h3>{t("radioAnnouncements.deleteConfirmTitle")}</h3>
            <p>
              {t("radioAnnouncements.deleteConfirmText", {
                description: announcements.find((a) => a.id === confirmDeleteId)?.description || "",
              })}
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "16px" }}>
              <button className="btn btn-secondary" onClick={() => setConfirmDeleteId(null)}>
                {t("radioAnnouncements.cancel")}
              </button>
              <button className="btn btn-primary" onClick={() => handleDelete(confirmDeleteId)}>
                {t("radioAnnouncements.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.type}`}><span>{toast.message}</span></div>}
    </div>
  );
}
