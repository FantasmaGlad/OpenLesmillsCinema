"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useUploadManager } from "@/lib/UploadManager";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import Icon from "@/components/Icon";

interface AudioTrack {
  id: number;
  number: number | null;
  title: string;
  duration_seconds: number | null;
  position: number;
}

interface AudioCourseSummary {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  background_id: number | null;
  track_count: number;
  total_duration_seconds: number;
}

interface AudioCourseDetail extends AudioCourseSummary {
  tracks: AudioTrack[];
}

interface BackgroundOption {
  id: number;
  title: string;
}

interface AudioPlaylistSummary {
  id: number;
  name: string;
  item_count: number;
  total_duration_seconds: number;
}

interface ToastState {
  message: string;
  type: "success" | "error" | "warning";
}

const PROGRAM_GROUPS = ["RPM", "Sprint", "The Trip", "Autre"];

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

function programBadgeClass(program: string | null) {
  if (!program) return "autre";
  const p = program.toLowerCase();
  if (p === "rpm") return "rpm";
  if (p === "sprint") return "sprint";
  if (p === "the trip" || p === "trip") return "the-trip";
  return "autre";
}

function programCardClass(program: string | null) {
  if (!program) return "program-autre";
  const p = program.toLowerCase();
  if (p === "rpm") return "program-rpm";
  if (p === "sprint") return "program-sprint";
  if (p === "the trip" || p === "trip") return "program-the-trip";
  return "program-autre";
}

