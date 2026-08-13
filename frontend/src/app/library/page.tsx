"use client";

import React, { useEffect, useState, useRef } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useUploadManager, PendingUploadSpec } from "@/lib/UploadManager";
import Icon from "@/components/Icon";

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
  const { t } = useAppSettings();
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

  // Drawer Form fields. `drawerProgram` est un libellé LIBRE (plus de presets
  // RPM/Sprint/The Trip codés en dur) : saisie texte + suggestions (datalist)
  // des catégories déjà utilisées.
  const [drawerTitle, setDrawerTitle] = useState<string>("");
  const [drawerProgram, setDrawerProgram] = useState<string>("");
  const [drawerRelease, setDrawerRelease] = useState<string>("");
  const [isSavingDrawer, setIsSavingDrawer] = useState<boolean>(false);

  // Catégories (programmes) réellement présentes dans la bibliothèque, pour
  // alimenter les suggestions de saisie, le filtre et le regroupement — plus
  // aucune liste figée (réf. « retire les catégories hardcodées, laisse créer
  // sa propre catégorie »).
  const [programs, setPrograms] = useState<string[]>([]);

  // Drag-and-drop zone
  const [dragActive, setDragActive] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mini-formulaires pour préparer les métadonnées avant l'upload (P3).
  // Chaque entrée correspond à un fichier sélectionné mais pas encore envoyé.
  const [pendingSpecs, setPendingSpecs] = useState<Array<PendingUploadSpec & { key: string }>>([]);

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
        return `http://localhost:8001/api${path}`;
      }
    }
    return `/api${path}`;
  };

  // Upload Manager global (P3)
  const { addUploads, uploads } = useUploadManager();
  // Réf. mission "voir en direct les importations" : `seenDoneIds` évite de
  // redéclencher un fetch à chaque tick de polling tant qu'aucune tâche
  // vidéo n'a nouvellement terminé (effet déclaré plus bas, après
  // `fetchVideos`).
  const seenDoneIds = useRef<Set<string>>(new Set());

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
    await Promise.resolve();
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
        showToast(t("library.fetchError"), "error");
      }
    } catch {
      showToast(t("library.connectionError"), "error");
    } finally {
      setLoading(false);
    }
  };

  // Rafraîchit la bibliothèque dès qu'un import vidéo se termine (réf.
  // mission "voir en direct les importations") : les imports sont désormais
  // traités en arrière-plan (réponse HTTP 202 immédiate), sans ce suivi la
  // nouvelle vidéo n'apparaissait qu'après une action manuelle (changement
  // de filtre/tri).
  useEffect(() => {
    const newlyDone = uploads.filter(
      (u) => u.kind === "video" && u.status === "done" && !seenDoneIds.current.has(u.id)
    );
    if (newlyDone.length === 0) return;
    newlyDone.forEach((u) => seenDoneIds.current.add(u.id));
    fetchVideos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads]);

  // Fetch videos on filter/search change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchVideos();
  }, [search, programFilter, releaseFilter, sortBy]);

  useEffect(() => {
    fetch(getApiUrl("/playlists"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, []);

  const fetchPrograms = () => {
    fetch(getApiUrl("/videos/programs"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: string[]) => setPrograms(Array.isArray(data) ? data : []))
      .catch(() => {});
  };
  useEffect(fetchPrograms, []);

  // Liste de suggestions = catégories du serveur ∪ celles des vidéos déjà
  // chargées (pour qu'une catégorie tout juste créée apparaisse sans attendre
  // un rechargement), triée sans casse.
  const availablePrograms = React.useMemo(() => {
    const set = new Set<string>(programs);
    for (const v of videos) if (v.program) set.add(v.program);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
  }, [programs, videos]);

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Sélection groupée (réf. demande « impossible de faire une sélection
  // groupée ») : cases « tout sélectionner » (par groupe de programme en vue
  // grille, globale en vue liste) + sélection par plage au Maj-clic en liste.
  const setManySelected = (ids: number[], select: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  const allSelected = (ids: number[]) => ids.length > 0 && ids.every((id) => selectedIds.has(id));

  // Dernière ligne cochée en vue liste, pour la sélection par plage (Maj-clic).
  const lastListIndexRef = useRef<number | null>(null);
  const handleRowCheckboxClick = (e: React.MouseEvent, index: number, id: number) => {
    if (e.shiftKey && lastListIndexRef.current !== null && lastListIndexRef.current !== index) {
      const [a, b] = [lastListIndexRef.current, index].sort((x, y) => x - y);
      const select = !selectedIds.has(id);
      setManySelected(videos.slice(a, b + 1).map((v) => v.id), select);
    } else {
      toggleSelected(id);
    }
    lastListIndexRef.current = index;
  };

  const clearSelection = () => setSelectedIds(new Set());

  const confirmBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(ids.map((id) => fetch(getApiUrl(`/videos/${id}`), { method: "DELETE" })));
    const failed = results.filter((r) => r.status === "rejected").length;
    showToast(
      failed > 0
        ? t("library.bulkDeletedPartial", { ok: ids.length - failed, total: ids.length })
        : t("library.bulkDeletedAll", { count: ids.length }),
      failed > 0 ? "warning" : "success"
    );
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
        showToast(t("library.addedToPlaylist", { count: selectedIds.size, name: playlist.name }));
        setShowAddToPlaylist(false);
        setBulkTargetPlaylistId("");
        clearSelection();
      } else {
        showToast(t("library.addToPlaylistError"), "error");
      }
    } catch {
      showToast(t("library.addToPlaylistError"), "error");
    }
  };

  // Handle video card/row click -> Open Drawer
  const handleSelectVideo = (video: Video) => {
    setSelectedVideo(video);
    setDrawerTitle(video.title);
    // Catégorie = libellé libre (plus de presets figés).
    setDrawerProgram(video.program || "");
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
    const finalProgram = drawerProgram.trim();

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
        showToast(t("library.metadataSaved"));

        // Update video list in place
        setVideos((prev) =>
          prev.map((v) => (v.id === updatedVideo.id ? updatedVideo : v))
        );
        setSelectedVideo(updatedVideo);
        fetchPrograms(); // une nouvelle catégorie saisie doit alimenter les suggestions
      } else {
        const errData = await res.json();
        showToast(t("library.saveErrorDetail", { detail: errData.detail || t("library.saveErrorFallback") }), "error");
      }
    } catch {
      showToast(t("library.saveConnectionError"), "error");
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
        showToast(errData.detail || t("library.normalizeError"), "error");
      }
    } catch {
      showToast(t("library.normalizeNetworkError"), "error");
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
        showToast(t("library.deletedSuccess"));
        setVideos((prev) => prev.filter((v) => v.id !== videoToDelete.id));
        if (selectedVideo?.id === videoToDelete.id) {
          setSelectedVideo(null);
        }
      } else {
        showToast(t("library.deleteError"), "error");
      }
    } catch {
      showToast(t("library.deleteGenericError"), "error");
    } finally {
      setShowDeleteConfirm(false);
      setVideoToDelete(null);
    }
  };

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
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("video/"));
    if (files.length > 0) addPendingSpecs(files);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) addPendingSpecs(files);
    // Réinitialiser l'input pour permettre de re-sélectionner les mêmes fichiers.
    e.target.value = "";
  };

  /** Crée les PendingSpec avec métadonnées pré-remplies par heuristique.
   *  Plus aucune catégorie codée en dur : si le nom de fichier contient une
   *  catégorie DÉJÀ utilisée (mot-clé), on la propose ; sinon le champ reste
   *  vide et l'utilisateur saisit/crée librement sa catégorie. */
  const addPendingSpecs = (files: File[]) => {
    const known = availablePrograms;
    const specs = files.map((file) => {
      const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
      const lowerName = file.name.toLowerCase();
      const program = known.find((p) => p && lowerName.includes(p.toLowerCase())) ?? "";
      const match = file.name.match(/(?:release|rel|r|#|\bv)\s*(\d+)/i);
      const release = match?.[1] ?? "";
      return { key: Math.random().toString(36).slice(2), kind: "video" as const, file, title: nameWithoutExt, program, release };
    });
    setPendingSpecs((prev) => [...prev, ...specs]);
  };

  const updatePendingSpec = (key: string, patch: Partial<PendingUploadSpec>) => {
    setPendingSpecs((prev) => prev.map((s) => s.key === key ? { ...s, ...patch } : s));
  };

  const removePendingSpec = (key: string) => {
    setPendingSpecs((prev) => prev.filter((s) => s.key !== key));
  };

  const submitPendingUploads = () => {
    if (pendingSpecs.length === 0) return;
    addUploads(pendingSpecs.map(({ file, title, program, release }) => ({ kind: "video" as const, file, title, program, release })));
    setPendingSpecs([]);
  };

  // Helper formats
  const formatDuration = (seconds: number | null) => {
    if (seconds === null || seconds === undefined) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Catégories libres : plus de couleur par programme (RPM/Sprint/… mappaient
  // déjà tous vers l'accent du thème en CSS). Une seule classe générique suffit.
  const getProgramClass = (_program: string | null) => "program-autre";
  const getProgramBadgeClass = (_program: string | null) => "autre";

  const getThumbnailSrc = (video: Video) => {
    if (!video.thumbnail_path) return null;
    const filename = video.thumbnail_path.split("/").pop();
    if (!filename) return null;
    return getApiUrl(`/thumbnails/${filename}`);
  };

  return (
    <div className="library-container">
      {/* Suggestions de catégories partagées (import + drawer) : les catégories
          déjà utilisées dans la bibliothèque, sans rien imposer — l'utilisateur
          peut toujours en saisir une nouvelle. */}
      <datalist id="library-programs">
        {availablePrograms.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      {/* Dynamic Toast Notifications */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === "success" && <Icon name="check_circle" size={20} color="var(--accent-success)" filled />}
          {toast.type === "error" && <Icon name="error" size={20} color="var(--accent-error)" filled />}
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
          if (pendingSpecs.length === 0 && fileInputRef.current) {
            fileInputRef.current.click();
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />

        {pendingSpecs.length === 0 ? (
          <>
            <Icon name="cloud_upload" size={48} className="upload-icon" />
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>
              {t("library.uploadDropHint")}
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
              {t("library.uploadFormatsHint")}
            </p>
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Plusieurs fichiers acceptés simultanément
            </p>
          </>
        ) : (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: "560px", textAlign: "left" }}
          >
            <h3 style={{ fontSize: "1.05rem", fontWeight: 800, marginBottom: "12px", color: "var(--accent-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "8px" }}>
              {pendingSpecs.length} fichier{pendingSpecs.length > 1 ? "s" : ""} sélectionné{pendingSpecs.length > 1 ? "s" : ""} — vérifiez les métadonnées
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "320px", overflowY: "auto", paddingRight: "4px" }}>
              {pendingSpecs.map((spec) => (
                <div key={spec.key} style={{ background: "var(--bg-surface-hover)", borderRadius: "8px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={spec.file!.name}>
                      {spec.file!.name} ({(spec.file!.size / (1024 * 1024)).toFixed(1)} Mo)
                    </span>
                    <button onClick={() => removePendingSpec(spec.key)} className="olc-press" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, display: "flex" }}>
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Titre"
                    value={spec.title}
                    onChange={(e) => updatePendingSpec(spec.key, { title: e.target.value })}
                    style={{ padding: "6px 10px", fontSize: "0.85rem" }}
                  />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="text"
                      list="library-programs"
                      className="form-control"
                      placeholder={t("library.programPlaceholder")}
                      value={spec.program ?? ""}
                      onChange={(e) => updatePendingSpec(spec.key, { program: e.target.value })}
                      style={{ flex: 1, padding: "6px 8px", fontSize: "0.85rem" }}
                    />
                    <input
                      type="text"
                      className="form-control"
                      placeholder={t("library.releasePlaceholderExample")}
                      value={spec.release ?? ""}
                      onChange={(e) => updatePendingSpec(spec.key, { release: e.target.value })}
                      style={{ width: "80px", padding: "6px 8px", fontSize: "0.85rem" }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "12px", marginTop: "14px" }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={submitPendingUploads}
                style={{ flex: 1, height: "44px" }}
              >
                Lancer {pendingSpecs.length} upload{pendingSpecs.length > 1 ? "s" : ""}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingSpecs([])}
                style={{ height: "44px" }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => fileInputRef.current?.click()}
                style={{ height: "44px", whiteSpace: "nowrap" }}
              >
                + Ajouter
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Barre d'actions groupées (réf. UX3.9) */}
      {selectedIds.size > 0 && (
        <div className="interrupted-block">
          <div className="interrupted-text">
            <span className="interrupted-label">{t("library.selectionLabel")}</span>
            <span className="interrupted-title">{t("library.selectedCount", { count: selectedIds.size })}</span>
          </div>
          <div className="interrupted-actions">
            <button className="btn btn-secondary" onClick={() => setShowAddToPlaylist(true)}>
              {t("library.addToPlaylist")}
            </button>
            <button className="btn btn-danger" onClick={() => setBulkDeleteConfirm(true)}>
              {t("common.delete")}
            </button>
            <button className="btn btn-secondary" onClick={clearSelection}>
              {t("library.clearSelection")}
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
            placeholder={t("library.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <select
            className="filter-select"
            value={programFilter}
            onChange={(e) => setProgramFilter(e.target.value)}
          >
            <option value="">{t("library.allPrograms")}</option>
            {availablePrograms.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>

          <input
            type="text"
            className="search-input"
            style={{ width: "120px" }}
            placeholder={t("library.releasePlaceholder")}
            value={releaseFilter}
            onChange={(e) => setReleaseFilter(e.target.value)}
          />

          <select
            className="filter-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="imported_at">{t("library.sortImportDate")}</option>
            <option value="title">{t("library.sortTitle")}</option>
            <option value="duration">{t("library.sortDuration")}</option>
          </select>
        </div>

        {/* Grid / List view toggle */}
        <div className="view-toggle">
          <button
            className={`view-btn olc-press ${viewMode === "grid" ? "active" : ""}`}
            onClick={() => setViewMode("grid")}
            title={t("library.gridView")}
          >
            <Icon name="grid_view" size={18} />
          </button>
          <button
            className={`view-btn olc-press ${viewMode === "list" ? "active" : ""}`}
            onClick={() => setViewMode("list")}
            title={t("library.listView")}
          >
            <Icon name="view_list" size={18} />
          </button>
        </div>
      </div>

      {/* Main library listing */}
      {loading ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          {t("library.loadingLibrary")}
        </div>
      ) : videos.length === 0 ? (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          <Icon name="video_library" size={48} color="var(--border-focus)" style={{ marginBottom: "12px" }} />
          <p style={{ margin: 0, fontWeight: 600 }}>{t("library.noVideosFound")}</p>
          <p style={{ fontSize: "0.85rem", margin: "4px 0 0" }}>{t("library.noVideosHint")}</p>
        </div>
      ) : viewMode === "grid" ? (
        /* GRID VIEW — regroupée dynamiquement par catégorie présente (réf.
           UX3.6 + « catégories libres ») : "" = bucket « sans catégorie », placé
           en dernier ; les autres triées sans casse. */
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          {Array.from(new Set(videos.map((v) => (v.program && v.program.trim() ? v.program : ""))))
            .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "fr", { sensitivity: "base" })))
            .map((program) => ({
              program,
              items: videos.filter((v) => (v.program && v.program.trim() ? v.program : "") === program),
            }))
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <div key={group.program}>
                {/* Couleur du thème plutôt que du programme (réf. correctif
                    "couleurs hardcodées associées à un cours"). La case coche
                    tout le groupe d'un coup (réf. « sélection groupée »). */}
                <h3
                  style={{
                    fontSize: "0.85rem",
                    marginBottom: "16px",
                    color: "var(--accent-primary)",
                  }}
                >
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }} title={t("library.selectGroupTitle")}>
                    <input
                      type="checkbox"
                      checked={allSelected(group.items.map((v) => v.id))}
                      onChange={(e) => setManySelected(group.items.map((v) => v.id), e.target.checked)}
                      style={{ width: "16px", height: "16px", cursor: "pointer" }}
                    />
                    <span>
                      {group.program === "" ? t("library.noProgram") : group.program}{" "}
                      <span style={{ color: "var(--text-dim)" }}>({group.items.length})</span>
                    </span>
                  </label>
                </h3>
                <div className="videos-grid">
                  {group.items.map((video) => {
                    const thumbSrc = getThumbnailSrc(video);
                    const isSelected = selectedIds.has(video.id);
                    return (
                      <div
                        key={video.id}
                        className={`video-card ${getProgramClass(video.program)}${isSelected ? " selected" : ""}`}
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
                            <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", background: "var(--bg-surface-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <Icon name="movie" size={32} style={{ opacity: 0.2 }} />
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
                              {video.program || t("library.noProgram")}
                            </span>
                            {video.release && (
                              <span className="release-badge">{t("library.releaseBadge", { release: video.release })}</span>
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
                <th style={{ width: "36px" }}>
                  <input
                    type="checkbox"
                    checked={allSelected(videos.map((v) => v.id))}
                    onChange={(e) => setManySelected(videos.map((v) => v.id), e.target.checked)}
                    title={t("library.selectAllTitle")}
                    style={{ width: "18px", height: "18px", cursor: "pointer" }}
                  />
                </th>
                <th style={{ width: "80px" }}>{t("library.thumbnailHeader")}</th>
                <th>{t("library.titleHeader")}</th>
                <th>{t("library.programHeader")}</th>
                <th>{t("library.releaseHeader")}</th>
                <th>{t("library.durationHeader")}</th>
                <th>{t("library.formatHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video, index) => {
                const thumbSrc = getThumbnailSrc(video);
                return (
                  <tr key={video.id} className={selectedIds.has(video.id) ? "row-selected" : ""} onClick={() => handleSelectVideo(video)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(video.id)}
                        onChange={() => {}}
                        onClick={(e) => handleRowCheckboxClick(e, index, video.id)}
                        title={t("library.selectAllTitle")}
                        style={{ width: "18px", height: "18px", cursor: "pointer" }}
                      />
                    </td>
                    <td>
                      {thumbSrc ? (
                        <img src={thumbSrc} alt="" className="table-thumb" />
                      ) : (
                        <div className="table-thumb" style={{ background: "var(--bg-surface-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Icon name="movie" size={16} style={{ opacity: 0.2 }} />
                        </div>
                      )}
                    </td>
                    <td style={{ fontWeight: 700, color: "var(--text-main)" }}>
                      {video.title}
                    </td>
                    <td>
                      <span className={`program-badge ${getProgramBadgeClass(video.program)}`}>
                        {video.program || t("library.noProgram")}
                      </span>
                    </td>
                    <td>{video.release ? t("library.releaseFull", { release: video.release }) : "-"}</td>
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
                <Icon name="close" size={20} />
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
                  {t("library.metadataSectionTitle")}
                </h4>

                <div className="form-group">
                  <label className="form-label">{t("library.courseTitleFieldLabel")}</label>
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
                    <label className="form-label">{t("library.programLabel")}</label>
                    <input
                      type="text"
                      list="library-programs"
                      className="form-control"
                      value={drawerProgram}
                      onChange={(e) => setDrawerProgram(e.target.value)}
                      placeholder={t("library.programPlaceholder")}
                    />
                  </div>

                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t("library.releaseLabel")}</label>
                    <input
                      type="text"
                      className="form-control"
                      value={drawerRelease}
                      onChange={(e) => setDrawerRelease(e.target.value)}
                      placeholder={t("library.releasePlaceholderExample")}
                    />
                  </div>
                </div>

                {/* Readonly info */}
                <div style={{ background: "var(--bg-surface-hover)", padding: "12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)", display: "flex", flexDirection: "column", gap: "8px", fontSize: "0.85rem", marginTop: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>{t("library.resolutionLabel")}</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 600 }}>
                      {selectedVideo.width && selectedVideo.height ? `${selectedVideo.width}x${selectedVideo.height}` : t("library.unknownValue")}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>{t("library.videoCodecLabel")}</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 600 }}>{selectedVideo.codec || t("library.unknownCodec")}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>{t("library.importSourceLabel")}</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 600, textTransform: "capitalize" }}>
                      {selectedVideo.source === "upload" ? t("library.uploadSource") : t("library.watchedFolderSource")}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-muted)" }}>{t("library.diskPathLabel")}</span>
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
                    {isSavingDrawer ? t("common.saving") : t("common.save")}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleNormalize}
                    style={{ height: "48px" }}
                    title={t("library.normalizeTitle")}
                  >
                    {t("library.normalize")}
                  </button>

                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => triggerDelete(selectedVideo)}
                    style={{ height: "48px" }}
                  >
                    {t("common.delete")}
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
              {t("library.deleteVideoTitle")}
            </h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              {t("library.deleteVideoConfirmBefore")}{" "}
              <strong style={{ color: "var(--text-main)" }}>{videoToDelete.title}</strong>
              {t("library.deleteVideoConfirmAfter")}
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
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ backgroundColor: "var(--accent-error)" }}
                onClick={confirmDelete}
              >
                {t("library.confirmDelete")}
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
              {t("library.deleteBulkTitle", { count: selectedIds.size })}
            </h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              {t("library.deleteBulkConfirm")}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setBulkDeleteConfirm(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmBulkDelete}>
                {t("library.confirmDelete")}
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
              {t("library.addToPlaylistTitle", { count: selectedIds.size })}
            </h3>
            <select className="form-control" value={bulkTargetPlaylistId} onChange={(e) => setBulkTargetPlaylistId(e.target.value)}>
              <option value="">{t("library.choosePlaylist")}</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {playlists.length === 0 && (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
                {t("library.noPlaylistsHint")}
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
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmBulkAddToPlaylist} disabled={!bulkTargetPlaylistId}>
                {t("library.add")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
