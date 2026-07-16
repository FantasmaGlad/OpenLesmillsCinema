"use client";

import React, { useEffect, useState, useRef } from "react";

interface Video {
  id: number;
  file_path: string;
  title: string;
  program: string | null;
  release: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  thumbnail_path: string | null;
  source: string;
}

interface ToastState {
  message: string;
  type: "success" | "error" | "warning";
}

export default function LibraryPage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Filters & Search states
  const [search, setSearch] = useState<string>("");
  const [programFilter, setProgramFilter] = useState<string>("");
  const [releaseFilter, setReleaseFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<string>("imported_at");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Selected video for details drawer
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);

  // Drawer Form fields
  const [drawerTitle, setDrawerTitle] = useState<string>("");
  const [drawerProgramPreset, setDrawerProgramPreset] = useState<string>("");
  const [drawerCustomProgram, setDrawerCustomProgram] = useState<string>("");
  const [drawerRelease, setDrawerRelease] = useState<string>("");
  const [isSavingDrawer, setIsSavingDrawer] = useState<boolean>(false);

  // Upload States
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState<string>("");
  const [uploadProgramPreset, setUploadProgramPreset] = useState<string>("RPM");
  const [uploadCustomProgram, setUploadCustomProgram] = useState<string>("");
  const [uploadRelease, setUploadRelease] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState<number>(-1); // -1 means no active upload
  const [dragActive, setDragActive] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete modal confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [videoToDelete, setVideoToDelete] = useState<Video | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<boolean>(false);

  // Sélection multiple (réf. UX3.9)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [playlists, setPlaylists] = useState<{ id: number; name: string }[]>([]);
  const [showAddToPlaylist, setShowAddToPlaylist] = useState<boolean>(false);
  const [bulkTargetPlaylistId, setBulkTargetPlaylistId] = useState<string>("");

  // Toast state
  const [toast, setToast] = useState<ToastState | null>(null);

  // API URL Helper
  const getApiUrl = (path: string) => {
    if (typeof window !== "undefined") {
      if (window.location.port === "3000") {
        return `http://localhost:8000/api${path}`;
      }
    }
    return `/api${path}`;
  };

  // Show toast helper
  const showToast = (message: string, type: "success" | "error" | "warning" = "success") => {
    setToast({ message, type });
  };

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Load videos
  const fetchVideos = async () => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams();
      if (search) queryParams.append("search", search);
      if (programFilter) queryParams.append("program", programFilter);
      if (releaseFilter) queryParams.append("release", releaseFilter);
      queryParams.append("sort_by", sortBy);
      queryParams.append("order", "desc");

      const res = await fetch(getApiUrl(`/videos?${queryParams.toString()}`), {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        setVideos(data);
      } else {
        showToast("Erreur lors de la récupération des vidéos", "error");
      }
    } catch (err) {
      showToast("Impossible de se connecter au serveur", "error");
    } finally {
      setLoading(false);
    }
  };

  // Fetch videos on filter/search change
  useEffect(() => {
    fetchVideos();
  }, [search, programFilter, releaseFilter, sortBy]);

  useEffect(() => {
    fetch(getApiUrl("/playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, []);

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const confirmBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(ids.map((id) => fetch(getApiUrl(`/videos/${id}`), { method: "DELETE" })));
    const failed = results.filter((r) => r.status === "rejected").length;
    showToast(failed > 0 ? `${ids.length - failed}/${ids.length} vidéos supprimées` : `${ids.length} vidéo(s) supprimée(s)`, failed > 0 ? "warning" : "success");
    setBulkDeleteConfirm(false);
    clearSelection();
    fetchVideos();
  };

  const confirmBulkAddToPlaylist = async () => {
    if (!bulkTargetPlaylistId) return;
    try {
      const res = await fetch(getApiUrl(`/playlists/${bulkTargetPlaylistId}`), { cache: "no-store" });
      if (!res.ok) throw new Error();
      const playlist = await res.json();
      const existingIds: number[] = playlist.items.map((i: { video: { id: number } }) => i.video.id);
      const newItems = [
        ...playlist.items.map((i: { video: { id: number } }, idx: number) => ({ video_id: i.video.id, position: idx })),
        ...Array.from(selectedIds)
          .filter((id) => !existingIds.includes(id))
          .map((id, idx) => ({ video_id: id, position: playlist.items.length + idx })),
      ];
      const putRes = await fetch(getApiUrl(`/playlists/${bulkTargetPlaylistId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: playlist.name, items: newItems }),
      });
      if (putRes.ok) {
        showToast(`${selectedIds.size} vidéo(s) ajoutée(s) à « ${playlist.name} »`);
        setShowAddToPlaylist(false);
        setBulkTargetPlaylistId("");
        clearSelection();
      } else {
        showToast("Erreur lors de l'ajout à la playlist", "error");
      }
    } catch {
      showToast("Erreur lors de l'ajout à la playlist", "error");
    }
  };

  // Handle video card/row click -> Open Drawer
  const handleSelectVideo = (video: Video) => {
    setSelectedVideo(video);
    setDrawerTitle(video.title);
    
    // Set program dropdown state
    const presets = ["RPM", "Sprint", "The Trip"];
    if (video.program && presets.includes(video.program)) {
      setDrawerProgramPreset(video.program);
      setDrawerCustomProgram("");
    } else if (!video.program) {
      setDrawerProgramPreset("");
      setDrawerCustomProgram("");
    } else {
      setDrawerProgramPreset("Autre");
      setDrawerCustomProgram(video.program);
    }
    
    setDrawerRelease(video.release || "");
  };

  // Close details drawer
  const handleCloseDrawer = () => {
    setSelectedVideo(null);
  };

  // Save Video Metadata from Drawer
  const handleSaveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVideo) return;

    setIsSavingDrawer(true);
    const finalProgram = drawerProgramPreset === "Autre" ? drawerCustomProgram : drawerProgramPreset;

    try {
      const res = await fetch(getApiUrl(`/videos/${selectedVideo.id}`), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: drawerTitle,
          program: finalProgram || null,
          release: drawerRelease || null,
        }),
      });

      if (res.ok) {
        const updatedVideo = await res.json();
        showToast("Métadonnées enregistrées avec succès !");
        
        // Update video list in place
        setVideos((prev) =>
          prev.map((v) => (v.id === updatedVideo.id ? updatedVideo : v))
        );
        setSelectedVideo(updatedVideo);
      } else {
        const errData = await res.json();
        showToast(`Erreur : ${errData.detail || "Sauvegarde impossible"}`, "error");
      }
    } catch (err) {
      showToast("Erreur de connexion lors de la sauvegarde", "error");
    } finally {
      setIsSavingDrawer(false);
    }
  };

  // Normalize Video (remux / recode audio if needed)
  const handleNormalize = async () => {
    if (!selectedVideo) return;
    try {
      const res = await fetch(getApiUrl(`/videos/${selectedVideo.id}/normalize`), {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message, "success");
      } else {
        const errData = await res.json();
        showToast(errData.detail || "Erreur de normalisation", "error");
      }
    } catch (err) {
      showToast("Erreur réseau lors de la normalisation", "error");
    }
  };

  // Trigger video deletion confirmation
  const triggerDelete = (video: Video) => {
    setVideoToDelete(video);
    setShowDeleteConfirm(true);
  };

  // Confirm and execute deletion
  const confirmDelete = async () => {
    if (!videoToDelete) return;
    try {
      const res = await fetch(getApiUrl(`/videos/${videoToDelete.id}`), {
        method: "DELETE",
      });
      if (res.ok) {
        showToast("Vidéo supprimée avec succès !");
        setVideos((prev) => prev.filter((v) => v.id !== videoToDelete.id));
        if (selectedVideo?.id === videoToDelete.id) {
          setSelectedVideo(null);
        }
      } else {
        showToast("Impossible de supprimer la vidéo", "error");
      }
    } catch (err) {
      showToast("Erreur lors de la suppression", "error");
    } finally {
      setShowDeleteConfirm(false);
      setVideoToDelete(null);
    }
  };

  // Drag-and-drop & file selection events
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      setupUpload(file);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setupUpload(e.target.files[0]);
    }
  };

  const setupUpload = (file: File) => {
    setUploadFile(file);
    // Strip extension for title
    const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
    setUploadTitle(nameWithoutExt);

    // Try to guess program from file name
    const lowerName = file.name.toLowerCase();
    if (lowerName.includes("rpm")) {
      setUploadProgramPreset("RPM");
    } else if (lowerName.includes("sprint")) {
      setUploadProgramPreset("Sprint");
    } else if (lowerName.includes("trip")) {
      setUploadProgramPreset("The Trip");
    } else {
      setUploadProgramPreset("RPM");
    }

    // Try to guess release number (like RPM 90 or SPRINT 24)
    const match = file.name.match(/(?:rpm|sprint|trip|release|rel|r)\s*(\d+)/i);
    if (match && match[1]) {
      setUploadRelease(match[1]);
    } else {
      setUploadRelease("");
    }
  };

  const executeUpload = () => {
    if (!uploadFile) return;

    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", uploadFile);
    formData.append("title", uploadTitle);
    
    const finalProgram = uploadProgramPreset === "Autre" ? uploadCustomProgram : uploadProgramPreset;
    if (finalProgram) formData.append("program", finalProgram);
    if (uploadRelease) formData.append("release", uploadRelease);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        setUploadProgress(percent);
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        showToast("Vidéo importée avec succès !");
        fetchVideos();
        cancelUpload();
      } else {
        let errMsg = "Erreur lors de l'importation";
        try {
          const resJson = JSON.parse(xhr.responseText);
          errMsg = resJson.detail || errMsg;
        } catch (_) {}
        showToast(errMsg, "error");
        setUploadProgress(-1);
      }
    });

    xhr.addEventListener("error", () => {
      showToast("Erreur réseau pendant l'upload", "error");
      setUploadProgress(-1);
    });

    xhr.open("POST", getApiUrl("/videos/upload"));
    xhr.send(formData);
  };

  const cancelUpload = () => {
    setUploadFile(null);
    setUploadTitle("");
    setUploadRelease("");
    setUploadCustomProgram("");
    setUploadProgress(-1);
  };

  // Helper formats
  const formatDuration = (seconds: number | null) => {
    if (seconds === null || seconds === undefined) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getProgramClass = (program: string | null) => {
    if (!program) return "program-autre";
    const p = program.toLowerCase();
    if (p === "rpm") return "program-rpm";
    if (p === "sprint") return "program-sprint";
    if (p === "the trip" || p === "the-trip" || p === "trip") return "program-the-trip";
    return "program-autre";
  };

  const getProgramBadgeClass = (program: string | null) => {
    if (!program) return "autre";
    const p = program.toLowerCase();
    if (p === "rpm") return "rpm";
    if (p === "sprint") return "sprint";
    if (p === "the trip" || p === "the-trip" || p === "trip") return "the-trip";
    return "autre";
  };

  const getThumbnailSrc = (video: Video) => {
    if (!video.thumbnail_path) return null;
    const filename = video.thumbnail_path.split("/").pop();
    if (!filename) return null;
    return getApiUrl(`/thumbnails/${filename}`);
  };

  return (
    <div className="library-container">
      {/* Dynamic Toast Notifications */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === "success" && (
            <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
          {toast.type === "error" && (
            <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Import / Upload Section */}
      <div 
        className={`upload-zone ${dragActive ? "drag-active" : ""}`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => {
          if (!uploadFile && fileInputRef.current) {
            fileInputRef.current.click();
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        
        {!uploadFile ? (
          <>
            <svg className="w-10 h-10 upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>
              Faites glisser une vidéo ici ou cliquez pour parcourir
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
              Formats recommandés : MP4, MKV. Poids max : 10 Go.
            </p>
          </>
        ) : (
          <div 
            onClick={(e) => e.stopPropagation()} 
            style={{ width: "100%", maxWidth: "500px", textAlign: "left" }}
          >
            <h3 style={{ fontSize: "1.05rem", fontWeight: 800, marginBottom: "16px", color: "var(--accent-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "8px" }}>
              🚀 Préparation de l'importation
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div className="form-group">
                <label className="form-label">Nom du cours (Titre)</label>
                <input
                  type="text"
                  className="form-control"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  disabled={uploadProgress >= 0}
                />
              </div>

              <div style={{ display: "flex", gap: "12px" }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Programme</label>
                  <select
                    className="form-control"
                    value={uploadProgramPreset}
                    onChange={(e) => setUploadProgramPreset(e.target.value)}
                    disabled={uploadProgress >= 0}
                  >
                    <option value="RPM">RPM</option>
                    <option value="Sprint">Sprint</option>
                    <option value="The Trip">The Trip</option>
                    <option value="Autre">Autre (Saisir ci-dessous)</option>
                  </select>
                </div>

                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Release / Édition</label>
                  <input
                    type="text"
                    placeholder="Ex: 92"
                    className="form-control"
                    value={uploadRelease}
                    onChange={(e) => setUploadRelease(e.target.value)}
                    disabled={uploadProgress >= 0}
                  />
                </div>
              </div>

              {uploadProgramPreset === "Autre" && (
                <div className="form-group">
                  <label className="form-label">Nom du programme personnalisé</label>
                  <input
                    type="text"
                    placeholder="Ex: Bodypump"
                    className="form-control"
                    value={uploadCustomProgram}
                    onChange={(e) => setUploadCustomProgram(e.target.value)}
                    disabled={uploadProgress >= 0}
                  />
                </div>
              )}

              <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "4px" }}>
                Fichier : <span style={{ color: "var(--text-main)", fontWeight: 600 }}>{uploadFile.name}</span> ({(uploadFile.size / (1024 * 1024)).toFixed(1)} Mo)
              </div>

              {uploadProgress >= 0 ? (
                <div className="upload-progress-container">
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 700 }}>
                    <span>Téléversement...</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="progress-bar-bg">
                    <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: "12px", marginTop: "12px" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={executeUpload}
                    style={{ flex: 1, height: "48px" }}
                  >
                    Lancer l'importation
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={cancelUpload}
                    style={{ height: "48px" }}
                  >
                    Annuler
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Barre d'actions groupées (réf. UX3.9) */}
      {selectedIds.size > 0 && (
        <div className="interrupted-block">
          <div className="interrupted-text">
            <span className="interrupted-label">Sélection</span>
            <span className="interrupted-title">{selectedIds.size} vidéo(s) sélectionnée(s)</span>
          </div>
          <div className="interrupted-actions">
            <button className="btn btn-secondary" onClick={() => setShowAddToPlaylist(true)}>
              Ajouter à une playlist
            </button>
            <button className="btn btn-danger" onClick={() => setBulkDeleteConfirm(true)}>
              Supprimer
            </button>
            <button className="btn btn-secondary" onClick={clearSelection}>
              Annuler la sélection
            </button>
          </div>
        </div>
      )}

      {/* Toolbar / Search / Filters */}
      <div className="library-toolbar">
        <div className="toolbar-filters">
          <input
            type="text"
            className="search-input"
            placeholder="Rechercher une vidéo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <select
            className="filter-select"
            value={programFilter}
            onChange={(e) => setProgramFilter(e.target.value)}
          >
            <option value="">Tous les programmes</option>
            <option value="RPM">RPM</option>
            <option value="Sprint">Sprint</option>
            <option value="The Trip">The Trip</option>
            <option value="Autre">Autre</option>
          </select>

          <input
            type="text"
            className="search-input"
            style={{ width: "120px" }}
            placeholder="Release..."
            value={releaseFilter}
            onChange={(e) => setReleaseFilter(e.target.value)}
          />

          <select
            className="filter-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="imported_at">Trier par date d'import</option>
            <option value="title">Trier par titre</option>
            <option value="duration">Trier par durée</option>
          </select>
        </div>

        {/* Grid / List view toggle */}
        <div className="view-toggle">
          <button
            className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
            onClick={() => setViewMode("grid")}
            title="Vue Grille"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" />
            </svg>
          </button>
          <button
            className={`view-btn ${viewMode === "list" ? "active" : ""}`}
            onClick={() => setViewMode("list")}
            title="Vue Liste"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main library listing */}
      {loading ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          Chargement de la bibliothèque...
        </div>
      ) : videos.length === 0 ? (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          <svg className="w-12 h-12" style={{ marginBottom: "12px", color: "rgba(255,255,255,0.1)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
          </svg>
          <p style={{ margin: 0, fontWeight: 600 }}>Aucune vidéo trouvée</p>
          <p style={{ fontSize: "0.85rem", margin: "4px 0 0" }}>Essayez d'importer une nouvelle vidéo ou d'ajuster les filtres</p>
        </div>
      ) : viewMode === "grid" ? (
        /* GRID VIEW — groupée par programme (réf. UX3.6) */
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          {["RPM", "Sprint", "The Trip", "Autre"]
            .map((program) => ({
              program,
              items: videos.filter((v) =>
                program === "Autre" ? !v.program || !["RPM", "Sprint", "The Trip"].includes(v.program) : v.program === program
              ),
            }))
            .filter((g) => g.items.length > 0)
            .map((group) => (
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
                  {group.program} <span style={{ color: "var(--text-dim)" }}>({group.items.length})</span>
                </h3>
                <div className="videos-grid">
                  {group.items.map((video) => {
                    const thumbSrc = getThumbnailSrc(video);
                    const isSelected = selectedIds.has(video.id);
                    return (
                      <div
                        key={video.id}
                        className={`video-card ${getProgramClass(video.program)}`}
                        onClick={() => handleSelectVideo(video)}
                      >
                        <div className="thumbnail-wrapper">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelected(video.id)}
                            style={{ position: "absolute", top: "8px", left: "8px", zIndex: 2, width: "20px", height: "20px", cursor: "pointer" }}
                          />
                          {thumbSrc ? (
                            <img src={thumbSrc} alt={video.title} className="card-thumbnail" />
                          ) : (
                            <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", background: "#0c0c0e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg className="w-8 h-8 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.2 }}>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            </div>
                          )}
                          <span className="card-duration">{formatDuration(video.duration_seconds)}</span>
                        </div>
                        <div className="card-content">
                          <h4 className="card-title" title={video.title}>
                            {video.title}
                          </h4>
                          <div className="card-meta-row">
                            <span className={`program-badge ${getProgramBadgeClass(video.program)}`}>
                              {video.program || "Autre"}
                            </span>
                            {video.release && (
                              <span className="release-badge">Rel. {video.release}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      ) : (
        /* LIST VIEW */
        <div className="table-wrapper">
          <table className="videos-table">
            <thead>
              <tr>
                <th style={{ width: "36px" }}></th>
                <th style={{ width: "80px" }}>Miniature</th>
                <th>Titre</th>
                <th>Programme</th>
                <th>Release</th>
                <th>Durée</th>
                <th>Format</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video) => {
                const thumbSrc = getThumbnailSrc(video);
                return (
                  <tr key={video.id} onClick={() => handleSelectVideo(video)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(video.id)}
                        onChange={() => toggleSelected(video.id)}
                        style={{ width: "18px", height: "18px", cursor: "pointer" }}
                      />
                    </td>
                    <td>
                      {thumbSrc ? (
                        <img src={thumbSrc} alt="" className="table-thumb" />
                      ) : (
                        <div className="table-thumb" style={{ background: "#0c0c0e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.2 }}>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                    </td>
                    <td style={{ fontWeight: 700, color: "var(--text-main)" }}>
                      {video.title}
                    </td>
                    <td>
                      <span className={`program-badge ${getProgramBadgeClass(video.program)}`}>
                        {video.program || "Autre"}
                      </span>
                    </td>
                    <td>{video.release ? `Release ${video.release}` : "-"}</td>
                    <td>{formatDuration(video.duration_seconds)}</td>
                    <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      {video.width && video.height ? `${video.width}x${video.height}` : ""} {video.codec ? `(${video.codec})` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sliding Details Drawer */}
      {selectedVideo && (
        <>
          <div className="detail-drawer-overlay" onClick={handleCloseDrawer} />
          <div className="detail-drawer">
            <div className="drawer-header">
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "80%" }}>
                {selectedVideo.title}
              </h3>
              <button className="close-btn" onClick={handleCloseDrawer}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="drawer-body">
              {/* HTML5 video player streaming with range support */}
              <div className="drawer-video-container">
                <video
                  className="drawer-video"
                  controls
                  playsInline
                  src={getApiUrl(`/videos/${selectedVideo.id}/stream`)}
                  poster={getThumbnailSrc(selectedVideo) || undefined}
                />
              </div>

              {/* Form edit metadata */}
              <form className="drawer-form" onSubmit={handleSaveMetadata}>
                <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "0 0 8px" }}>
                  MÉTADONNÉES DU COURS
                </h4>

                <div className="form-group">
                  <label className="form-label">Titre du cours</label>
                  <input
                    type="text"
                    className="form-control"
                    value={drawerTitle}
                    onChange={(e) => setDrawerTitle(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: "flex", gap: "12px" }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Programme</label>
                    <select
                      className="form-control"
                      value={drawerProgramPreset}
                      onChange={(e) => setDrawerProgramPreset(e.target.value)}
                    >
                      <option value="">Aucun</option>
                      <option value="RPM">RPM</option>
                      <option value="Sprint">Sprint</option>
                      <option value="The Trip">The Trip</option>
                      <option value="Autre">Autre (Saisir ci-dessous)</option>
                    </select>
                  </div>

                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Release / Édition</label>
                    <input
                      type="text"
                      className="form-control"
                      value={drawerRelease}
                      onChange={(e) => setDrawerRelease(e.target.value)}
                      placeholder="Ex: 92"
                    />
                  </div>
                </div>

                {drawerProgramPreset === "Autre" && (
                  <div className="form-group">
                    <label className="form-label">Nom du programme personnalisé</label>
                    <input
                      type="text"
                      placeholder="Ex: Bodypump"
                      className="form-control"
                      value={drawerCustomProgram}
                      onChange={(e) => setDrawerCustomProgram(e.target.value)}
                      required
                    />
                  </div>
                )}

                {/* Readonly info */}
                <div style={{ background: "rgba(255,255,255,0.02)", padding: "12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)", display: "flex", flexDirection: "column", gap: "8px", fontSize: "0.85rem", marginTop: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>Résolution :</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 600 }}>
                      {selectedVideo.width && selectedVideo.height ? `${selectedVideo.width}x${selectedVideo.height}` : "Inconnue"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>Codec Vidéo :</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 600 }}>{selectedVideo.codec || "Inconnu"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>Source d'import :</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 600, textTransform: "capitalize" }}>
                      {selectedVideo.source === "upload" ? "Téléchargement" : "Dossier surveillé"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>Chemin disque :</span>
                    <span 
                      style={{ color: "var(--text-muted)", fontSize: "0.75rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "240px" }}
                      title={selectedVideo.file_path}
                    >
                      {selectedVideo.file_path}
                    </span>
                  </div>
                </div>

                <div className="drawer-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ flex: 1, height: "48px" }}
                    disabled={isSavingDrawer}
                  >
                    {isSavingDrawer ? "Enregistrement..." : "Enregistrer"}
                  </button>
                  
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleNormalize}
                    style={{ height: "48px" }}
                    title="Optimise la vidéo (AAC/MP4) pour la lecture fluide dans le navigateur si nécessaire"
                  >
                    Normaliser
                  </button>

                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => triggerDelete(selectedVideo)}
                    style={{ height: "48px" }}
                  >
                    Supprimer
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}

      {/* Confirmation Delete Modal */}
      {showDeleteConfirm && videoToDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--text-main)" }}>
              Supprimer la vidéo ?
            </h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              Êtes-vous sûr de vouloir supprimer définitivement la vidéo{" "}
              <strong style={{ color: "var(--text-main)" }}>{videoToDelete.title}</strong> ?
              Cette action est irréversible et supprimera le fichier du disque.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setVideoToDelete(null);
                }}
              >
                Annuler
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ backgroundColor: "var(--accent-error)" }}
                onClick={confirmDelete}
              >
                Confirmer la suppression
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Bulk Delete Modal (réf. UX3.9/UX5.2) */}
      {bulkDeleteConfirm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--text-main)" }}>
              Supprimer {selectedIds.size} vidéo(s) ?
            </h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              Cette action est irréversible et supprimera les fichiers du disque.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setBulkDeleteConfirm(false)}>
                Annuler
              </button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmBulkDelete}>
                Confirmer la suppression
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ajout groupé à une playlist (réf. UX3.9) */}
      {showAddToPlaylist && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--text-main)" }}>
              Ajouter {selectedIds.size} vidéo(s) à une playlist
            </h3>
            <select className="form-control" value={bulkTargetPlaylistId} onChange={(e) => setBulkTargetPlaylistId(e.target.value)}>
              <option value="">Choisir une playlist...</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {playlists.length === 0 && (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
                Aucune playlist existante. Créez-en une depuis la page Playlists.
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowAddToPlaylist(false);
                  setBulkTargetPlaylistId("");
                }}
              >
                Annuler
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmBulkAddToPlaylist} disabled={!bulkTargetPlaylistId}>
                Ajouter
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
