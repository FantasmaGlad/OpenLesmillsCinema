"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/lib/useIsMobile";
import { useAppSettings } from "@/lib/AppSettingsContext";
import type { Language } from "@/lib/i18n";
import Icon from "@/components/Icon";

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

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
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

function formatWeekLabel(weekStart: Date, language: Language) {
  const weekEnd = addDays(weekStart, 6);
  const locale = language === "fr" ? "fr-FR" : "en-US";
  const fmt = (d: Date) => d.toLocaleDateString(locale, { day: "numeric", month: "short" });
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
  const { t, tList, language } = useAppSettings();
  const DAY_LABELS = tList("schedule.dayLabels");
  const DAY_LABELS_FULL = tList("schedule.dayLabelsFull");
  const [viewMode, setViewMode] = useState<"calendar" | "list">("calendar");
  // Planning PAR CANAL de diffusion (réf. mission "un planning pour le Câblé
  // et un pour le Réseau, distincts") : l'onglet actif filtre tout — vue
  // calendrier, vue liste — et toute création se fait sur ce canal. Ouvrable
  // directement sur un canal donné via ?channel= (liens des tableaux de bord).
  const [channel, setChannel] = useState<"cable" | "network">(() => {
    if (typeof window === "undefined") return "cable";
    return new URLSearchParams(window.location.search).get("channel") === "network" ? "network" : "cable";
  });

  // La grille calendrier à 7 colonnes n'est pas exploitable sur un écran de
  // téléphone (réf. UX4.1 "présentation adaptée") : bascule sur la vue liste
  // déjà existante (UX3.16), sans empêcher l'utilisateur de revenir à la
  // grille manuellement ensuite via le même bouton que sur PC.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronise avec le viewport (matchMedia), motif déjà accepté ailleurs (useIsMobile, ClientLayout)
    if (isMobile) setViewMode("list");
  }, [isMobile]);

  // Bibliothèque rapide glisser-déposer (UX3.14) : repliée par défaut sur
  // téléphone (réf. mission "Double Planning", màj mobile) — le
  // glisser-déposer HTML5 ne fonctionne pas au toucher, la garder ouverte
  // n'y mangerait que de la place utile sans rien apporter.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- même motif que viewMode ci-dessus
    if (isMobile) setLibraryOpen(false);
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
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const weekEndExclusive = useMemo(() => addDays(weekStart, 7), [weekStart]);

  const fetchOccurrences = async (start: Date, end: Date) => {
    await Promise.resolve();
    setLoading(true);
    try {
      const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), channel });
      const res = await fetch(getApiUrl(`/schedule/occurrences?${params.toString()}`), { cache: "no-store" });
      if (res.ok) {
        setOccurrences(await res.json());
      } else {
        showToast(t("schedule.fetchError"), "error");
      }
    } catch {
      showToast(t("schedule.fetchNetworkError"), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchOccurrences(weekStart, weekEndExclusive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, channel]);

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
        showToast(t("schedule.loadScheduleError"), "error");
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
      showToast(t("schedule.networkError"), "error");
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
      showToast(t("schedule.chooseTargetWarning"), "warning");
      return;
    }
    if (formScheduleType === "once" && !formDateTime) {
      showToast(t("schedule.chooseDateTimeWarning"), "warning");
      return;
    }
    if (formScheduleType === "recurring" && formDaysOfWeek.length === 0) {
      showToast(t("schedule.chooseDayWarning"), "warning");
      return;
    }

    const payload: Record<string, unknown> = {
      target_type: formTargetType,
      target_id: Number(formTargetId),
      schedule_type: formScheduleType,
      active: formActive,
      // Une programmation appartient au canal de l'onglet actif (réf.
      // mission "un planning pour le Câblé et un pour le Réseau").
      channel,
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
        showToast(editingId ? t("schedule.updatedToast") : t("schedule.createdToast"));
        closeDrawer();
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        const data = await res.json().catch(() => null);
        showToast(data?.detail || t("schedule.saveError"), "error");
      }
    } catch {
      showToast(t("schedule.saveNetworkError"), "error");
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
        showToast(t("schedule.deletedToast"));
        closeDrawer();
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast(t("schedule.deleteError"), "error");
      }
    } catch {
      showToast(t("schedule.networkError"), "error");
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
        showToast(t("schedule.cancelledToast"));
        setExpandedKey(null);
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast(t("schedule.cancelError"), "error");
      }
    } catch {
      showToast(t("schedule.networkError"), "error");
    }
  };

  const handleRestoreOccurrence = async (o: Occurrence) => {
    if (!o.override_id) return;
    try {
      const res = await fetch(getApiUrl(`/schedule/${o.schedule_id}/overrides/${o.override_id}`), {
        method: "DELETE",
      });
      if (res.ok) {
        showToast(t("schedule.restoredToast"));
        setExpandedKey(null);
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast(t("schedule.restoreError"), "error");
      }
    } catch {
      showToast(t("schedule.networkError"), "error");
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
        showToast(t("schedule.replacedToast"));
        setReplacingKey(null);
        setExpandedKey(null);
        fetchOccurrences(weekStart, weekEndExclusive);
      } else {
        showToast(t("schedule.replaceError"), "error");
      }
    } catch {
      showToast(t("schedule.networkError"), "error");
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

  // Couleur du thème plutôt que du programme du cours (réf. correctif
  // "couleurs hardcodées associées à un cours" — le thème prime désormais).
  const getProgramAccent = () => "var(--accent-primary)";

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
        style={{ borderLeftColor: getProgramAccent() }}
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
        <div className="schedule-occurrence-title">{o.title ?? t("schedule.targetNotFound")}</div>
        {isReplaced && <span className="schedule-occurrence-badge">{t("schedule.replacedBadge")}</span>}
        {isCancelled && <span className="schedule-occurrence-badge">{t("schedule.cancelledBadge")}</span>}

        {isExpanded && (
          <div className="schedule-occurrence-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openEditDrawer(o.schedule_id)}
            >
              {t("schedule.editSeries")}
            </button>
            {isRecurring && !isCancelled && !isReplaced && (
              <button type="button" className="btn btn-secondary" onClick={() => handleCancelOccurrence(o)}>
                {t("schedule.cancelOccurrence")}
              </button>
            )}
            {isRecurring && (isCancelled || isReplaced) && (
              <button type="button" className="btn btn-secondary" onClick={() => handleRestoreOccurrence(o)}>
                {t("schedule.restoreOccurrence")}
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
                      <option value="">{t("schedule.replaceWith")}</option>
                      <optgroup label={t("schedule.videosGroup")}>
                        {videos.map((v) => (
                          <option key={`v-${v.id}`} value={`video:${v.id}`}>
                            {v.title}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label={t("schedule.playlistsGroup")}>
                        {playlists.map((p) => (
                          <option key={`p-${p.id}`} value={`playlist:${p.id}`}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <button type="button" className="btn btn-primary" onClick={() => handleConfirmReplace(o)}>
                      {t("schedule.confirmReplace")}
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
                    {t("schedule.replaceOccurrence")}
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
        {/* Onglets de canal (réf. mission "un planning pour le Câblé et un
            pour le Réseau, distincts") : tout ce qui suit — calendrier,
            liste, créations — ne concerne que le canal sélectionné. */}
        <div className="view-toggle">
          <button
            className={`view-btn olc-press ${channel === "cable" ? "active" : ""}`}
            onClick={() => setChannel("cable")}
            title={t("schedule.channelCableTitle")}
            style={{ display: "flex", alignItems: "center", gap: "6px", padding: "0 12px" }}
          >
            <Icon name="cable" size={16} />
            {t("schedule.channelTabCable")}
          </button>
          <button
            className={`view-btn olc-press ${channel === "network" ? "active" : ""}`}
            onClick={() => setChannel("network")}
            title={t("schedule.channelNetworkTitle")}
            style={{ display: "flex", alignItems: "center", gap: "6px", padding: "0 12px" }}
          >
            <Icon name="wifi" size={16} />
            {t("schedule.channelTabNetwork")}
          </button>
        </div>
        <div className="week-nav">
          <button className="btn btn-secondary" onClick={goToPreviousWeek} title={t("schedule.previousWeekTitle")}>
            <Icon name="chevron_left" size={16} />
            {t("schedule.previousWeekShort")}
          </button>
          <button className="btn btn-secondary" onClick={goToToday}>
            {t("schedule.today")}
          </button>
          <button className="btn btn-secondary" onClick={goToNextWeek} title={t("schedule.nextWeekTitle")}>
            {t("schedule.nextWeekShort")}
            <Icon name="chevron_right" size={16} />
          </button>
          <span className="week-nav-label">{formatWeekLabel(weekStart, language)}</span>
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div className="view-toggle">
            <button
              className={`view-btn olc-press ${viewMode === "calendar" ? "active" : ""}`}
              onClick={() => setViewMode("calendar")}
              title={t("schedule.calendarView")}
            >
              <Icon name="calendar_month" size={18} />
            </button>
            <button
              className={`view-btn olc-press ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title={t("schedule.listView")}
            >
              <Icon name="view_list" size={18} />
            </button>
          </div>
          <button className="btn btn-primary" onClick={() => openCreateDrawer()}>
            <Icon name="add" size={18} />
            {t("schedule.newSchedule")}
          </button>
        </div>
      </div>

      <div className="schedule-body" style={{ flexDirection: isMobile ? "column" : "row", gap: "20px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {loading ? (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
              {t("schedule.loadingSchedule")}
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
                        <div className="schedule-day-empty-hint">{t("schedule.emptyDayHint")}</div>
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
                  {t("schedule.noScheduleThisWeek")}
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

        {/* Bibliothèque rapide (glisser-déposer sur un jour, UX3.14) : le
            glisser-déposer HTML5 n'existe pas au toucher, ce panneau reste
            surtout un raccourci de recherche sur téléphone — d'où la largeur
            pleine plutôt que la colonne fixe du PC. */}
        {libraryOpen && (
          <div className="library-picker" style={{ width: isMobile ? "100%" : "260px", height: "auto", flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="form-label" style={{ margin: 0 }}>
                {t("schedule.quickLibrary")}
              </span>
              <button className="close-btn" onClick={() => setLibraryOpen(false)} title={t("schedule.hide")}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <input
              type="text"
              className="form-control"
              placeholder={t("schedule.searchPlaceholder")}
              value={librarySearch}
              onChange={(e) => setLibrarySearch(e.target.value)}
              style={{ height: "32px", fontSize: "0.8rem" }}
            />
            <p style={{ fontSize: "0.7rem", color: "var(--text-dim)", margin: 0 }}>
              {t("schedule.dragHint")}
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
                  <span style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--text-main)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                    <Icon name="playlist_play" size={14} />
                    {p.name}
                  </span>
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>{t("schedule.coursesCount", { count: p.item_count })}</span>
                </div>
              ))}
              {filteredVideos.length === 0 && filteredPlaylists.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.75rem", padding: "12px" }}>
                  {t("schedule.noResults")}
                </div>
              )}
            </div>
          </div>
        )}
        {!libraryOpen && (
          <button
            className="btn btn-secondary"
            style={isMobile ? { width: "100%" } : { writingMode: "vertical-rl", height: "100%" }}
            onClick={() => setLibraryOpen(true)}
          >
            {t("schedule.libraryCollapsed")}
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
                {editingId ? t("schedule.editScheduleTitle") : t("schedule.newScheduleTitle")}
              </h3>
              <button className="close-btn" onClick={closeDrawer}>
                <Icon name="close" size={20} />
              </button>
            </div>
            <form onSubmit={handleSaveSchedule} className="drawer-body drawer-form">
              <div className="form-group">
                <label className="form-label">{t("schedule.targetLabel")}</label>
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
                    {t("schedule.videoOption")}
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
                    {t("schedule.playlistOption")}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <input
                  type="text"
                  className="form-control"
                  placeholder={t("schedule.searchPlaceholder")}
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
                            background: selected ? "color-mix(in srgb, var(--accent-primary) 8%, transparent)" : undefined,
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
                    {t("schedule.selectedLabel")}{" "}
                    {formTargetType === "video" ? findVideo(Number(formTargetId))?.title : findPlaylist(Number(formTargetId))?.name}
                  </span>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">{t("schedule.scheduleTypeLabel")}</label>
                <div className="speed-group" style={{ width: "100%" }}>
                  <button
                    type="button"
                    className={`speed-btn ${formScheduleType === "once" ? "active" : ""}`}
                    style={{ flex: 1 }}
                    onClick={() => setFormScheduleType("once")}
                  >
                    {t("schedule.onceOption")}
                  </button>
                  <button
                    type="button"
                    className={`speed-btn ${formScheduleType === "recurring" ? "active" : ""}`}
                    style={{ flex: 1 }}
                    onClick={() => setFormScheduleType("recurring")}
                  >
                    {t("schedule.recurringOption")}
                  </button>
                </div>
              </div>

              {formScheduleType === "once" ? (
                <div className="form-group">
                  <label className="form-label">{t("schedule.dateTimeLabel")}</label>
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
                    <label className="form-label">{t("schedule.daysOfWeekLabel")}</label>
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
                    <label className="form-label">{t("schedule.hourLabel")}</label>
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
                  {t("schedule.activeLabel")}
                </label>
              </div>

              {editingId && editingOverrideCount > 0 && (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {t("schedule.overrideCountHint", { count: editingOverrideCount })}
                </p>
              )}

              <div className="drawer-actions">
                <button type="submit" className="btn btn-primary" disabled={isSaving}>
                  {isSaving ? t("common.saving") : t("common.save")}
                </button>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} disabled={isSaving}>
                  {t("common.cancel")}
                </button>
                {editingId && (
                  <button type="button" className="btn btn-danger" onClick={triggerDeleteSchedule} disabled={isSaving}>
                    {t("schedule.deleteScheduleBtn")}
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
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>{t("schedule.deleteScheduleTitle")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.5 }}>
              {t("schedule.deleteScheduleConfirm")}
            </p>
            <div className="modal-actions">
              <button className="btn btn-danger" onClick={confirmDeleteSchedule}>
                {t("common.delete")}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setScheduleToDeleteId(null);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
