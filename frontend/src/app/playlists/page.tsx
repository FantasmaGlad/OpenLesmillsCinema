"use client";

import React, { useEffect, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";

interface Video {
  id: number;
  title: string;
  program: string | null;
  release: string | null;
  duration_seconds: number | null;
  thumbnail_path: string | null;
}

interface PlaylistItemInput {
  video_id: number;
  position: number;
}

interface PlaylistItemResponse {
  id: number;
  position: number;
  video: Video;
}

interface PlaylistDetail {
  id: number;
  name: string;
  created_at: string;
  items: PlaylistItemResponse[];
  total_duration_seconds: number;
}

interface PlaylistSummary {
  id: number;
  name: string;
  created_at: string;
  item_count: number;
  total_duration_seconds: number;
}

interface ToastState {
  message: string;
  type: "success" | "error" | "warning";
}

export default function PlaylistsPage() {
  const { connected, sendCommand } = usePlaybackSocket();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Search playlists on the left
  const [playlistSearch, setPlaylistSearch] = useState<string>("");

  // Search/Filters in library picker
  const [videoSearch, setVideoSearch] = useState<string>("");
  const [videoProgramFilter, setVideoProgramFilter] = useState<string>("");

  // Editor State
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null); // null means none selected, unless isCreating is true
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [playlistName, setPlaylistName] = useState<string>("");
  const [playlistItems, setPlaylistItems] = useState<Video[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Drag and Drop State
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [draggedVideoId, setDraggedVideoId] = useState<number | null>(null);
  const [dragSource, setDragSource] = useState<"sequencer" | "library" | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Delete modal confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [playlistToDelete, setPlaylistToDelete] = useState<PlaylistSummary | null>(null);

  const getApiUrl = (path: string) => {
    if (typeof window !== "undefined") {
      if (window.location.port === "3000") {
        return `http://localhost:8000/api${path}`;
      }
    }
    return `/api${path}`;
  };

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

  // Fetch Playlists
  const fetchPlaylists = async () => {
    try {
      const res = await fetch(getApiUrl("/playlists"), { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setPlaylists(data);
      } else {
        showToast("Erreur de chargement des playlists", "error");
      }
    } catch {
      showToast("Erreur réseau (playlists)", "error");
    }
  };

  // Fetch Videos (for addition list)
  const fetchVideos = async () => {
    try {
      const res = await fetch(getApiUrl("/videos?sort_by=imported_at&order=desc"), { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setVideos(data);
      }
    } catch {
      showToast("Erreur réseau (vidéos)", "error");
    }
  };

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([fetchPlaylists(), fetchVideos()]).finally(() => setLoading(false));
  }, []);

  // Format Helper
  const formatDuration = (seconds: number) => {
    if (!seconds) return "0 min";
    const mins = Math.round(seconds / 60);
    return `${mins} min`;
  };

  const formatItemDuration = (seconds: number | null) => {
    if (seconds === null || seconds === undefined) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getProgramBadgeClass = (program: string | null) => {
    if (!program) return "autre";
    const p = program.toLowerCase();
    if (p === "rpm") return "rpm";
    if (p === "sprint") return "sprint";
    if (p === "the trip" || p === "the-trip" || p === "trip") return "the-trip";
    return "autre";
  };

  // Launch Playlist on Kiosk via WebSocket
  const handleLaunch = (e: React.MouseEvent, id: number) => {
    e.stopPropagation(); // Avoid triggering edit selection
    if (!connected) {
      showToast("L'écran cinéma est déconnecté", "error");
      return;
    }
    sendCommand("load_playlist", { playlist_id: id });
    showToast("Playlist envoyée sur l'écran cinéma !");
  };

  // Delete Playlist
  const triggerDelete = (e: React.MouseEvent, playlist: PlaylistSummary) => {
    e.stopPropagation(); // Avoid triggering edit selection
    setPlaylistToDelete(playlist);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!playlistToDelete) return;
    try {
      const res = await fetch(getApiUrl(`/playlists/${playlistToDelete.id}`), {
        method: "DELETE",
      });
      if (res.ok) {
        showToast("Playlist supprimée !");
        setPlaylists((prev) => prev.filter((p) => p.id !== playlistToDelete.id));
        // Reset editor if deleted active editing playlist
        if (selectedPlaylistId === playlistToDelete.id) {
          handleCancelEdit();
        }
      } else {
        showToast("Impossible de supprimer la playlist", "error");
      }
    } catch {
      showToast("Erreur réseau lors de la suppression", "error");
    } finally {
      setShowDeleteConfirm(false);
      setPlaylistToDelete(null);
    }
  };

  // Duplicate Playlist
  const handleDuplicate = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation(); // Avoid triggering edit selection
    try {
      const res = await fetch(getApiUrl(`/playlists/${id}/duplicate`), {
        method: "POST",
      });
      if (res.ok) {
        showToast("Playlist dupliquée avec succès !");
        fetchPlaylists();
      } else {
        showToast("Impossible de dupliquer la playlist", "error");
      }
    } catch {
      showToast("Erreur de connexion", "error");
    }
  };

  // Trigger Create New Playlist
  const handleCreateOpen = () => {
    setSelectedPlaylistId(null);
    setIsCreating(true);
    setPlaylistName("");
    setPlaylistItems([]);
    setVideoSearch("");
    setVideoProgramFilter("");
  };

  // Select Playlist for Editing
  const handleSelectPlaylist = async (playlistSummary: PlaylistSummary) => {
    setSelectedPlaylistId(playlistSummary.id);
    setIsCreating(false);
    setPlaylistName(playlistSummary.name);
    setPlaylistItems([]);
    setVideoSearch("");
    setVideoProgramFilter("");

    try {
      const res = await fetch(getApiUrl(`/playlists/${playlistSummary.id}`), {
        cache: "no-store",
      });
      if (res.ok) {
        const detail: PlaylistDetail = await res.json();
        const items = detail.items.map((item) => item.video);
        setPlaylistItems(items);
      } else {
        showToast("Erreur lors de la récupération des détails de la playlist", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  };

  const handleCancelEdit = () => {
    setSelectedPlaylistId(null);
    setIsCreating(false);
    setPlaylistName("");
    setPlaylistItems([]);
  };

  // Sequencer Operations
  const handleAddVideo = (video: Video) => {
    setPlaylistItems((prev) => [...prev, video]);
    showToast(`"${video.title}" ajouté à la playlist`);
  };

  const handleRemoveVideo = (index: number) => {
    setPlaylistItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    setPlaylistItems((prev) => {
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[index - 1];
      copy[index - 1] = temp;
      return copy;
    });
  };

  const handleMoveDown = (index: number) => {
    setPlaylistItems((prev) => {
      if (index === prev.length - 1) return prev;
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[index + 1];
      copy[index + 1] = temp;
      return copy;
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playlistName.trim()) {
      showToast("Le nom de la playlist ne peut pas être vide", "warning");
      return;
    }

    setIsSaving(true);
    const itemsPayload: PlaylistItemInput[] = playlistItems.map((video, index) => ({
      video_id: video.id,
      position: index,
    }));

    try {
      const url = selectedPlaylistId
        ? getApiUrl(`/playlists/${selectedPlaylistId}`)
        : getApiUrl("/playlists");
      const method = selectedPlaylistId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: playlistName.trim(),
          items: itemsPayload,
        }),
      });

      if (res.ok) {
        showToast(
          selectedPlaylistId
            ? "Playlist mise à jour avec succès !"
            : "Playlist créée avec succès !"
        );
        fetchPlaylists();
        // If creating, select the new one or just reset selection
        if (!selectedPlaylistId) {
          const newPlaylistsRes = await fetch(getApiUrl("/playlists"), { cache: "no-store" });
          if (newPlaylistsRes.ok) {
            const newList: PlaylistSummary[] = await newPlaylistsRes.json();
            // Try to find the playlist with the matching name that has the newest id
            const created = newList.find((p) => p.name === playlistName.trim());
            if (created) {
              handleSelectPlaylist(created);
            } else {
              handleCancelEdit();
            }
          } else {
            handleCancelEdit();
          }
        } else {
          // Keep active selection, just refresh from server
          const activeSummary = playlists.find((p) => p.id === selectedPlaylistId);
          if (activeSummary) {
            handleSelectPlaylist({
              ...activeSummary,
              name: playlistName.trim(),
            });
          }
        }
      } else {
        const data = await res.json();
        showToast(data.detail || "Erreur de sauvegarde", "error");
      }
    } catch {
      showToast("Erreur de connexion lors de la sauvegarde", "error");
    } finally {
      setIsSaving(false);
    }
  };

  // Drag and Drop Handlers
  const handleDragStart = (e: React.DragEvent, indexOrId: number, source: "sequencer" | "library") => {
    setDragSource(source);
    if (source === "sequencer") {
      setDraggedIndex(indexOrId);
      e.dataTransfer.setData("text/plain", indexOrId.toString());
    } else {
      setDraggedVideoId(indexOrId);
      e.dataTransfer.setData("text/plain", indexOrId.toString());
    }
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (dragSource === "sequencer" && draggedIndex !== null) {
      if (draggedIndex !== targetIndex) {
        setPlaylistItems((prev) => {
          const copy = [...prev];
          const [moved] = copy.splice(draggedIndex, 1);
          copy.splice(targetIndex, 0, moved);
          return copy;
        });
      }
    } else if (dragSource === "library" && draggedVideoId !== null) {
      const video = videos.find((v) => v.id === draggedVideoId);
      if (video) {
        setPlaylistItems((prev) => {
          const copy = [...prev];
          copy.splice(targetIndex, 0, video);
          return copy;
        });
      }
    }
    resetDragState();
  };

  const handleDropOnEmptyZone = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragSource === "library" && draggedVideoId !== null) {
      const video = videos.find((v) => v.id === draggedVideoId);
      if (video) {
        setPlaylistItems((prev) => [...prev, video]);
      }
    }
    resetDragState();
  };

  const resetDragState = () => {
    setDraggedIndex(null);
    setDraggedVideoId(null);
    setDragSource(null);
    setDragOverIndex(null);
  };

  // Filtered lists
  const filteredPlaylists = playlists.filter((p) =>
    p.name.toLowerCase().includes(playlistSearch.toLowerCase())
  );

  const filteredVideos = videos.filter((v) => {
    const matchesSearch =
      v.title.toLowerCase().includes(videoSearch.toLowerCase()) ||
      (v.release && v.release.includes(videoSearch));
    const matchesProgram =
      !videoProgramFilter ||
      (videoProgramFilter === "Autre"
        ? !["RPM", "Sprint", "The Trip"].includes(v.program || "")
        : v.program === videoProgramFilter);
    return matchesSearch && matchesProgram;
  });

  // Calculate total duration for active items
  const totalDurationSeconds = playlistItems.reduce(
    (acc, item) => acc + (item.duration_seconds ?? 0),
    0
  );

  return (
    <div style={{ padding: "24px", height: "100%", overflow: "hidden" }}>
      {/* Toast Notifications */}
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
          {toast.type === "warning" && (
            <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
          <span>{toast.message}</span>
        </div>
      )}

      <div className="playlists-split-container">
        {/* Left Panel: Search & Playlists list */}
        <div className="playlists-left-panel">
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 4px", color: "var(--text-main)", fontWeight: 800 }}>
            Playlists
          </h3>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0 0 16px" }}>
            Gérez vos enchaînements automatiques.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
            <input
              type="text"
              className="form-control"
              placeholder="Rechercher une playlist..."
              value={playlistSearch}
              onChange={(e) => setPlaylistSearch(e.target.value)}
              style={{ height: "38px", fontSize: "0.85rem" }}
            />
            <button className="btn btn-primary" onClick={handleCreateOpen} style={{ width: "100%", height: "38px" }}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ marginRight: "6px" }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              Créer une Playlist
            </button>
          </div>

          <div className="playlists-scroll-area">
            {loading ? (
              <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                Chargement...
              </div>
            ) : filteredPlaylists.length === 0 ? (
              <div style={{ textAlign: "center", padding: "30px 10px", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                Aucune playlist trouvée.
              </div>
            ) : (
              filteredPlaylists.map((p) => {
                const isActiveCard = selectedPlaylistId === p.id && !isCreating;
                return (
                  <div
                    key={p.id}
                    className={`playlist-card ${isActiveCard ? "active" : ""}`}
                    onClick={() => handleSelectPlaylist(p)}
                  >
                    <div className="playlist-card-header">
                      <span className="playlist-card-title">{p.name}</span>
                    </div>
                    <div className="playlist-card-meta">
                      <span className="release-badge" style={{ padding: "2px 6px" }}>
                        {p.item_count} cours
                      </span>
                      <span>{formatDuration(p.total_duration_seconds)}</span>
                    </div>
                    <div className="playlist-card-actions">
                      <button
                        className="btn btn-primary"
                        style={{ height: "28px", padding: "0 10px", fontSize: "0.75rem" }}
                        onClick={(e) => handleLaunch(e, p.id)}
                        title="Lancer"
                      >
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" style={{ marginRight: "4px" }}>
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        Lancer
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ height: "28px", padding: "0 8px", fontSize: "0.75rem" }}
                        onClick={(e) => handleDuplicate(e, p.id)}
                        title="Dupliquer"
                      >
                        Dupliquer
                      </button>
                      <button
                        className="btn btn-danger"
                        style={{ height: "28px", padding: "0 8px", fontSize: "0.75rem" }}
                        onClick={(e) => triggerDelete(e, p)}
                        title="Supprimer"
                      >
                        Supprimer
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Panel: Editor or Placeholder */}
        <div className="playlists-right-panel">
          {selectedPlaylistId === null && !isCreating ? (
            <div className="editor-placeholder">
              <svg className="w-12 h-12" style={{ color: "rgba(255,255,255,0.06)", marginBottom: "12px" }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <h4 style={{ margin: 0, fontWeight: 700, color: "var(--text-main)" }}>Éditeur de Playlist</h4>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)" }}>
                Sélectionnez une playlist à gauche ou cliquez sur &quot;Créer une Playlist&quot; pour commencer.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSave} className="playlist-editor-form">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--text-main)" }}>
                  {isCreating ? "Nouvelle Playlist" : "Modifier la Playlist"}
                </h3>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ height: "36px", padding: "0 16px", fontSize: "0.85rem" }}
                    disabled={isSaving}
                  >
                    {isSaving ? "Enregistrement..." : "Sauvegarder"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ height: "36px", padding: "0 16px", fontSize: "0.85rem" }}
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                  >
                    Annuler
                  </button>
                </div>
              </div>

              {/* Name Input */}
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ fontSize: "0.75rem", marginBottom: "4px" }}>
                  Nom de la playlist
                </label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Ex: Enchaînement RPM & Sprint"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  required
                  disabled={isSaving}
                  style={{ height: "40px" }}
                />
              </div>

              {/* Metadata Grid */}
              <div className="editor-metadata-grid">
                <div className="metadata-stat">
                  <span className="metadata-stat-label">Nombre de cours</span>
                  <span className="metadata-stat-value">{playlistItems.length}</span>
                </div>
                <div className="metadata-stat">
                  <span className="metadata-stat-label">Durée totale</span>
                  <span className="metadata-stat-value">{formatDuration(totalDurationSeconds)}</span>
                </div>
                <div className="metadata-stat">
                  <span className="metadata-stat-label">Statut</span>
                  <span className="metadata-stat-value" style={{ color: "var(--accent-primary)", fontSize: "0.95rem", textTransform: "uppercase" }}>
                    En cours d&apos;édition
                  </span>
                </div>
              </div>

              {/* Visual Sequencer (Drag & Drop Zone) */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0 }}>
                <span className="form-label" style={{ fontSize: "0.75rem", margin: 0 }}>
                  Séquenceur visuel (Glisser pour réordonner)
                </span>
                
                <div
                  className={`drag-drop-zone ${dragOverIndex === -1 ? "drag-over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragSource === "library") setDragOverIndex(-1);
                  }}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDropOnEmptyZone}
                >
                  {playlistItems.length === 0 ? (
                    <div className="empty-playlist-placeholder">
                      <svg className="w-8 h-8" style={{ color: "rgba(255,255,255,0.04)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                      </svg>
                      <span>Aucun cours sélectionné.</span>
                      <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>Glissez-déposez des cours depuis la bibliothèque ci-dessous ou cliquez sur + Ajouter.</span>
                    </div>
                  ) : (
                    playlistItems.map((item, index) => {
                      const isDragged = draggedIndex === index && dragSource === "sequencer";
                      const isOver = dragOverIndex === index;
                      return (
                        <div
                          key={`${item.id}-${index}`}
                          className={`playlist-drag-item ${isDragged ? "dragging" : ""} ${isOver ? "drag-over-item" : ""}`}
                          draggable
                          onDragStart={(e) => handleDragStart(e, index, "sequencer")}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, index)}
                          onDragEnd={resetDragState}
                        >
                          <div className="drag-handle">⋮⋮</div>
                          <span style={{ fontWeight: 800, color: "var(--text-muted)", fontSize: "0.85rem", width: "16px" }}>
                            {index + 1}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-main)", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                              {item.title}
                            </div>
                            <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "1px" }}>
                              {item.program && (
                                <span className={`program-badge ${getProgramBadgeClass(item.program)}`} style={{ fontSize: "0.55rem", padding: "1px 4px" }}>
                                  {item.program}
                                </span>
                              )}
                              {item.release && (
                                <span className="release-badge" style={{ fontSize: "0.55rem", padding: "1px 4px" }}>
                                  Rel. {item.release}
                                </span>
                              )}
                              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                {formatItemDuration(item.duration_seconds)}
                              </span>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "4px" }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ width: "24px", height: "24px", padding: 0, borderRadius: "50%", fontSize: "0.8rem" }}
                              onClick={() => handleMoveUp(index)}
                              disabled={index === 0}
                              title="Monter"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ width: "24px", height: "24px", padding: 0, borderRadius: "50%", fontSize: "0.8rem" }}
                              onClick={() => handleMoveDown(index)}
                              disabled={index === playlistItems.length - 1}
                              title="Descendre"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger"
                              style={{ width: "24px", height: "24px", padding: 0, borderRadius: "50%", fontSize: "0.8rem" }}
                              onClick={() => handleRemoveVideo(index)}
                              title="Retirer"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Library Picker at the Bottom */}
              <div className="library-picker">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="form-label" style={{ fontSize: "0.75rem", margin: 0, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                    Bibliothèque de cours (Glisser ou + Ajouter)
                  </span>
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="text"
                    className="form-control"
                    style={{ flex: 1, height: "32px", fontSize: "0.8rem", padding: "0 10px" }}
                    placeholder="Rechercher par titre ou release..."
                    value={videoSearch}
                    onChange={(e) => setVideoSearch(e.target.value)}
                  />
                  <select
                    className="filter-select"
                    style={{ height: "32px", fontSize: "0.8rem", padding: "0 8px" }}
                    value={videoProgramFilter}
                    onChange={(e) => setVideoProgramFilter(e.target.value)}
                  >
                    <option value="">Tous</option>
                    <option value="RPM">RPM</option>
                    <option value="Sprint">Sprint</option>
                    <option value="The Trip">The Trip</option>
                    <option value="Autre">Autre</option>
                  </select>
                </div>

                <div className="library-picker-list">
                  {filteredVideos.length === 0 ? (
                    <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem", padding: "16px" }}>
                      Aucun cours ne correspond à la recherche.
                    </div>
                  ) : (
                    filteredVideos.map((video) => (
                      <div
                        key={video.id}
                        className="library-picker-item"
                        draggable
                        onDragStart={(e) => handleDragStart(e, video.id, "library")}
                        onDragEnd={resetDragState}
                      >
                        <div className="drag-handle" style={{ marginRight: "8px" }}>⋮⋮</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--text-main)" }}>
                            {video.title}
                          </span>
                          <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "1px" }}>
                            {video.program && (
                              <span className={`program-badge ${getProgramBadgeClass(video.program)}`} style={{ fontSize: "0.55rem", padding: "0px 4px" }}>
                                {video.program}
                              </span>
                            )}
                            {video.release && (
                              <span className="release-badge" style={{ fontSize: "0.55rem", padding: "0px 3px" }}>
                                Rel. {video.release}
                              </span>
                            )}
                            <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                              {formatItemDuration(video.duration_seconds)}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ height: "26px", padding: "0 8px", fontSize: "0.7rem", fontWeight: 700 }}
                          onClick={() => handleAddVideo(video)}
                        >
                          + Ajouter
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && playlistToDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>Supprimer la Playlist ?</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.5 }}>
              Êtes-vous sûr de vouloir supprimer la playlist <strong style={{ color: "var(--text-main)" }}>{playlistToDelete.name}</strong> ? Cette action est irréversible.
            </p>
            <div className="modal-actions">
              <button className="btn btn-danger" onClick={confirmDelete}>
                Supprimer
              </button>
              <button className="btn btn-secondary" onClick={() => {
                setShowDeleteConfirm(false);
                setPlaylistToDelete(null);
              }}>
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
