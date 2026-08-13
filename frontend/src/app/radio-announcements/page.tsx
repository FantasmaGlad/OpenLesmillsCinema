"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import Icon from "@/components/Icon";

// Écran « Rappels » (réf. docs/cahier-des-charges-radio.md §7, lot L6) —
// refonte UI/UX (style de la bibliothèque radio) : en-tête clair, import
// aéré, liste de rappels en cartes lisibles (lecture / activer / éditer /
// supprimer), et règles de déclenchement dans une colonne dédiée.

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

  const ruleIcon = (type: RuleType) =>
    type === "every_n_tracks" ? "music_note" : type === "every_x_minutes" ? "timer" : "schedule";

  return (
    <div className="ra-page">
      {toast && <div className={`toast ${toast.type}`}><span>{toast.message}</span></div>}

      {/* En-tête */}
      <div className="ra-header">
        <div>
          <h1 className="ra-title"><Icon name="campaign" size={24} /> {t("radioAnnouncements.title")}</h1>
          <p className="ra-subtitle">{t("radioAnnouncements.subtitle")}</p>
        </div>
        <button className="btn btn-primary ra-playnow" onClick={() => handlePlayNow()} disabled={announcements.filter((a) => a.enabled).length === 0}>
          <Icon name="play_arrow" size={18} filled /> {t("radioAnnouncements.playNow")}
        </button>
      </div>

      <div className="ra-grid">
        {/* -------- Colonne : rappels -------- */}
        <section className="ra-col">
          {/* Import */}
          <div className="ra-card">
            <h3 className="ra-card-title"><Icon name="upload" size={18} /> {t("radioAnnouncements.importTitle")}</h3>
            <p className="ra-card-hint">{t("radioAnnouncements.importHint")}</p>
            <div className="ra-import-form">
              <label className="ra-field">
                <span className="ra-field-label">{t("radioAnnouncements.fileLabel")}</span>
                <input ref={fileInputRef} type="file" accept="audio/*" className="form-control" />
              </label>
              <label className="ra-field">
                <span className="ra-field-label">{t("radioAnnouncements.descriptionLabel")}</span>
                <input
                  type="text"
                  className="form-control"
                  placeholder={t("radioAnnouncements.descriptionPlaceholder")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <button className="btn btn-primary" style={{ height: "44px" }} onClick={handleUpload} disabled={uploading || !description.trim()}>
                <Icon name="upload" size={16} /> {uploading ? t("radioAnnouncements.importing") : t("radioAnnouncements.importButton")}
              </button>
            </div>
          </div>

          {/* Liste des rappels */}
          <div className="ra-card">
            <h3 className="ra-card-title">
              <Icon name="record_voice_over" size={18} /> {t("radioAnnouncements.listTitle")}
              {announcements.length > 0 && <span className="ra-count">{announcements.length}</span>}
            </h3>
            {loading ? (
              <p className="live-empty">{t("radioAnnouncements.loading")}</p>
            ) : announcements.length === 0 ? (
              <div className="ra-empty">
                <Icon name="campaign" size={36} style={{ opacity: 0.25 }} />
                <p>{t("radioAnnouncements.empty")}</p>
              </div>
            ) : (
              <div className="ra-list">
                {announcements.map((a) => (
                  <div key={a.id} className={`ra-item ${a.enabled ? "" : "off"}`}>
                    <button
                      className="ra-item-play"
                      onClick={() => handlePlayNow(a.id)}
                      disabled={!a.enabled}
                      title={t("radioAnnouncements.playNow")}
                    >
                      <Icon name="play_arrow" size={18} filled />
                    </button>
                    <div className="ra-item-body">
                      {editingId === a.id ? (
                        <input
                          type="text"
                          className="form-control"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") saveEdit(a.id); }}
                          autoFocus
                        />
                      ) : (
                        <>
                          <span className="ra-item-desc">{a.description}</span>
                          <span className="ra-item-dur">{formatDuration(a.duration_seconds)}</span>
                        </>
                      )}
                    </div>
                    <label className="ra-switch" title={t("radioAnnouncements.enabledLabel")}>
                      <input type="checkbox" checked={a.enabled} onChange={() => toggleEnabled(a)} />
                      <span className="ra-switch-track" />
                    </label>
                    {editingId === a.id ? (
                      <div className="ra-item-actions">
                        <button className="btn btn-primary ra-icon-btn" onClick={() => saveEdit(a.id)} title={t("radioAnnouncements.save")}><Icon name="check" size={16} /></button>
                        <button className="btn btn-secondary ra-icon-btn" onClick={() => setEditingId(null)} title={t("radioAnnouncements.cancel")}><Icon name="close" size={16} /></button>
                      </div>
                    ) : (
                      <div className="ra-item-actions">
                        <button className="btn btn-secondary ra-icon-btn" onClick={() => startEdit(a)} title={t("radioAnnouncements.edit")}><Icon name="edit" size={16} /></button>
                        <button className="btn btn-danger ra-icon-btn" onClick={() => setConfirmDeleteId(a.id)} title={t("radioAnnouncements.delete")}><Icon name="delete" size={16} /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* -------- Colonne : règles de déclenchement -------- */}
        <section className="ra-col">
          <div className="ra-card">
            <h3 className="ra-card-title"><Icon name="schedule" size={18} /> {t("radioAnnouncements.rulesTitle")}</h3>
            <p className="ra-card-hint">{t("radioAnnouncements.rulesHint")}</p>

            {rules.length === 0 ? (
              <p className="live-empty" style={{ marginBottom: "12px" }}>{t("radioAnnouncements.noRules")}</p>
            ) : (
              <div className="ra-list" style={{ marginBottom: "16px" }}>
                {rules.map((rule) => (
                  <div key={rule.id} className={`ra-rule ${rule.enabled ? "" : "off"}`}>
                    <div className="ra-rule-icon"><Icon name={ruleIcon(rule.rule_type)} size={18} /></div>
                    <div className="ra-rule-info">
                      <span className="ra-rule-type">{ruleLabel(rule.rule_type)}</span>
                      <span className="ra-rule-detail">{ruleDetail(rule)}</span>
                    </div>
                    <label className="ra-switch" title={t("radioAnnouncements.enabledLabel")}>
                      <input type="checkbox" checked={rule.enabled} onChange={() => toggleRuleEnabled(rule)} />
                      <span className="ra-switch-track" />
                    </label>
                    <button className="btn btn-danger ra-icon-btn" onClick={() => handleDeleteRule(rule.id)} title={t("radioAnnouncements.delete")}><Icon name="delete" size={16} /></button>
                  </div>
                ))}
              </div>
            )}

            {/* Ajout d'une règle */}
            <div className="ra-add-rule">
              <span className="ra-field-label">{t("radioAnnouncements.addRuleTitle")}</span>
              <select className="form-control" value={newRuleType} onChange={(e) => setNewRuleType(e.target.value as RuleType)}>
                <option value="every_n_tracks">{t("radioAnnouncements.ruleTypeEveryNTracks")}</option>
                <option value="every_x_minutes">{t("radioAnnouncements.ruleTypeEveryXMinutes")}</option>
                <option value="fixed_times">{t("radioAnnouncements.ruleTypeFixedTimes")}</option>
              </select>

              {newRuleType === "every_n_tracks" && (
                <input type="number" min={1} className="form-control" value={newNTracks}
                  onChange={(e) => setNewNTracks(e.target.value)} placeholder={t("radioAnnouncements.nTracksLabel")} />
              )}
              {newRuleType === "every_x_minutes" && (
                <input type="number" min={1} className="form-control" value={newIntervalMinutes}
                  onChange={(e) => setNewIntervalMinutes(e.target.value)} placeholder={t("radioAnnouncements.intervalMinutesLabel")} />
              )}
              {newRuleType === "fixed_times" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input type="time" className="form-control" value={newTimeInput} onChange={(e) => setNewTimeInput(e.target.value)} style={{ flex: 1 }} />
                    <button className="btn btn-secondary" onClick={() => { if (newTimeInput && !newTimes.includes(newTimeInput)) setNewTimes((prev) => [...prev, newTimeInput].sort()); }}>
                      <Icon name="add" size={16} /> {t("radioAnnouncements.addTime")}
                    </button>
                  </div>
                  {newTimes.length === 0 ? (
                    <span className="live-empty">{t("radioAnnouncements.noTimes")}</span>
                  ) : (
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {newTimes.map((tm) => (
                        <span key={tm} className="ra-time-pill" onClick={() => setNewTimes((prev) => prev.filter((x) => x !== tm))} title={t("radioAnnouncements.deleteRule")}>
                          {tm} <Icon name="close" size={12} />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button className="btn btn-primary" style={{ height: "44px" }} onClick={handleAddRule} disabled={newRuleType === "fixed_times" && newTimes.length === 0}>
                <Icon name="add" size={16} /> {t("radioAnnouncements.addRule")}
              </button>
            </div>
          </div>
        </section>
      </div>

      {confirmDeleteId !== null && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "420px" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("radioAnnouncements.deleteConfirmTitle")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              {t("radioAnnouncements.deleteConfirmText", { description: announcements.find((a) => a.id === confirmDeleteId)?.description || "" })}
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmDeleteId(null)}>{t("radioAnnouncements.cancel")}</button>
              <button className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={() => handleDelete(confirmDeleteId)}>{t("radioAnnouncements.confirmDelete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
