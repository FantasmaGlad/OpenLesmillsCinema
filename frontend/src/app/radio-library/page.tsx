"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useUploadManager } from "@/lib/UploadManager";
import Icon from "@/components/Icon";

// Bibliothèque musicale Radio (réf. docs/cahier-des-charges-radio.md, lots L1+L2).
// Trois vues séparées (décision D7) : « Morceaux & Playlists », « Artistes &
// Albums », « Tags & Genres ». Le dashboard de contrôle et la lecture arrivent
// aux lots suivants.

interface RadioTrack {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_number: number | null;
  disc_number: number | null;
  year: number | null;
  genre: string | null;
  duration_seconds: number | null;
  has_cover: boolean;
  tags: string[];
}

interface PlaylistSummary {
  id: number;
  name: string;
  is_default: boolean;
  item_count: number;
  total_duration_seconds: number;
  cover_track_id: number | null;
}

interface PlaylistItem {
  id: number;
  position: number;
  track: { id: number; title: string; artist: string | null; album: string | null; duration_seconds: number | null; has_cover: boolean };
}

interface PlaylistDetail {
  id: number;
  name: string;
  is_default: boolean;
  items: PlaylistItem[];
  total_duration_seconds: number;
}

interface ArtistEntry { name: string; track_count: number; album_count: number; }
interface AlbumEntry { album: string; album_artist: string | null; track_count: number; year: number | null; cover_track_id: number | null; }
interface TagEntry { id: number; name: string; track_count: number; }

type ViewMode = "library" | "browse" | "tags";
type Filter = { type: "artist" | "album" | "genre" | "tag"; value: string } | null;

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

