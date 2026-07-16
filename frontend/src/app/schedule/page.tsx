"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/lib/useIsMobile";

type TargetType = "video" | "playlist";
type ScheduleTypeValue = "once" | "recurring";
type OverrideActionValue = "cancelled" | "replaced";

interface VideoSummary {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  duration_seconds: number | null;
}

interface PlaylistSummary {
  id: number;
  name: string;
  item_count: number;
  total_duration_seconds: number;
}

interface ScheduleDetail {
  id: number;
  target_type: TargetType;
  target_id: number;
  target_title: string | null;
  target_program: string | null;
  schedule_type: ScheduleTypeValue;
  run_at: string | null;
  days_of_week: number[] | null;
  time_of_day: string | null;
  active: boolean;
  override_count: number;
}

interface Occurrence {
  schedule_id: number;
  schedule_type: ScheduleTypeValue;
  run_at: string;
  target_type: TargetType;
  target_id: number;
  title: string | null;
  program: string | null;
  is_override: boolean;
  override_action: OverrideActionValue | null;
  override_id: number | null;
}

interface ToastState {
  message: string;
  type: "success" | "error" | "warning";
}

const DAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAY_LABELS_FULL = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

const PROGRAM_ACCENT: Record<string, string> = {
  RPM: "var(--accent-rpm)",
  Sprint: "var(--accent-sprint)",
  "The Trip": "var(--accent-trip)",
};

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8000/api${path}`;
  }
  return `/api${path}`;
}

function getWeekStart(source: Date): Date {
  const d = new Date(source);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=dimanche .. 6=samedi
  const diff = day === 0 ? -6 : 1 - day; // décale vers le lundi de la semaine
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(source: Date, days: number): Date {
  const d = new Date(source);
  d.setDate(d.getDate() + days);
  return d;
}

function isSameLocalDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

function toDatetimeLocalValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toOccurrenceDateString(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatWeekLabel(weekStart: Date) {
  const weekEnd = addDays(weekStart, 6);
  const fmt = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `${fmt(weekStart)} — ${fmt(weekEnd)}`;
}

function formatOccurrenceTime(iso: string) {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "";
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

export default function SchedulePage() {
  const isMobile = useIsMobile();
  const [viewMode, setViewMode] = useState<"calendar" | "list">("calendar");

  // La grille calendrier à 7 colonnes n'est pas exploitable sur un écran de
  // téléphone (réf. UX4.1 "présentation adaptée") : bascule sur la vue liste
  // déjà existante (UX3.16), sans empêcher l'utilisateur de revenir à la
  // grille manuellement ensuite via le même bouton que sur PC.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronise avec le viewport (matchMedia), motif déjà accepté ailleurs (useIsMobile, ClientLayout)
    if (isMobile) setViewMode("list");
  }, [isMobile]);
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()));
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [replacingKey, setReplacingKey] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState<string>("");

  // Tiroir de création / édition
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingOverrideCount, setEditingOverrideCount] = useState(0);
  const [formTargetType, setFormTargetType] = useState<TargetType>("video");
  const [formTargetId, setFormTargetId] = useState<string>("");
  const [formTargetSearch, setFormTargetSearch] = useState<string>("");
  const [formScheduleType, setFormScheduleType] = useState<ScheduleTypeValue>("once");
  const [formDateTime, setFormDateTime] = useState<string>("");
  const [formDaysOfWeek, setFormDaysOfWeek] = useState<number[]>([]);
  const [formTime, setFormTime] = useState<string>("18:00");
  const [formActive, setFormActive] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState(false);

  // Confirmation de suppression (destructive, réf. UX5.2)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [scheduleToDeleteId, setScheduleToDeleteId] = useState<number | null>(null);

  // Glisser-déposer depuis la bibliothèque rapide (UX3.14)
  const [dragPayload, setDragPayload] = useState<{ type: TargetType; id: number } | null>(null);
  const [dragOverDay, setDragOverDay] = useState<number | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [librarySearch, setLibrarySearch] = useState("");

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const weekEndExclusive = useMemo(() => addDays(weekStart, 7), [weekStart]);

  const fetchOccurrences = async (start: Date, end: Date) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
      const res = await fetch(getApiUrl(`/schedule/occurrences?${params.toString()}`), { cache: "no-store" });
      if (res.ok) {
        setOccurrences(await res.json());
      } else {
        showToast("Erreur de chargement du planning", "error");
      }
    } catch {
      showToast("Erreur réseau (planning)", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOccurrences(weekStart, weekEndExclusive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  useEffect(() => {
    fetch(getApiUrl("/videos?sort_by=imported_at&order=desc"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setVideos)
      .catch(() => setVideos([]));
    fetch(getApiUrl("/playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, []);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const todayRef = new Date();

  const occurrencesByDay = useMemo(
    () =>
      weekDays.map((day) =>
        occurrences
          .filter((o) => isSameLocalDay(new Date(o.run_at), day))
          .sort((a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime())
      ),
    [occurrences, weekDays]
  );

  const sortedOccurrences = useMemo(
    () => [...occurrences].sort((a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime()),
    [occurrences]
  );

  const findVideo = (id: number) => videos.find((v) => v.id === id);
  const findPlaylist = (id: number) => playlists.find((p) => p.id === id);

  const targetOptions: { id: number; label: string }[] = useMemo(
    () =>
      formTargetType === "video"
        ? videos.map((v) => ({ id: v.id, label: v.title }))
        : playlists.map((p) => ({ id: p.id, label: p.name })),
    [formTargetType, videos, playlists]
  );

  const filteredVideos = videos.filter((v) => v.title.toLowerCase().includes(librarySearch.toLowerCase()));
  const filteredPlaylists = playlists.filter((p) => p.name.toLowerCase().includes(librarySearch.toLowerCase()));

  // --------------------------------------------------------------------
  // Navigation semaine
  // --------------------------------------------------------------------
  const goToPreviousWeek = () => setWeekStart((prev) => addDays(prev, -7));
  const goToNextWeek = () => setWeekStart((prev) => addDays(prev, 7));
  const goToToday = () => setWeekStart(getWeekStart(new Date()));

  // --------------------------------------------------------------------
  // Tiroir : création / édition d'une programmation
  // --------------------------------------------------------------------
  const resetForm = () => {
    setFormTargetType("video");
    setFormTargetId("");
    setFormTargetSearch("");
    setFormScheduleType("once");
    setFormDateTime("");
    setFormDaysOfWeek([]);
    setFormTime("18:00");
    setFormActive(true);
    setEditingOverrideCount(0);
  };

  const openCreateDrawer = (presetDate?: Date, preset?: { type: TargetType; id: number }) => {
    resetForm();
    setEditingId(null);
    if (presetDate) {
      const withTime = new Date(presetDate);
      withTime.setHours(withTime.getHours() + 1, 0, 0, 0);
      setFormDateTime(toDatetimeLocalValue(withTime));
    }
    if (preset) {
      setFormTargetType(preset.type);
      setFormTargetId(String(preset.id));
    }
    setDrawerOpen(true);
  };

  const openEditDrawer = async (scheduleId: number) => {
    try {
      const res = await fetch(getApiUrl(`/schedule/${scheduleId}`), { cache: "no-store" });
      if (!res.ok) {
        showToast("Impossible de charger cette programmation", "error");
        return;
      }
      const data: ScheduleDetail = await res.json();
      setEditingId(data.id);
      setFormTargetType(data.target_type);
      setFormTargetId(String(data.target_id));
      setFormTargetSearch("");
      setFormScheduleType(data.schedule_type);
      setFormDateTime(data.run_at ? toDatetimeLocalValue(new Date(data.run_at)) : "");
      setFormDaysOfWeek(data.days_of_week ?? []);
      setFormTime(data.time_of_day ?? "18:00");
      setFormActive(data.active);
      setEditingOverrideCount(data.override_count);
      setDrawerOpen(true);
    } catch {
      showToast("Erreur réseau", "error");
    }
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
  };

  const toggleFormDay = (day: number) => {
    setFormDaysOfWeek((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  };

  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTargetId) {
      showToast("Choisissez un cours ou une playlist", "warning");
      return;
    }
    if (formScheduleType === "once" && !formDateTime) {
      showToast("Choisissez une date et une heure", "warning");
      return;
    }
    if (formScheduleType === "recurring" && formDaysOfWeek.length === 0) {
      showToast("Choisissez au moins un jour de la semaine", "warning");
      return;
    }

    const payload: Record<string, unknown> = {
      target_type: formTargetType,
      target_id: Number(formTargetId),
      schedule_type: formScheduleType,
      active: formActive,
    };
    if (formScheduleType === "once") {
      payload.run_at = new Date(formDateTime).toISOString();
    } else {
      payload.days_of_week = formDaysOfWeek;
      payload.time_of_day = formTime;
    }

    setIsSaving(true);
    try {
      const url = editingId ? getApiUrl(`/schedule/${editingId}`) : getApiUrl("/schedule");
      const method = editingId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        showToast(editingId ? "Programmation mise à jour" : "Programmation créée");
        closeDrawer();
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        const data = await res.json().catch(() => null);
        showToast(data?.detail || "Erreur de sauvegarde", "error");
      }
    } catch {
      showToast("Erreur réseau lors de la sauvegarde", "error");
    } finally {
      setIsSaving(false);
    }
  };

  const triggerDeleteSchedule = () => {
    if (!editingId) return;
    setScheduleToDeleteId(editingId);
    setShowDeleteConfirm(true);
  };

  const confirmDeleteSchedule = async () => {
    if (!scheduleToDeleteId) return;
    try {
      const res = await fetch(getApiUrl(`/schedule/${scheduleToDeleteId}`), { method: "DELETE" });
      if (res.ok) {
        showToast("Programmation supprimée");
        closeDrawer();
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast("Impossible de supprimer la programmation", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      setShowDeleteConfirm(false);
      setScheduleToDeleteId(null);
    }
  };

  // --------------------------------------------------------------------
  // Overrides — actions rapides sur une occurrence (UX3.15)
  // --------------------------------------------------------------------
  const occurrenceKey = (o: Occurrence) => `${o.schedule_id}-${o.run_at}`;

  const handleCancelOccurrence = async (o: Occurrence) => {
    try {
      const res = await fetch(getApiUrl(`/schedule/${o.schedule_id}/overrides`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurrence_date: toOccurrenceDateString(o.run_at), action: "cancelled" }),
      });
      if (res.ok) {
        showToast("Occurrence annulée");
        setExpandedKey(null);
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast("Impossible d'annuler cette occurrence", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  };

  const handleRestoreOccurrence = async (o: Occurrence) => {
    if (!o.override_id) return;
    try {
      const res = await fetch(getApiUrl(`/schedule/${o.schedule_id}/overrides/${o.override_id}`), {
        method: "DELETE",
      });
      if (res.ok) {
        showToast("Occurrence rétablie");
        setExpandedKey(null);
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast("Impossible de rétablir cette occurrence", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  };

  const handleConfirmReplace = async (o: Occurrence) => {
    if (!replaceValue) return;
    const [type, idStr] = replaceValue.split(":");
    try {
      const res = await fetch(getApiUrl(`/schedule/${o.schedule_id}/overrides`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          occurrence_date: toOccurrenceDateString(o.run_at),
          action: "replaced",
          replacement_target_type: type,
          replacement_target_id: Number(idStr),
        }),
      });
      if (res.ok) {
        showToast("Occurrence remplacée");
        setReplacingKey(null);
        setExpandedKey(null);
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast("Impossible de remplacer cette occurrence", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  };

  // --------------------------------------------------------------------
  // Glisser-déposer bibliothèque -> jour (UX3.14)
  // --------------------------------------------------------------------
  const handleDropOnDay = (dayIndex: number) => {
    setDragOverDay(null);
    if (!dragPayload) return;
    openCreateDrawer(weekDays[dayIndex], dragPayload);
    setDragPayload(null);
  };

  const getProgramAccent = (program: string | null) => (program && PROGRAM_ACCENT[program]) || "var(--text-dim)";

  const renderOccurrenceChip = (o: Occurrence, compact: boolean) => {
    const key = occurrenceKey(o);
    const isExpanded = expandedKey === key;
    const isCancelled = o.override_action === "cancelled";
    const isReplaced = o.override_action === "replaced";
    const isRecurring = o.schedule_type === "recurring";

    return (
      <div
        key={key}
        className={`schedule-occurrence-chip ${isCancelled ? "cancelled" : ""}`}
        style={{ borderLeftColor: getProgramAccent(o.program) }}
        onClick={(e) => {
          e.stopPropagation();
          setReplacingKey(null);
          setExpandedKey(isExpanded ? null : key);
        }}
      >
        <div className="schedule-occurrence-time">
          {formatOccurrenceTime(o.run_at)}
          {compact && ` · ${DAY_LABELS_FULL[(new Date(o.run_at).getDay() + 6) % 7]}`}
        </div>
        <div className="schedule-occurrence-title">{o.title ?? "Cible introuvable"}</div>
        {isReplaced && <span className="schedule-occurrence-badge">Remplacé</span>}
        {isCancelled && <span className="schedule-occurrence-badge">Annulé</span>}

        {isExpanded && (
          <div className="schedule-occurrence-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openEditDrawer(o.schedule_id)}
            >
              Modifier la série
            </button>
            {isRecurring && !isCancelled && !isReplaced && (
              <button type="button" className="btn btn-secondary" onClick={() => handleCancelOccurrence(o)}>
                Annuler cette occurrence
              </button>
            )}
            {isRecurring && (isCancelled || isReplaced) && (
              <button type="button" className="btn btn-secondary" onClick={() => handleRestoreOccurrence(o)}>
                Rétablir cette occurrence
              </button>
            )}
            {isRecurring && !isCancelled && (
              <>
                {replacingKey === key ? (
                  <>
                    <select
                      className="filter-select"
                      value={replaceValue}
                      onChange={(e) => setReplaceValue(e.target.value)}
                      style={{ width: "100%", height: "26px", fontSize: "0.7rem" }}
                    >
                      <option value="">Remplacer par...</option>
                      <optgroup label="Vidéos">
                        {videos.map((v) => (
                          <option key={`v-${v.id}`} value={`video:${v.id}`}>
                            {v.title}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Playlists">
                        {playlists.map((p) => (
                          <option key={`p-${p.id}`} value={`playlist:${p.id}`}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <button type="button" className="btn btn-primary" onClick={() => handleConfirmReplace(o)}>
                      Confirmer le remplacement
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setReplaceValue("");
                      setReplacingKey(key);
                    }}
                  >
                    Remplacer cette occurrence
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="schedule-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      )}

      <div className="schedule-toolbar">
        <div className="week-nav">
          <button className="btn btn-secondary" onClick={goToPreviousWeek} title="Semaine précédente">
            ← Préc.
          </button>
          <button className="btn btn-secondary" onClick={goToToday}>
            Aujourd&apos;hui
          </button>
          <button className="btn btn-secondary" onClick={goToNextWeek} title="Semaine suivante">
            Suiv. →
          </button>
          <span className="week-nav-label">{formatWeekLabel(weekStart)}</span>
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div className="view-toggle">
            <button
              className={`view-btn ${viewMode === "calendar" ? "active" : ""}`}
              onClick={() => setViewMode("calendar")}
              title="Vue calendrier"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              className={`view-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title="Vue liste"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
          <button className="btn btn-primary" onClick={() => openCreateDrawer()}>
            + Nouvelle programmation
          </button>
        </div>
      </div>

      <div className="schedule-body" style={{ flexDirection: "row", gap: "20px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {loading ? (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
              Chargement du planning...
            </div>
          ) : viewMode === "calendar" ? (
            <div className="schedule-week-grid">
              {weekDays.map((day, index) => {
                const isToday = isSameLocalDay(day, todayRef);
                return (
                  <div
                    key={index}
                    className={`schedule-day-column ${isToday ? "today" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverDay(index);
                    }}
                    onDragLeave={() => setDragOverDay(null)}
                    onDrop={() => handleDropOnDay(index)}
                  >
                    <div className="schedule-day-header">
                      <span className="schedule-day-header-name">{DAY_LABELS_FULL[index]}</span>
                      <span className="schedule-day-header-date">{day.getDate()}</span>
                    </div>
                    <div
                      className={`schedule-day-body ${dragOverDay === index ? "drag-over" : ""}`}
                      onClick={() => openCreateDrawer(day)}
                    >
                      {occurrencesByDay[index].length === 0 ? (
                        <div className="schedule-day-empty-hint">Cliquez ou glissez un cours ici</div>
                      ) : (
                        occurrencesByDay[index].map((o) => renderOccurrenceChip(o, false))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="schedule-list-scroll">
              {sortedOccurrences.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  Aucune programmation cette semaine.
                </div>
              ) : (
                weekDays.map((day, index) =>
                  occurrencesByDay[index].length === 0 ? null : (
                    <div key={index} className="schedule-list-day-group">
                      <div className="schedule-list-day-label">
                        {DAY_LABELS_FULL[index]} {day.getDate()}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {occurrencesByDay[index].map((o) => renderOccurrenceChip(o, true))}
                      </div>
                    </div>
                  )
                )
              )}
            </div>
          )}
        </div>

        {/* Bibliothèque rapide (glisser-déposer sur un jour, UX3.14) */}
        {libraryOpen && (
          <div className="library-picker" style={{ width: "260px", height: "auto", flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="form-label" style={{ margin: 0 }}>
                Bibliothèque rapide
              </span>
              <button className="close-btn" onClick={() => setLibraryOpen(false)} title="Masquer">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <input
              type="text"
              className="form-control"
              placeholder="Rechercher..."
              value={librarySearch}
              onChange={(e) => setLibrarySearch(e.target.value)}
              style={{ height: "32px", fontSize: "0.8rem" }}
            />
            <p style={{ fontSize: "0.7rem", color: "var(--text-dim)", margin: 0 }}>
              Glissez un élément sur un jour du calendrier pour créer une programmation.
            </p>
            <div className="library-picker-list">
              {filteredVideos.map((v) => (
                <div
                  key={`v-${v.id}`}
                  className="library-picker-item"
                  draggable
                  onDragStart={() => setDragPayload({ type: "video", id: v.id })}
                >
                  <span style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--text-main)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {v.title}
                  </span>
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>{formatDuration(v.duration_seconds)}</span>
                </div>
              ))}
              {filteredPlaylists.map((p) => (
                <div
                  key={`p-${p.id}`}
                  className="library-picker-item"
                  draggable
                  onDragStart={() => setDragPayload({ type: "playlist", id: p.id })}
                >
                  <span style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--text-main)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ▶ {p.name}
                  </span>
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>{p.item_count} cours</span>
                </div>
              ))}
              {filteredVideos.length === 0 && filteredPlaylists.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.75rem", padding: "12px" }}>
                  Aucun résultat.
                </div>
              )}
            </div>
          </div>
        )}
        {!libraryOpen && (
          <button
            className="btn btn-secondary"
            style={{ writingMode: "vertical-rl", height: "100%" }}
            onClick={() => setLibraryOpen(true)}
          >
            Bibliothèque
          </button>
        )}
      </div>

      {/* Tiroir de création / édition */}
      {drawerOpen && (
        <>
          <div className="detail-drawer-overlay" onClick={closeDrawer} />
          <div className="detail-drawer">
            <div className="drawer-header">
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>
                {editingId ? "Modifier la programmation" : "Nouvelle programmation"}
              </h3>
              <button className="close-btn" onClick={closeDrawer}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleSaveSchedule} className="drawer-body drawer-form">
              <div className="form-group">
                <label className="form-label">Cible</label>
                <div className="speed-group" style={{ width: "100%" }}>
                  <button
                    type="button"
                    className={`speed-btn ${formTargetType === "video" ? "active" : ""}`}
                    style={{ flex: 1 }}
                    onClick={() => {
                      setFormTargetType("video");
                      setFormTargetId("");
                    }}
                  >
                    Vidéo
                  </button>
                  <button
                    type="button"
                    className={`speed-btn ${formTargetType === "playlist" ? "active" : ""}`}
                    style={{ flex: 1 }}
                    onClick={() => {
                      setFormTargetType("playlist");
                      setFormTargetId("");
                    }}
                  >
                    Playlist
                  </button>
                </div>
              </div>

              <div className="form-group">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Rechercher..."
                  value={formTargetSearch}
                  onChange={(e) => setFormTargetSearch(e.target.value)}
                />
                <div className="library-picker-list" style={{ maxHeight: "160px" }}>
                  {targetOptions
                    .filter((opt) => opt.label.toLowerCase().includes(formTargetSearch.toLowerCase()))
                    .map((opt) => {
                      const selected = String(opt.id) === formTargetId;
                      return (
                        <div
                          key={opt.id}
                          className="library-picker-item"
                          style={{
                            cursor: "pointer",
                            borderColor: selected ? "var(--accent-primary)" : undefined,
                            background: selected ? "rgba(228, 0, 43, 0.08)" : undefined,
                          }}
                          onClick={() => setFormTargetId(String(opt.id))}
                        >
                          <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main)" }}>{opt.label}</span>
                        </div>
                      );
                    })}
                </div>
                {formTargetId && (
                  <span style={{ fontSize: "0.75rem", color: "var(--accent-success)" }}>
                    Sélectionné :{" "}
                    {formTargetType === "video" ? findVideo(Number(formTargetId))?.title : findPlaylist(Number(formTargetId))?.name}
                  </span>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Type de programmation</label>
                <div className="speed-group" style={{ width: "100%" }}>
                  <button
                    type="button"
                    className={`speed-btn ${formScheduleType === "once" ? "active" : ""}`}
                    style={{ flex: 1 }}
                    onClick={() => setFormScheduleType("once")}
                  >
                    Ponctuelle
                  </button>
                  <button
                    type="button"
                    className={`speed-btn ${formScheduleType === "recurring" ? "active" : ""}`}
                    style={{ flex: 1 }}
                    onClick={() => setFormScheduleType("recurring")}
                  >
                    Récurrente
                  </button>
                </div>
              </div>

              {formScheduleType === "once" ? (
                <div className="form-group">
                  <label className="form-label">Date et heure</label>
                  <input
                    type="datetime-local"
                    className="form-control"
                    value={formDateTime}
                    onChange={(e) => setFormDateTime(e.target.value)}
                  />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">Jours de la semaine</label>
                    <div className="speed-group" style={{ width: "100%" }}>
                      {DAY_LABELS.map((label, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className={`speed-btn ${formDaysOfWeek.includes(idx) ? "active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => toggleFormDay(idx)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Heure</label>
                    <input
                      type="time"
                      className="form-control"
                      value={formTime}
                      onChange={(e) => setFormTime(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="form-group" style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
                <input
                  type="checkbox"
                  checked={formActive}
                  onChange={(e) => setFormActive(e.target.checked)}
                  style={{ width: "18px", height: "18px" }}
                />
                <label className="form-label" style={{ margin: 0 }}>
                  Active
                </label>
              </div>

              {editingId && editingOverrideCount > 0 && (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {editingOverrideCount} occurrence(s) avec exception (annulée ou remplacée) — gérables directement
                  depuis le planning.
                </p>
              )}

              <div className="drawer-actions">
                <button type="submit" className="btn btn-primary" disabled={isSaving}>
                  {isSaving ? "Enregistrement..." : "Enregistrer"}
                </button>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} disabled={isSaving}>
                  Annuler
                </button>
                {editingId && (
                  <button type="button" className="btn btn-danger" onClick={triggerDeleteSchedule} disabled={isSaving}>
                    Supprimer la programmation
                  </button>
                )}
              </div>
            </form>
          </div>
        </>
      )}

      {/* Confirmation de suppression (destructive, réf. UX5.2) */}
      {showDeleteConfirm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>Supprimer la programmation ?</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.5 }}>
              Cette action est irréversible et supprime également toutes les exceptions (overrides) associées.
            </p>
            <div className="modal-actions">
              <button className="btn btn-danger" onClick={confirmDeleteSchedule}>
                Supprimer
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setScheduleToDeleteId(null);
                }}
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