export default function AudioLibraryPage() {
  const { t } = useAppSettings();
  const [courses, setCourses] = useState<AudioCourseSummary[]>([]);
  const [backgrounds, setBackgrounds] = useState<BackgroundOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [selected, setSelected] = useState<AudioCourseDetail | null>(null);
  const [drawerTitle, setDrawerTitle] = useState("");
  const [drawerProgram, setDrawerProgram] = useState("");
  const [drawerRelease, setDrawerRelease] = useState("");
  const [drawerBackgroundId, setDrawerBackgroundId] = useState<string>("");
  const [savingDrawer, setSavingDrawer] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const [toDelete, setToDelete] = useState<AudioCourseSummary | null>(null);

  const [uploadMode, setUploadMode] = useState<"files" | "zip">("files");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadZip, setUploadZip] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadProgram, setUploadProgram] = useState("RPM");
  const [uploadRelease, setUploadRelease] = useState("");
  const [dragActive, setDragActive] = useState(false);

  // Lanceur de playlist audio sur l'écran coach (déplacé depuis le tableau de
  // bord câblé, réf. demande) : actif uniquement quand le câblé est DÉJÀ en
  // mode coach — sinon on passe d'abord par « Passer en mode coach » (/coach).
  const { state: pbState, sendCommand: pbSend } = usePlaybackSocket();
  const [audioPlaylists, setAudioPlaylists] = useState<AudioPlaylistSummary[]>([]);
  const [coachPlaylistId, setCoachPlaylistId] = useState("");
  useEffect(() => {
    fetch(getApiUrl("/audio-playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setAudioPlaylists)
      .catch(() => setAudioPlaylists([]));
  }, []);
  const cableInCoach = pbState.state === "coach_mode";
  const launchCoachPlaylist = () => {
    if (!coachPlaylistId || !cableInCoach) return;
    pbSend("load_audio_playlist", { audio_playlist_id: Number(coachPlaylistId) });
  };
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Réf. mission "queue en direct des importations + import parallèle" :
  // l'import d'un cours (plusieurs MP3 ou une archive ZIP) est désormais
  // envoyé à la file globale d'imports puis le formulaire se réinitialise
  // immédiatement — l'ancienne version désactivait tout le formulaire
  // (`disabled={uploading}`) jusqu'à la fin de l'import, empêchant de
  // préparer/lancer un second cours en attendant que le premier termine.
  const { addUploads, uploads } = useUploadManager();
  const seenDoneIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newlyDone = uploads.filter(
      (u) => (u.kind === "audio_files" || u.kind === "audio_zip") && u.status === "done" && !seenDoneIds.current.has(u.id)
    );
    if (newlyDone.length === 0) return;
    newlyDone.forEach((u) => seenDoneIds.current.add(u.id));
    fetchCourses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads]);

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fetchCourses = async () => {
    setLoading(true);
    try {
      const res = await fetch(getApiUrl("/audio"), { cache: "no-store" });
      if (res.ok) setCourses(await res.json());
      else showToast(t("audio.fetchError"), "error");
    } catch {
      showToast(t("audio.connectionError"), "error");
    } finally {
      setLoading(false);
    }
  };

  const fetchBackgrounds = async () => {
    try {
      const res = await fetch(getApiUrl("/backgrounds"), { cache: "no-store" });
      if (res.ok) setBackgrounds(await res.json());
    } catch {
      // silencieux : l'association de fond animé reste optionnelle
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement initial, même motif que library/playlists/schedule
    fetchCourses();
    fetchBackgrounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCourse = async (courseId: number) => {
    const res = await fetch(getApiUrl(`/audio/${courseId}`), { cache: "no-store" });
    if (!res.ok) {
      showToast(t("audio.loadCourseError"), "error");
      return;
    }
    const detail: AudioCourseDetail = await res.json();
    setSelected(detail);
    setDrawerTitle(detail.title);
    setDrawerProgram(detail.program || "");
    setDrawerRelease(detail.release || "");
    setDrawerBackgroundId(detail.background_id ? String(detail.background_id) : "");
  };

  const closeDrawer = () => setSelected(null);

  const saveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setSavingDrawer(true);
    try {
      const res = await fetch(getApiUrl(`/audio/${selected.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: drawerTitle,
          program: drawerProgram || null,
          release: drawerRelease || null,
          background_id: drawerBackgroundId ? Number(drawerBackgroundId) : null,
          clear_background: !drawerBackgroundId,
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setSelected(updated);
        showToast(t("audio.updatedToast"));
        fetchCourses();
      } else {
        showToast(t("audio.saveError"), "error");
      }
    } finally {
      setSavingDrawer(false);
    }
  };

  const persistOrder = async (tracks: AudioTrack[]) => {
    if (!selected) return;
    await fetch(getApiUrl(`/audio/${selected.id}/tracks/reorder`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track_ids: tracks.map((t) => t.id) }),
    });
  };

  const handleDrop = (index: number) => {
    if (!selected || dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const reordered = [...selected.tracks];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(index, 0, moved);
    setSelected({ ...selected, tracks: reordered });
    setDragIndex(null);
    setDragOverIndex(null);
    persistOrder(reordered);
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      const res = await fetch(getApiUrl(`/audio/${toDelete.id}`), { method: "DELETE" });
      if (res.ok) {
        showToast(t("audio.deletedToast"));
        setCourses((prev) => prev.filter((c) => c.id !== toDelete.id));
        if (selected?.id === toDelete.id) setSelected(null);
      } else {
        showToast(t("audio.deleteError"), "error");
      }
    } finally {
      setToDelete(null);
    }
  };

  const resetUpload = () => {
    setUploadFiles([]);
    setUploadZip(null);
    setUploadTitle("");
    setUploadRelease("");
  };

  const handleFilesSelected = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (uploadMode === "zip") {
      const zip = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".zip")) || files[0];
      setUploadZip(zip);
      setUploadTitle(zip.name.replace(/\.zip$/i, "").replace(/[_-]/g, " "));
    } else {
      const mp3s = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".mp3"));
      setUploadFiles(mp3s);
      if (mp3s.length && !uploadTitle) {
        setUploadTitle(mp3s[0].name.replace(/\.mp3$/i, "").replace(/^\d+[\s._-]*/, "").split(/[_-]/)[0] || t("audio.newCourseFallback"));
      }
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(e.type === "dragenter" || e.type === "dragover");
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    handleFilesSelected(e.dataTransfer.files);
  };

  const executeUpload = () => {
    if (!uploadTitle.trim()) {
      showToast(t("audio.titleRequiredWarning"), "warning");
      return;
    }
    if (uploadMode === "files" && uploadFiles.length === 0) {
      showToast(t("audio.selectMp3Warning"), "warning");
      return;
    }
    if (uploadMode === "zip" && !uploadZip) {
      showToast(t("audio.selectZipWarning"), "warning");
      return;
    }

    if (uploadMode === "zip" && uploadZip) {
      addUploads([{ kind: "audio_zip", file: uploadZip, title: uploadTitle.trim(), program: uploadProgram, release: uploadRelease }]);
    } else {
      addUploads([{ kind: "audio_files", files: uploadFiles, title: uploadTitle.trim(), program: uploadProgram, release: uploadRelease }]);
    }
    // Le résultat (succès/échec) est visible en direct dans le panneau
    // d'imports flottant — le formulaire se libère immédiatement pour
    // permettre de préparer/lancer un autre cours sans attendre.
    resetUpload();
  };

  const grouped = PROGRAM_GROUPS.map((program) => ({
    program,
    courses: courses.filter((c) =>
      program === "Autre" ? !c.program || !PROGRAM_GROUPS.slice(0, 3).includes(c.program) : c.program === program
    ),
  })).filter((g) => g.courses.length > 0);

  return (
    <div className="library-container">
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      )}

      <div className="launch-block" style={{ marginBottom: "16px" }}>
        <h3>{t("audio.coachLaunchTitle")}</h3>
        <p className="live-block-hint" style={{ margin: "0 0 10px" }}>
          {cableInCoach ? t("audio.coachLaunchHint") : t("audio.coachLaunchDisabledHint")}
        </p>
        <div className="launch-row">
          <select
            className="filter-select"
            style={{ flex: 1 }}
            value={coachPlaylistId}
            onChange={(e) => setCoachPlaylistId(e.target.value)}
            disabled={!cableInCoach}
          >
            <option value="">{t("audio.coachChoosePlaylist")}</option>
            {audioPlaylists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.item_count} — {formatDuration(p.total_duration_seconds)})
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={launchCoachPlaylist}
            disabled={!cableInCoach || !coachPlaylistId}
          >
            <Icon name="queue_music" size={16} /> {t("audio.coachLaunch")}
          </button>
        </div>
      </div>

      <div
        className={`upload-zone ${dragActive ? "drag-active" : ""}`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleFileDrop}
        onClick={() => uploadFiles.length === 0 && !uploadZip && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={uploadMode === "zip" ? ".zip" : "audio/mpeg,.mp3"}
          multiple={uploadMode === "files"}
          style={{ display: "none" }}
          onChange={(e) => handleFilesSelected(e.target.files)}
        />

        {uploadFiles.length === 0 && !uploadZip ? (
          <>
            <div className="view-toggle" onClick={(e) => e.stopPropagation()} style={{ marginBottom: "8px" }}>
              <button
                type="button"
                className={`view-btn ${uploadMode === "files" ? "active" : ""}`}
                onClick={() => setUploadMode("files")}
              >
                {t("audio.mp3Files")}
              </button>
              <button
                type="button"
                className={`view-btn ${uploadMode === "zip" ? "active" : ""}`}
                onClick={() => setUploadMode("zip")}
              >
                {t("audio.zipArchive")}
              </button>
            </div>
            <Icon name="cloud_upload" size={48} className="upload-icon" />
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>
              {uploadMode === "files" ? t("audio.dropMp3Hint") : t("audio.dropZipHint")}
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
              {t("audio.trackOrderHint")}
            </p>
          </>
        ) : (
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "500px", textAlign: "left" }}>
            <div className="form-group">
              <label className="form-label">{t("audio.courseNameLabel")}</label>
              <input type="text" className="form-control" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: "12px", marginTop: "12px" }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t("audio.programLabel")}</label>
                <select className="form-control" value={uploadProgram} onChange={(e) => setUploadProgram(e.target.value)}>
                  <option value="RPM">RPM</option>
                  <option value="Sprint">Sprint</option>
                  <option value="The Trip">The Trip</option>
                  <option value="Autre">{t("audio.otherProgram")}</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t("audio.releaseLabel")}</label>
                <input type="text" className="form-control" placeholder={t("audio.releasePlaceholder")} value={uploadRelease} onChange={(e) => setUploadRelease(e.target.value)} />
              </div>
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "12px 0" }}>
              {uploadMode === "files"
                ? t("audio.mp3SelectedCount", { count: uploadFiles.length })
                : t("audio.zipArchiveLabel", { name: uploadZip?.name ?? "" })}
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <button type="button" className="btn btn-primary" onClick={executeUpload} style={{ flex: 1, height: "48px" }}>
                {t("audio.startImport")}
              </button>
              <button type="button" className="btn btn-secondary" onClick={resetUpload} style={{ height: "48px" }}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          {t("audio.loadingCourses")}
        </div>
      ) : courses.length === 0 ? (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{t("audio.noCoursesTitle")}</p>
          <p style={{ fontSize: "0.85rem", margin: "4px 0 0" }}>{t("audio.noCoursesHint")}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          {grouped.map((group) => (
            <div key={group.program}>
              {/* Couleur du thème plutôt que du programme (réf. correctif
                  "couleurs hardcodées associées à un cours"). */}
              <h3
                style={{
                  fontSize: "0.85rem",
                  marginBottom: "16px",
                  color: "var(--accent-primary)",
                }}
              >
                {group.program === "Autre" ? t("audio.otherProgram") : group.program}{" "}
                <span style={{ color: "var(--text-dim)" }}>({group.courses.length})</span>
              </h3>
              <div className="videos-grid">
                {group.courses.map((course) => (
                  <div key={course.id} className={`video-card ${programCardClass(course.program)}`} onClick={() => openCourse(course.id)}>
                    <div className="thumbnail-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-surface-elevated)" }}>
                      <Icon name="library_music" size={40} style={{ opacity: 0.25 }} />
                      <span className="card-duration">{t("audio.tracksCount", { count: course.track_count })}</span>
                    </div>
                    <div className="card-content">
                      <h4 className="card-title" title={course.title}>{course.title}</h4>
                      <div className="card-meta-row">
                        <span className={`program-badge ${programBadgeClass(course.program)}`}>{course.program || t("audio.otherProgram")}</span>
                        <span className="release-badge">{formatDuration(course.total_duration_seconds)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <>
          <div className="detail-drawer-overlay" onClick={closeDrawer} />
          <div className="detail-drawer">
            <div className="drawer-header">
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "80%" }}>
                {selected.title}
              </h3>
              <button className="close-btn" onClick={closeDrawer}>
                <Icon name="close" size={20} />
              </button>
            </div>
            <div className="drawer-body">
              <form className="drawer-form" onSubmit={saveMetadata}>
                <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "0 0 8px" }}>
                  {t("audio.metadataSectionTitle")}
                </h4>
                <div className="form-group">
                  <label className="form-label">{t("audio.titleLabel")}</label>
                  <input type="text" className="form-control" value={drawerTitle} onChange={(e) => setDrawerTitle(e.target.value)} required />
                </div>
                <div style={{ display: "flex", gap: "12px" }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t("audio.programLabel")}</label>
                    <select className="form-control" value={drawerProgram} onChange={(e) => setDrawerProgram(e.target.value)}>
                      <option value="">{t("audio.noneOption")}</option>
                      <option value="RPM">RPM</option>
                      <option value="Sprint">Sprint</option>
                      <option value="The Trip">The Trip</option>
                      <option value="Autre">{t("audio.otherProgram")}</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t("audio.releaseLabel")}</label>
                    <input type="text" className="form-control" value={drawerRelease} onChange={(e) => setDrawerRelease(e.target.value)} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">{t("audio.backgroundAssociationLabel")}</label>
                  <select className="form-control" value={drawerBackgroundId} onChange={(e) => setDrawerBackgroundId(e.target.value)}>
                    <option value="">{t("audio.noBackgroundOption")}</option>
                    {backgrounds.map((bg) => (
                      <option key={bg.id} value={bg.id}>{bg.title}</option>
                    ))}
                  </select>
                </div>

                <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "16px 0 8px" }}>
                  {t("audio.tracksSectionTitle", { count: selected.tracks.length })}
                </h4>
                <div className="drag-drop-zone" style={{ minHeight: "80px" }}>
                  {selected.tracks.map((track, index) => (
                    <div
                      key={track.id}
                      className={`playlist-drag-item ${dragIndex === index ? "dragging" : ""} ${dragOverIndex === index ? "drag-over-item" : ""}`}
                      draggable
                      onDragStart={() => setDragIndex(index)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverIndex(index);
                      }}
                      onDrop={() => handleDrop(index)}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setDragOverIndex(null);
                      }}
                    >
                      <span className="drag-handle"><Icon name="drag_indicator" size={16} /></span>
                      <span style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>
                        {index + 1}. {track.title}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>{formatDuration(track.duration_seconds)}</span>
                    </div>
                  ))}
                </div>

                <div className="drawer-actions">
                  <button type="submit" className="btn btn-primary" style={{ flex: 1, height: "48px" }} disabled={savingDrawer}>
                    {savingDrawer ? t("common.saving") : t("common.save")}
                  </button>
                  <button type="button" className="btn btn-danger" style={{ height: "48px" }} onClick={() => setToDelete(selected)}>
                    {t("common.delete")}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}

      {toDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("audio.deleteCourseTitle")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              {t("audio.deleteCourseConfirmBefore")}{" "}
              <strong style={{ color: "var(--text-main)" }}>{toDelete.title}</strong>{" "}
              {t("audio.deleteCourseConfirmAfter", { count: toDelete.track_count })}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setToDelete(null)}>{t("common.cancel")}</button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmDelete}>
                {t("audio.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