export default function RadioLibraryPage() {
  const { t } = useAppSettings();

  const [tracks, setTracks] = useState<RadioTrack[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [artists, setArtists] = useState<ArtistEntry[]>([]);
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [tagsList, setTagsList] = useState<TagEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [coverVersion, setCoverVersion] = useState(0);

  const [view, setView] = useState<ViewMode>("library");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>(null);

  // Import
  const [uploadMode, setUploadMode] = useState<"files" | "zip">("files");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Édition d'un morceau
  const [selected, setSelected] = useState<RadioTrack | null>(null);
  const [form, setForm] = useState({
    title: "", artist: "", album: "", album_artist: "",
    track_number: "", disc_number: "", year: "", genre: "", tags: "",
  });
  const [savingDrawer, setSavingDrawer] = useState(false);
  const [toDelete, setToDelete] = useState<RadioTrack | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Playlists
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null>(null);
  const [addTrackSearch, setAddTrackSearch] = useState("");
  const [playlistToDelete, setPlaylistToDelete] = useState<PlaylistSummary | null>(null);

  // Tags
  const [newTagName, setNewTagName] = useState("");

  const { uploads, addUploads } = useUploadManager();
  const seenDoneIds = useRef<Set<string>>(new Set());

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fetchJson = async <T,>(path: string, fallback: T): Promise<T> => {
    try {
      const res = await fetch(getApiUrl(path), { cache: "no-store" });
      return res.ok ? await res.json() : fallback;
    } catch {
      return fallback;
    }
  };

  const refreshAll = async () => {
    setLoading(true);
    const [tr, pl, ar, al, tg] = await Promise.all([
      fetchJson<RadioTrack[]>("/radio/tracks", []),
      fetchJson<PlaylistSummary[]>("/radio/playlists", []),
      fetchJson<ArtistEntry[]>("/radio/artists", []),
      fetchJson<AlbumEntry[]>("/radio/albums", []),
      fetchJson<TagEntry[]>("/radio/tags", []),
    ]);
    setTracks(tr); setPlaylists(pl); setArtists(ar); setAlbums(al); setTagsList(tg);
    setLoading(false);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement initial, même motif que les autres pages bibliothèque
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const newlyDone = uploads.filter(
      (u) => (u.kind === "radio_files" || u.kind === "radio_zip") && u.status === "done" && !seenDoneIds.current.has(u.id)
    );
    if (newlyDone.length === 0) return;
    newlyDone.forEach((u) => seenDoneIds.current.add(u.id));
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads]);

  const trackCoverUrl = (id: number) => `${getApiUrl(`/radio/tracks/${id}/cover`)}?v=${coverVersion}`;

  // ---- Import ----
  const startFilesUpload = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    if (uploadMode === "zip") {
      addUploads([{ kind: "radio_zip", file: files[0], title: files[0].name }]);
    } else {
      addUploads([{ kind: "radio_files", files, title: files[0].name }]);
    }
    showToast(t("radioLibrary.importStarted"));
    if (fileInputRef.current) fileInputRef.current.value = "";
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
    startFilesUpload(e.dataTransfer.files);
  };

  // ---- Édition d'un morceau ----
  const openTrack = (track: RadioTrack) => {
    setSelected(track);
    setForm({
      title: track.title,
      artist: track.artist ?? "",
      album: track.album ?? "",
      album_artist: track.album_artist ?? "",
      track_number: track.track_number != null ? String(track.track_number) : "",
      disc_number: track.disc_number != null ? String(track.disc_number) : "",
      year: track.year != null ? String(track.year) : "",
      genre: track.genre ?? "",
      tags: track.tags.join(", "),
    });
  };

  const parseIntOrNull = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = parseInt(trimmed, 10);
    return Number.isNaN(n) ? null : n;
  };

  const saveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !form.title.trim()) { showToast(t("radioLibrary.saveError"), "warning"); return; }
    setSavingDrawer(true);
    try {
      const res = await fetch(getApiUrl(`/radio/tracks/${selected.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(), artist: form.artist, album: form.album,
          album_artist: form.album_artist, genre: form.genre,
          track_number: parseIntOrNull(form.track_number),
          disc_number: parseIntOrNull(form.disc_number),
          year: parseIntOrNull(form.year),
          tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (res.ok) {
        const updated: RadioTrack = await res.json();
        setSelected(updated);
        showToast(t("radioLibrary.updatedToast"));
        refreshAll();
      } else showToast(t("radioLibrary.saveError"), "error");
    } catch { showToast(t("radioLibrary.connectionError"), "error"); }
    finally { setSavingDrawer(false); }
  };

  const handleCoverSelected = async (fileList: FileList | null) => {
    if (!selected || !fileList || fileList.length === 0) return;
    const fd = new FormData();
    fd.append("file", fileList[0]);
    try {
      const res = await fetch(getApiUrl(`/radio/tracks/${selected.id}/cover`), { method: "POST", body: fd });
      if (res.ok) {
        const updated: RadioTrack = await res.json();
        setSelected(updated);
        setCoverVersion((v) => v + 1);
        showToast(t("radioLibrary.coverUpdatedToast"));
        refreshAll();
      } else showToast(t("radioLibrary.coverError"), "error");
    } catch { showToast(t("radioLibrary.coverError"), "error"); }
    finally { if (coverInputRef.current) coverInputRef.current.value = ""; }
  };

  const confirmDeleteTrack = async () => {
    if (!toDelete) return;
    try {
      const res = await fetch(getApiUrl(`/radio/tracks/${toDelete.id}`), { method: "DELETE" });
      if (res.ok) {
        showToast(t("radioLibrary.deletedToast"));
        if (selected?.id === toDelete.id) setSelected(null);
        refreshAll();
      } else showToast(t("radioLibrary.deleteError"), "error");
    } catch { showToast(t("radioLibrary.connectionError"), "error"); }
    finally { setToDelete(null); }
  };

  // ---- Playlists ----
  const openPlaylist = async (id: number) => {
    const detail = await fetchJson<PlaylistDetail | null>(`/radio/playlists/${id}`, null);
    if (detail) setEditingPlaylist(detail);
    else showToast(t("radioLibrary.playlistError"), "error");
  };

  const createPlaylist = async () => {
    const name = newPlaylistName.trim();
    if (!name) return;
    try {
      const res = await fetch(getApiUrl("/radio/playlists"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, track_ids: [] }),
      });
      if (res.ok) {
        const detail: PlaylistDetail = await res.json();
        setNewPlaylistName("");
        showToast(t("radioLibrary.playlistCreatedToast"));
        await refreshAll();
        setEditingPlaylist(detail);
      } else showToast(t("radioLibrary.playlistError"), "error");
    } catch { showToast(t("radioLibrary.playlistError"), "error"); }
  };

  const savePlaylist = async (id: number, name: string, trackIds: number[]) => {
    try {
      const res = await fetch(getApiUrl(`/radio/playlists/${id}`), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, track_ids: trackIds }),
      });
      if (res.ok) {
        const detail: PlaylistDetail = await res.json();
        setEditingPlaylist(detail);
        refreshAll();
        return true;
      }
    } catch { /* fallthrough */ }
    showToast(t("radioLibrary.playlistError"), "error");
    return false;
  };

  const reorderItem = (index: number, dir: -1 | 1) => {
    if (!editingPlaylist) return;
    const ids = editingPlaylist.items.map((i) => i.track.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    savePlaylist(editingPlaylist.id, editingPlaylist.name, ids);
  };

  const removeFromPlaylist = (trackId: number) => {
    if (!editingPlaylist) return;
    const ids = editingPlaylist.items.map((i) => i.track.id).filter((id) => id !== trackId);
    savePlaylist(editingPlaylist.id, editingPlaylist.name, ids);
  };

  const addToPlaylist = async (trackId: number) => {
    if (!editingPlaylist) return;
    try {
      const res = await fetch(getApiUrl(`/radio/playlists/${editingPlaylist.id}/tracks`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: trackId }),
      });
      if (res.ok) {
        const detail: PlaylistDetail = await res.json();
        setEditingPlaylist(detail);
        refreshAll();
      } else showToast(t("radioLibrary.playlistError"), "error");
    } catch { showToast(t("radioLibrary.playlistError"), "error"); }
  };

  const toggleDefault = async () => {
    if (!editingPlaylist) return;
    const method = editingPlaylist.is_default ? "DELETE" : "PUT";
    try {
      const res = await fetch(getApiUrl(`/radio/playlists/${editingPlaylist.id}/default`), { method });
      if (res.ok) {
        const detail: PlaylistDetail = await res.json();
        setEditingPlaylist(detail);
        refreshAll();
      } else showToast(t("radioLibrary.playlistError"), "error");
    } catch { showToast(t("radioLibrary.playlistError"), "error"); }
  };

  const confirmDeletePlaylist = async () => {
    if (!playlistToDelete) return;
    try {
      const res = await fetch(getApiUrl(`/radio/playlists/${playlistToDelete.id}`), { method: "DELETE" });
      if (res.ok) {
        showToast(t("radioLibrary.playlistDeletedToast"));
        if (editingPlaylist?.id === playlistToDelete.id) setEditingPlaylist(null);
        refreshAll();
      } else showToast(t("radioLibrary.playlistError"), "error");
    } catch { showToast(t("radioLibrary.playlistError"), "error"); }
    finally { setPlaylistToDelete(null); }
  };

  // ---- Tags ----
  const createTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    try {
      const res = await fetch(getApiUrl("/radio/tags"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (res.ok) { setNewTagName(""); showToast(t("radioLibrary.tagCreatedToast")); refreshAll(); }
      else showToast(t("radioLibrary.tagError"), "error");
    } catch { showToast(t("radioLibrary.tagError"), "error"); }
  };

  const renameTag = async (tag: TagEntry) => {
    const name = window.prompt(t("radioLibrary.renameTag"), tag.name);
    if (!name || name.trim() === tag.name) return;
    try {
      const res = await fetch(getApiUrl(`/radio/tags/${tag.id}`), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) refreshAll(); else showToast(t("radioLibrary.tagError"), "error");
    } catch { showToast(t("radioLibrary.tagError"), "error"); }
  };

  const deleteTag = async (tag: TagEntry) => {
    if (!window.confirm(t("radioLibrary.deleteTagConfirm", { name: tag.name }))) return;
    try {
      const res = await fetch(getApiUrl(`/radio/tags/${tag.id}`), { method: "DELETE" });
      if (res.ok) { showToast(t("radioLibrary.tagDeletedToast")); refreshAll(); }
      else showToast(t("radioLibrary.tagError"), "error");
    } catch { showToast(t("radioLibrary.tagError"), "error"); }
  };

  const applyFilter = (f: Filter) => { setFilter(f); setView("library"); setSearch(""); };

  // ---- Dérivés ----
  const genres = (() => {
    const map = new Map<string, number>();
    tracks.forEach((tr) => { if (tr.genre) map.set(tr.genre, (map.get(tr.genre) ?? 0) + 1); });
    return Array.from(map.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const q = search.trim().toLowerCase();
  const filteredTracks = tracks.filter((tr) => {
    if (q && ![tr.title, tr.artist, tr.album].some((f) => (f ?? "").toLowerCase().includes(q))) return false;
    if (filter) {
      if (filter.type === "artist" && tr.artist !== filter.value && tr.album_artist !== filter.value) return false;
      if (filter.type === "album" && tr.album !== filter.value) return false;
      if (filter.type === "genre" && tr.genre !== filter.value) return false;
      if (filter.type === "tag" && !tr.tags.includes(filter.value)) return false;
    }
    return true;
  });

  const addableTracks = editingPlaylist
    ? tracks.filter((tr) => {
        const s = addTrackSearch.trim().toLowerCase();
        return !s || [tr.title, tr.artist, tr.album].some((f) => (f ?? "").toLowerCase().includes(s));
      })
    : [];

  // ---- Rendu : cartes ----
  const trackCard = (track: RadioTrack) => (
    <div key={track.id} className="video-card" onClick={() => openTrack(track)}>
      <div className="thumbnail-wrapper" style={{ position: "relative", aspectRatio: "1 / 1", paddingTop: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-surface-elevated)" }}>
        {track.has_cover ? (
          // eslint-disable-next-line @next/next/no-img-element -- pochette servie par l'API
          <img src={trackCoverUrl(track.id)} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <Icon name="music_note" size={40} style={{ opacity: 0.25 }} />
        )}
        <span className="card-duration">{formatDuration(track.duration_seconds)}</span>
      </div>
      <div className="card-content">
        <h4 className="card-title" title={track.title}>{track.title}</h4>
        <div className="card-meta-row">
          <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {track.artist || t("radioLibrary.unknownArtist")}
          </span>
        </div>
      </div>
    </div>
  );

  const coverThumb = (coverTrackId: number | null, fallbackIcon: string) => (
    <div className="thumbnail-wrapper" style={{ position: "relative", aspectRatio: "1 / 1", paddingTop: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-surface-elevated)" }}>
      {coverTrackId != null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={trackCoverUrl(coverTrackId)} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <Icon name={fallbackIcon} size={40} style={{ opacity: 0.25 }} />
      )}
    </div>
  );

  return (
    <div className="library-container">
      {toast && <div className={`toast ${toast.type}`}><span>{toast.message}</span></div>}

      <div style={{ marginBottom: "12px" }}>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 800, margin: "0 0 4px" }}>{t("radioLibrary.title")}</h2>
        <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0 }}>{t("radioLibrary.subtitle")}</p>
      </div>

      {/* Sélecteur de vue (3 vues séparées, réf. D7) */}
      <div className="view-toggle" style={{ marginBottom: "16px", flexWrap: "wrap" }}>
        <button type="button" className={`view-btn ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}>{t("radioLibrary.viewLibrary")}</button>
        <button type="button" className={`view-btn ${view === "browse" ? "active" : ""}`} onClick={() => setView("browse")}>{t("radioLibrary.viewBrowse")}</button>
        <button type="button" className={`view-btn ${view === "tags" ? "active" : ""}`} onClick={() => setView("tags")}>{t("radioLibrary.viewTags")}</button>
      </div>

      {/* ==================== VUE MORCEAUX & PLAYLISTS ==================== */}
      {view === "library" && (
        <>
          {/* --- Playlists --- */}
          <h3 style={{ fontSize: "0.85rem", color: "var(--accent-primary)", margin: "0 0 12px" }}>{t("radioLibrary.playlistsTitle")}</h3>
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px", maxWidth: "480px" }}>
            <input type="text" className="form-control" placeholder={t("radioLibrary.newPlaylistPlaceholder")} value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createPlaylist(); }} />
            <button type="button" className="btn btn-primary" onClick={createPlaylist} style={{ whiteSpace: "nowrap" }}>{t("radioLibrary.create")}</button>
          </div>
          {playlists.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "0 0 24px" }}>{t("radioLibrary.noPlaylists")}</p>
          ) : (
            <div className="videos-grid" style={{ marginBottom: "28px" }}>
              {playlists.map((p) => (
                <div key={p.id} className="video-card" onClick={() => openPlaylist(p.id)}>
                  {coverThumb(p.cover_track_id, "queue_music")}
                  <div className="card-content">
                    <h4 className="card-title" title={p.name}>{p.name}</h4>
                    <div className="card-meta-row" style={{ gap: "6px", flexWrap: "wrap" }}>
                      {p.is_default && <span className="program-badge rpm" style={{ background: "var(--accent-primary)" }}>{t("radioLibrary.defaultBadge")}</span>}
                      <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                        {t("radioLibrary.itemsInPlaylist", { count: p.item_count })} · {formatDuration(p.total_duration_seconds)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* --- Import --- */}
          <div className={`upload-zone ${dragActive ? "drag-active" : ""}`}
            onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleFileDrop}
            onClick={() => fileInputRef.current?.click()}>
            <input ref={fileInputRef} type="file" accept={uploadMode === "zip" ? ".zip" : "audio/*"} multiple={uploadMode === "files"}
              style={{ display: "none" }} onChange={(e) => startFilesUpload(e.target.files)} />
            <div className="view-toggle" onClick={(e) => e.stopPropagation()} style={{ marginBottom: "8px" }}>
              <button type="button" className={`view-btn ${uploadMode === "files" ? "active" : ""}`} onClick={() => setUploadMode("files")}>{t("radioLibrary.chooseFiles")}</button>
              <button type="button" className={`view-btn ${uploadMode === "zip" ? "active" : ""}`} onClick={() => setUploadMode("zip")}>{t("radioLibrary.chooseZip")}</button>
            </div>
            <Icon name="cloud_upload" size={48} className="upload-icon" />
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>{t("radioLibrary.importTitle")}</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>{t("radioLibrary.importHint")}</p>
          </div>

          {/* --- Recherche / filtre / compteur --- */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "20px 0 16px", flexWrap: "wrap" }}>
            <input type="text" className="search-input" placeholder={t("radioLibrary.searchPlaceholder")} value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: "200px" }} />
            {filter && (
              <button type="button" className="btn btn-secondary" onClick={() => setFilter(null)} style={{ whiteSpace: "nowrap" }}>
                <Icon name="close" size={14} /> {t("radioLibrary.filteredBy", { value: filter.value })}
              </button>
            )}
            {!loading && <span style={{ color: "var(--text-dim)", fontSize: "0.85rem", whiteSpace: "nowrap" }}>{t("radioLibrary.countLabel", { count: filteredTracks.length })}</span>}
          </div>

          {/* --- Grille morceaux --- */}
          {loading ? (
            <div style={{ display: "flex", justifyContent: "center", minHeight: "200px", alignItems: "center", color: "var(--text-muted)" }}>{t("radioLibrary.loading")}</div>
          ) : tracks.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "220px", color: "var(--text-muted)" }}>
              <Icon name="radio" size={40} style={{ opacity: 0.25, marginBottom: "8px" }} />
              <p style={{ margin: 0, fontWeight: 600 }}>{t("radioLibrary.empty")}</p>
            </div>
          ) : filteredTracks.length === 0 ? (
            <div style={{ display: "flex", justifyContent: "center", minHeight: "160px", alignItems: "center", color: "var(--text-muted)" }}>{t("radioLibrary.noResults")}</div>
          ) : (
            <div className="videos-grid">{filteredTracks.map(trackCard)}</div>
          )}
        </>
      )}

      {/* ==================== VUE ARTISTES & ALBUMS ==================== */}
      {view === "browse" && (
        <>
          <h3 style={{ fontSize: "0.85rem", color: "var(--accent-primary)", margin: "0 0 12px" }}>{t("radioLibrary.artistsTitle")}</h3>
          {artists.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "0 0 24px" }}>{t("radioLibrary.noArtists")}</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "28px" }}>
              {artists.map((a) => (
                <button key={a.name} type="button" className="btn btn-secondary" onClick={() => applyFilter({ type: "artist", value: a.name })}>
                  <Icon name="person" size={16} /> {a.name} <span style={{ color: "var(--text-dim)" }}>({a.track_count})</span>
                </button>
              ))}
            </div>
          )}

          <h3 style={{ fontSize: "0.85rem", color: "var(--accent-primary)", margin: "0 0 12px" }}>{t("radioLibrary.albumsTitle")}</h3>
          {albums.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: 0 }}>{t("radioLibrary.noAlbums")}</p>
          ) : (
            <div className="videos-grid">
              {albums.map((al) => (
                <div key={`${al.album_artist}—${al.album}`} className="video-card" onClick={() => applyFilter({ type: "album", value: al.album })}>
                  {coverThumb(al.cover_track_id, "album")}
                  <div className="card-content">
                    <h4 className="card-title" title={al.album}>{al.album}</h4>
                    <div className="card-meta-row">
                      <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {al.album_artist || t("radioLibrary.unknownArtist")}{al.year ? ` · ${al.year}` : ""}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ==================== VUE TAGS & GENRES ==================== */}
      {view === "tags" && (
        <>
          <h3 style={{ fontSize: "0.85rem", color: "var(--accent-primary)", margin: "0 0 12px" }}>{t("radioLibrary.genresTitle")}</h3>
          {genres.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "0 0 24px" }}>{t("radioLibrary.noGenres")}</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "28px" }}>
              {genres.map((g) => (
                <button key={g.name} type="button" className="btn btn-secondary" onClick={() => applyFilter({ type: "genre", value: g.name })}>
                  <Icon name="label" size={16} /> {g.name} <span style={{ color: "var(--text-dim)" }}>({g.count})</span>
                </button>
              ))}
            </div>
          )}

          <h3 style={{ fontSize: "0.85rem", color: "var(--accent-primary)", margin: "0 0 12px" }}>{t("radioLibrary.tagsTitle")}</h3>
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px", maxWidth: "480px" }}>
            <input type="text" className="form-control" placeholder={t("radioLibrary.newTagPlaceholder")} value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createTag(); }} />
            <button type="button" className="btn btn-primary" onClick={createTag} style={{ whiteSpace: "nowrap" }}>{t("radioLibrary.create")}</button>
          </div>
          {tagsList.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: 0 }}>{t("radioLibrary.noTags")}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxWidth: "560px" }}>
              {tagsList.map((tag) => (
                <div key={tag.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: "var(--bg-surface-elevated)", borderRadius: "8px" }}>
                  <button type="button" onClick={() => applyFilter({ type: "tag", value: tag.name })}
                    style={{ flex: 1, textAlign: "left", background: "none", border: "none", color: "var(--text-main)", cursor: "pointer", fontWeight: 600 }}>
                    {tag.name} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({tag.track_count})</span>
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => renameTag(tag)}><Icon name="edit" size={14} /></button>
                  <button type="button" className="btn btn-danger" onClick={() => deleteTag(tag)}><Icon name="delete" size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ==================== DRAWER : édition d'un morceau ==================== */}
      {selected && (
        <>
          <div className="detail-drawer-overlay" onClick={() => setSelected(null)} />
          <div className="detail-drawer">
            <div className="drawer-header">
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "80%" }}>{t("radioLibrary.editTitle")}</h3>
              <button className="close-btn" onClick={() => setSelected(null)}><Icon name="close" size={20} /></button>
            </div>
            <div className="drawer-body">
              <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", marginBottom: "16px" }}>
                <div style={{ width: "120px", height: "120px", flexShrink: 0, borderRadius: "8px", overflow: "hidden", background: "var(--bg-surface-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {selected.has_cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={trackCoverUrl(selected.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : <Icon name="music_note" size={36} style={{ opacity: 0.25 }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "8px" }}>{t("radioLibrary.cover")}</div>
                  <input ref={coverInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleCoverSelected(e.target.files)} />
                  <button type="button" className="btn btn-secondary" onClick={() => coverInputRef.current?.click()}><Icon name="image" size={16} /> {t("radioLibrary.changeCover")}</button>
                </div>
              </div>
              <form className="drawer-form" onSubmit={saveMetadata}>
                <div className="form-group"><label className="form-label">{t("radioLibrary.fieldTitle")}</label>
                  <input type="text" className="form-control" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></div>
                <div style={{ display: "flex", gap: "12px" }}>
                  <div className="form-group" style={{ flex: 1 }}><label className="form-label">{t("radioLibrary.fieldArtist")}</label>
                    <input type="text" className="form-control" value={form.artist} onChange={(e) => setForm({ ...form, artist: e.target.value })} /></div>
                  <div className="form-group" style={{ flex: 1 }}><label className="form-label">{t("radioLibrary.fieldAlbumArtist")}</label>
                    <input type="text" className="form-control" value={form.album_artist} onChange={(e) => setForm({ ...form, album_artist: e.target.value })} /></div>
                </div>
                <div className="form-group"><label className="form-label">{t("radioLibrary.fieldAlbum")}</label>
                  <input type="text" className="form-control" value={form.album} onChange={(e) => setForm({ ...form, album: e.target.value })} /></div>
                <div style={{ display: "flex", gap: "12px" }}>
                  <div className="form-group" style={{ flex: 1 }}><label className="form-label">{t("radioLibrary.fieldTrackNumber")}</label>
                    <input type="number" className="form-control" value={form.track_number} onChange={(e) => setForm({ ...form, track_number: e.target.value })} /></div>
                  <div className="form-group" style={{ flex: 1 }}><label className="form-label">{t("radioLibrary.fieldDiscNumber")}</label>
                    <input type="number" className="form-control" value={form.disc_number} onChange={(e) => setForm({ ...form, disc_number: e.target.value })} /></div>
                  <div className="form-group" style={{ flex: 1 }}><label className="form-label">{t("radioLibrary.fieldYear")}</label>
                    <input type="number" className="form-control" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></div>
                </div>
                <div className="form-group"><label className="form-label">{t("radioLibrary.fieldGenre")}</label>
                  <input type="text" className="form-control" value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">{t("radioLibrary.fieldTags")}</label>
                  <input type="text" className="form-control" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="ambiance, énergique" />
                  <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{t("radioLibrary.tagsHint")}</span></div>
                <div className="drawer-actions">
                  <button type="submit" className="btn btn-primary" style={{ flex: 1, height: "48px" }} disabled={savingDrawer}>{savingDrawer ? t("radioLibrary.saving") : t("radioLibrary.save")}</button>
                  <button type="button" className="btn btn-danger" style={{ height: "48px" }} onClick={() => setToDelete(selected)}>{t("radioLibrary.delete")}</button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}

      {/* ==================== DRAWER : édition d'une playlist ==================== */}
      {editingPlaylist && (
        <>
          <div className="detail-drawer-overlay" onClick={() => setEditingPlaylist(null)} />
          <div className="detail-drawer">
            <div className="drawer-header">
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("radioLibrary.editPlaylistTitle")}</h3>
              <button className="close-btn" onClick={() => setEditingPlaylist(null)}><Icon name="close" size={20} /></button>
            </div>
            <div className="drawer-body">
              <div className="form-group"><label className="form-label">{t("radioLibrary.playlistNameLabel")}</label>
                <input type="text" className="form-control" value={editingPlaylist.name}
                  onChange={(e) => setEditingPlaylist({ ...editingPlaylist, name: e.target.value })}
                  onBlur={() => savePlaylist(editingPlaylist.id, editingPlaylist.name, editingPlaylist.items.map((i) => i.track.id))} /></div>

              <button type="button" className={`btn ${editingPlaylist.is_default ? "btn-primary" : "btn-secondary"}`} style={{ marginBottom: "16px" }} onClick={toggleDefault}>
                <Icon name="star" size={16} filled={editingPlaylist.is_default} />
                {editingPlaylist.is_default ? t("radioLibrary.unsetDefault") : t("radioLibrary.setDefault")}
              </button>

              <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "0 0 8px" }}>
                {t("radioLibrary.itemsInPlaylist", { count: editingPlaylist.items.length })}
              </h4>
              {editingPlaylist.items.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("radioLibrary.emptyPlaylist")}</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "16px" }}>
                  {editingPlaylist.items.map((item, index) => (
                    <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", background: "var(--bg-surface-elevated)", borderRadius: "6px" }}>
                      <span style={{ color: "var(--text-dim)", fontSize: "0.8rem", width: "20px" }}>{index + 1}</span>
                      <span style={{ flex: 1, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.track.title}<span style={{ color: "var(--text-muted)" }}> — {item.track.artist || t("radioLibrary.unknownArtist")}</span>
                      </span>
                      <button type="button" className="btn btn-secondary" title={t("radioLibrary.moveUp")} disabled={index === 0} onClick={() => reorderItem(index, -1)}><Icon name="arrow_upward" size={14} /></button>
                      <button type="button" className="btn btn-secondary" title={t("radioLibrary.moveDown")} disabled={index === editingPlaylist.items.length - 1} onClick={() => reorderItem(index, 1)}><Icon name="arrow_downward" size={14} /></button>
                      <button type="button" className="btn btn-danger" title={t("radioLibrary.remove")} onClick={() => removeFromPlaylist(item.track.id)}><Icon name="close" size={14} /></button>
                    </div>
                  ))}
                </div>
              )}

              <h4 style={{ fontSize: "0.85rem", fontWeight: 800, borderBottom: "1px solid var(--border-color)", paddingBottom: "6px", margin: "16px 0 8px" }}>{t("radioLibrary.addTracksTitle")}</h4>
              <input type="text" className="form-control" placeholder={t("radioLibrary.addTracksSearch")} value={addTrackSearch} onChange={(e) => setAddTrackSearch(e.target.value)} style={{ marginBottom: "8px" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "260px", overflowY: "auto" }}>
                {addableTracks.slice(0, 60).map((tr) => (
                  <div key={tr.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", background: "var(--bg-surface-elevated)", borderRadius: "6px" }}>
                    <span style={{ flex: 1, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {tr.title}<span style={{ color: "var(--text-muted)" }}> — {tr.artist || t("radioLibrary.unknownArtist")}</span>
                    </span>
                    <button type="button" className="btn btn-secondary" onClick={() => addToPlaylist(tr.id)}><Icon name="add" size={14} /> {t("radioLibrary.add")}</button>
                  </div>
                ))}
              </div>

              <div className="drawer-actions" style={{ marginTop: "16px" }}>
                <button type="button" className="btn btn-danger" style={{ width: "100%", height: "48px" }}
                  onClick={() => setPlaylistToDelete({ id: editingPlaylist.id, name: editingPlaylist.name, is_default: editingPlaylist.is_default, item_count: editingPlaylist.items.length, total_duration_seconds: editingPlaylist.total_duration_seconds, cover_track_id: null })}>
                  <Icon name="delete" size={16} /> {t("radioLibrary.deletePlaylist")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ==================== MODALES de suppression ==================== */}
      {toDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("radioLibrary.deleteConfirmTitle")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>{t("radioLibrary.deleteConfirmText", { title: toDelete.title })}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setToDelete(null)}>{t("radioLibrary.cancel")}</button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmDeleteTrack}>{t("radioLibrary.confirmDelete")}</button>
            </div>
          </div>
        </div>
      )}
      {playlistToDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("radioLibrary.deletePlaylist")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>{t("radioLibrary.deletePlaylistConfirm", { name: playlistToDelete.name })}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPlaylistToDelete(null)}>{t("radioLibrary.cancel")}</button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmDeletePlaylist}>{t("radioLibrary.confirmDelete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
