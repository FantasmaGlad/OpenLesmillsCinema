"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";

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

interface ToastState {
  message: string;
  type: "success" | "error" | "warning";
}

const PROGRAM_GROUPS = ["RPM", "Sprint", "The Trip", "Autre"];

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8000/api${path}`;
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
  const { sendCommand } = usePlaybackSocket();
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
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      else showToast("Erreur lors de la récupération des cours audio", "error");
    } catch {
      showToast("Impossible de se connecter au serveur", "error");
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
      showToast("Impossible de charger le cours", "error");
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
        showToast("Cours audio mis à jour");
        fetchCourses();
      } else {
        showToast("Erreur lors de la sauvegarde", "error");
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

  const launchCoach = (courseId: number) => {
    sendCommand("load_audio_course", { audio_course_id: courseId });
    showToast("Mode coach lancé sur l'écran cinéma");
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      const res = await fetch(getApiUrl(`/audio/${toDelete.id}`), { method: "DELETE" });
      if (res.ok) {
        showToast("Cours audio supprimé");
        setCourses((prev) => prev.filter((c) => c.id !== toDelete.id));
        if (selected?.id === toDelete.id) setSelected(null);
      } else {
        showToast("Impossible de supprimer le cours", "error");
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
        setUploadTitle(mp3s[0].name.replace(/\.mp3$/i, "").replace(/^\d+[\s._-]*/, "").split(/[_-]/)[0] || "Nouveau cours");
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

  const executeUpload = async () => {
    if (!uploadTitle.trim()) {
      showToast("Le titre du cours est requis", "warning");
      return;
    }
    if (uploadMode === "files" && uploadFiles.length === 0) {
      showToast("Sélectionnez au moins un fichier MP3", "warning");
      return;
    }
    if (uploadMode === "zip" && !uploadZip) {
      showToast("Sélectionnez une archive ZIP", "warning");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("title", uploadTitle.trim());
      if (uploadProgram) formData.append("program", uploadProgram);
      if (uploadRelease) formData.append("release", uploadRelease);

      let endpoint = "/audio/upload";
      if (uploadMode === "zip" && uploadZip) {
        formData.append("file", uploadZip);
        endpoint = "/audio/upload-zip";
      } else {
        uploadFiles.forEach((f) => formData.append("files", f));
      }

      const res = await fetch(getApiUrl(endpoint), { method: "POST", body: formData });
      if (res.ok) {
        showToast("Cours audio importé avec succès !");
        resetUpload();
        fetchCourses();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Erreur lors de l'importation", "error");
      }
    } catch {
      showToast("Erreur réseau pendant l'upload", "error");
    } finally {
      setUploading(false);
    }
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
                Fichiers MP3
              </button>
              <button
                type="button"
                className={`view-btn ${uploadMode === "zip" ? "active" : ""}`}
                onClick={() => setUploadMode("zip")}
              >
                Archive ZIP
              </button>
            </div>
            <svg className="w-10 h-10 upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ width: "40px", height: "40px" }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>
              {uploadMode === "files"
                ? "Glissez les MP3 d'un cours ici ou cliquez pour parcourir"
                : "Glissez l'archive ZIP d'un cours ici ou cliquez pour parcourir"}
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
              L&apos;ordre des pistes est déduit du nom des fichiers, réordonnable ensuite.
            </p>
          </>
        ) : (
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "500px", textAlign: "left" }}>
            <div className="form-group">
              <label className="form-label">Nom du cours</label>
              <input type="text" className="form-control" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} disabled={uploading} />
            </div>
            <div style={{ display: "flex", gap: "12px", marginTop: "12px" }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Programme</label>
                <select className="form-control" value={uploadProgram} onChange={(e) => setUploadProgram(e.target.value)} disabled={uploading}>
                  <option value="RPM">RPM</option>
                  <option value="Sprint">Sprint</option>
                  <option value="The Trip">The Trip</option>
                  <option value="Autre">Autre</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Release</label>
                <input type="text" className="form-control" placeholder="Ex: 110" value={uploadRelease} onChange={(e) => setUploadRelease(e.target.value)} disabled={uploading} />
              </div>
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "12px 0" }}>
              {uploadMode === "files"
                ? `${uploadFiles.length} fichier(s) MP3 sélectionné(s)`
                : `Archive : ${uploadZip?.name}`}
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <button type="button" className="btn btn-primary" onClick={executeUpload} disabled={uploading} style={{ flex: 1, height: "48px" }}>
                {uploading ? "Importation..." : "Lancer l'importation"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={resetUpload} disabled={uploading} style={{ height: "48px" }}>
                Annuler
              </button>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          Chargement des cours audio...
        </div>
      ) : courses.length === 0 ? (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Aucun cours audio importé</p>
          <p style={{ fontSize: "0.85rem", margin: "4px 0 0" }}>Importez les MP3 d&apos;un cours donné en physique par un coach</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          {grouped.map((group) => (
            <div key={group.program}>
              <h3
                style={{
                  fontSize: "0.85rem",
                  marginBottom: "16px",
                  color:
                    group.program === "RPM"
                      ? "var(--accent-rpm)"
                      : group.program === "Sprint"
                      ? "var(--accent-sprint)"
                      : group.program === "The Trip"
                      ? "var(--accent-trip)"
                      : "var(--text-muted)",
                }}
              >
                {group.program} <span style={{ color: "var(--text-dim)" }}>({group.courses.length})</span>
              </h3>
              <div className="videos-grid">
                {group.courses.map((course) => (
                  <div key={course.id} className={`video-card ${programCardClass(course.program)}`} onClick={() => openCourse(course.id)}>
                    <div className="thumbnail-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#0c0c0e" }}>
                      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.25, width: "40px", height: "40px" }}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                      </svg>
                      <span className="card-duration">{course.track_count} piste(s)</span>
                    </div>
                    <div className="card-content">
                      <h4 className="card-title" title={course.title}>{course.title}</h4>
                      <div className="card-meta-row">
                        <span className={`program-badge ${programBadgeClass(course.program)}`}>{course.program || "Autre"}</span>
                        <span className="release-badge">{formatDuration(course.total_duration_seconds)}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ marginTop: "8px", height: "36px" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          launchCoach(course.id);
                        }}
                      >
                        Lancer le mode coach
                      </button>
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
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="drawer-body">
              <form className="drawer-form" onSubmit={saveMetadata}>
                <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "0 0 8px" }}>
                  MÉTADONNÉES DU COURS
                </h4>
                <div className="form-group">
                  <label className="form-label">Titre</label>
                  <input type="text" className="form-control" value={drawerTitle} onChange={(e) => setDrawerTitle(e.target.value)} required />
                </div>
                <div style={{ display: "flex", gap: "12px" }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Programme</label>
                    <select className="form-control" value={drawerProgram} onChange={(e) => setDrawerProgram(e.target.value)}>
                      <option value="">Aucun</option>
                      <option value="RPM">RPM</option>
                      <option value="Sprint">Sprint</option>
                      <option value="The Trip">The Trip</option>
                      <option value="Autre">Autre</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Release</label>
                    <input type="text" className="form-control" value={drawerRelease} onChange={(e) => setDrawerRelease(e.target.value)} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Fond animé associé (réf. F9.5)</label>
                  <select className="form-control" value={drawerBackgroundId} onChange={(e) => setDrawerBackgroundId(e.target.value)}>
                    <option value="">Aucun (habillage sobre par défaut)</option>
                    {backgrounds.map((bg) => (
                      <option key={bg.id} value={bg.id}>{bg.title}</option>
                    ))}
                  </select>
                </div>

                <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "16px 0 8px" }}>
                  PISTES ({selected.tracks.length}) — glisser-déposer pour réordonner
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
                      <span className="drag-handle">⠿</span>
                      <span style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>
                        {index + 1}. {track.title}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>{formatDuration(track.duration_seconds)}</span>
                    </div>
                  ))}
                </div>

                <div className="drawer-actions">
                  <button type="submit" className="btn btn-primary" style={{ flex: 1, height: "48px" }} disabled={savingDrawer}>
                    {savingDrawer ? "Enregistrement..." : "Enregistrer"}
                  </button>
                  <button type="button" className="btn btn-secondary" style={{ height: "48px" }} onClick={() => launchCoach(selected.id)}>
                    Lancer
                  </button>
                  <button type="button" className="btn btn-danger" style={{ height: "48px" }} onClick={() => setToDelete(selected)}>
                    Supprimer
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
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>Supprimer ce cours audio ?</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              Êtes-vous sûr de vouloir supprimer définitivement{" "}
              <strong style={{ color: "var(--text-main)" }}>{toDelete.title}</strong> et ses {toDelete.track_count} piste(s) ? Cette action est irréversible.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setToDelete(null)}>Annuler</button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmDelete}>
                Confirmer la suppression
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
