"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useUploadManager } from "@/lib/UploadManager";
import Icon from "@/components/Icon";

// Bibliothèque musicale Radio — écran unique « vue d'ensemble » (refonte).
// Barre latérale persistante (playlists / tags / genres / artistes, tous
// cliquables pour filtrer) + grille principale avec sélection multiple et
// actions groupées (taguer, ajouter à une playlist, supprimer). L'import est
// une modale (bouton dans la barre) plutôt qu'une zone géante au milieu. Les
// tags s'attribuent par clics (chips) dans le drawer d'un morceau ou en lot ;
// les playlists se réordonnent en glisser-déposer.

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

// Extensions audio acceptées (miroir de AUDIO_EXTENSIONS côté backend) : sert
// à filtrer les fichiers non-audio quand on importe un DOSSIER entier
// (webkitdirectory renvoie tout le contenu, sous-dossiers compris).
const AUDIO_EXTENSIONS = [
  ".mp3", ".m4a", ".aac", ".mp4", ".ogg", ".oga", ".opus", ".webm", ".flac",
  ".wav", ".wma", ".aiff", ".aif", ".aifc", ".ape", ".alac", ".wv", ".mka", ".m4b", ".ac3",
];
const isAudioFile = (name: string) => AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

export default function RadioLibraryPage() {
  const { t } = useAppSettings();

  const [tracks, setTracks] = useState<RadioTrack[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [artists, setArtists] = useState<ArtistEntry[]>([]);
  const [, setAlbums] = useState<AlbumEntry[]>([]);
  const [tagsList, setTagsList] = useState<TagEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [coverVersion, setCoverVersion] = useState(0);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const [artistsOpen, setArtistsOpen] = useState(false);

  // Sélection multiple + actions groupées
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<null | "tag" | "playlist">(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Import (modale)
  const [importOpen, setImportOpen] = useState(false);
  // Réf. simplification "juste le logo import, précisé en dessous zip/dossier/
  // pistes" : ZIP et pistes partagent désormais le même sélecteur générique
  // (détecté après coup à la sélection, cf. startFilesUpload) — seul le
  // dossier a encore besoin d'un mode dédié (sélecteur natif différent,
  // webkitdirectory).
  const [uploadMode, setUploadMode] = useState<"files" | "folder">("files");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Édition d'un morceau
  const [selectedTrack, setSelectedTrack] = useState<RadioTrack | null>(null);
  const [form, setForm] = useState({
    title: "", artist: "", album: "", album_artist: "",
    track_number: "", disc_number: "", year: "", genre: "",
  });
  const [drawerTags, setDrawerTags] = useState<string[]>([]);
  const [newChip, setNewChip] = useState("");
  const [savingDrawer, setSavingDrawer] = useState(false);
  const [toDelete, setToDelete] = useState<RadioTrack | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Playlists
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null>(null);
  const [addTrackSearch, setAddTrackSearch] = useState("");
  const [playlistToDelete, setPlaylistToDelete] = useState<PlaylistSummary | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

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
  // `webkitdirectory` est posé/retiré juste avant `click()`, dans le même
  // gestionnaire (pas via un effet React) : entre un `setUploadMode(...)` et
  // le re-rendu qui suivrait, `click()` ouvrirait le sélecteur natif AVANT
  // que l'attribut n'ait eu le temps d'être appliqué — l'utilisateur verrait
  // le mauvais type de sélecteur (fichiers au lieu de dossier ou l'inverse).
  const openFilesPicker = () => {
    setUploadMode("files");
    const el = fileInputRef.current;
    if (!el) return;
    el.removeAttribute("webkitdirectory");
    el.removeAttribute("directory");
    el.click();
  };

  const openFolderPicker = (e: React.MouseEvent) => {
    e.stopPropagation();
    setUploadMode("folder");
    const el = fileInputRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
    el.click();
  };

  const startFilesUpload = (fileList: FileList | null, modeOverride?: "files" | "folder") => {
    if (!fileList || fileList.length === 0) return;
    // `modeOverride` pour le dépôt glisser-déposer (cf. handleFileDrop) : un
    // setUploadMode() juste avant cet appel n'aurait pas encore été appliqué
    // (état React asynchrone) au moment où cette fonction lit `uploadMode`.
    const mode = modeOverride ?? uploadMode;
    let files = Array.from(fileList);
    if (mode === "folder") {
      files = files.filter((f) => isAudioFile(f.name));
      if (files.length === 0) {
        showToast(t("radioLibrary.noAudioInFolder"), "warning");
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      // UNE tâche par morceau (réf. « on ne voit qu'un chargement du premier
      // audio ») : comme les vidéos, chaque fichier a sa propre ligne de
      // progression dans le panneau d'import, au lieu d'un seul lot opaque.
      // L'endpoint /radio/tracks/upload accepte une liste — un fichier par
      // requête crée un job d'import distinct, donc un suivi 1-par-1.
      addUploads(files.map((f) => ({ kind: "radio_files" as const, files: [f], title: f.name })));
    } else if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
      // Une seule archive ZIP sélectionnée/déposée : détectée automatiquement,
      // pas besoin d'un mode dédié (réf. simplification de l'import).
      addUploads([{ kind: "radio_zip", file: files[0], title: files[0].name }]);
    } else {
      // Idem sélection multiple de fichiers : une tâche (donc une ligne de
      // suivi) par morceau.
      addUploads(files.map((f) => ({ kind: "radio_files" as const, files: [f], title: f.name })));
    }
    showToast(t("radioLibrary.importStarted"));
    if (fileInputRef.current) fileInputRef.current.value = "";
    setImportOpen(false);
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
    // Un dépôt glisser-déposer n'est jamais le résultat du sélecteur dossier
    // natif (webkitdirectory) — toujours des fichiers à plat, quel que soit
    // le dernier mode utilisé au clic (cf. modeOverride, évite le décalage
    // d'un setUploadMode() asynchrone).
    startFilesUpload(e.dataTransfer.files, "files");
  };

  // ---- Édition d'un morceau ----
  const openTrack = (track: RadioTrack) => {
    setSelectedTrack(track);
    setForm({
      title: track.title,
      artist: track.artist ?? "",
      album: track.album ?? "",
      album_artist: track.album_artist ?? "",
      track_number: track.track_number != null ? String(track.track_number) : "",
      disc_number: track.disc_number != null ? String(track.disc_number) : "",
      year: track.year != null ? String(track.year) : "",
      genre: track.genre ?? "",
    });
    setDrawerTags([...track.tags]);
    setNewChip("");
  };

  const parseIntOrNull = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = parseInt(trimmed, 10);
    return Number.isNaN(n) ? null : n;
  };

  const toggleDrawerTag = (name: string) => {
    setDrawerTags((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  };
  const addChip = () => {
    const name = newChip.trim();
    if (!name) return;
    setDrawerTags((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setNewChip("");
  };

  const saveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTrack || !form.title.trim()) { showToast(t("radioLibrary.saveError"), "warning"); return; }
    setSavingDrawer(true);
    try {
      const res = await fetch(getApiUrl(`/radio/tracks/${selectedTrack.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(), artist: form.artist, album: form.album,
          album_artist: form.album_artist, genre: form.genre,
          track_number: parseIntOrNull(form.track_number),
          disc_number: parseIntOrNull(form.disc_number),
          year: parseIntOrNull(form.year),
          tags: drawerTags,
        }),
      });
      if (res.ok) {
        const updated: RadioTrack = await res.json();
        setSelectedTrack(updated);
        setDrawerTags([...updated.tags]);
        showToast(t("radioLibrary.updatedToast"));
        refreshAll();
      } else showToast(t("radioLibrary.saveError"), "error");
    } catch { showToast(t("radioLibrary.connectionError"), "error"); }
    finally { setSavingDrawer(false); }
  };

  const handleCoverSelected = async (fileList: FileList | null) => {
    if (!selectedTrack || !fileList || fileList.length === 0) return;
    const fd = new FormData();
    fd.append("file", fileList[0]);
    try {
      const res = await fetch(getApiUrl(`/radio/tracks/${selectedTrack.id}/cover`), { method: "POST", body: fd });
      if (res.ok) {
        const updated: RadioTrack = await res.json();
        setSelectedTrack(updated);
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
        if (selectedTrack?.id === toDelete.id) setSelectedTrack(null);
        refreshAll();
      } else showToast(t("radioLibrary.deleteError"), "error");
    } catch { showToast(t("radioLibrary.connectionError"), "error"); }
    finally { setToDelete(null); }
  };

  // ---- Sélection multiple ----
  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => { setSelected(new Set()); setBulkMenu(null); };

  const applyTagToSelection = async (name: string, add: boolean) => {
    const targets = tracks.filter((tr) => selected.has(tr.id));
    await Promise.all(targets.map((tr) => {
      const has = tr.tags.includes(name);
      if (add === has) return Promise.resolve();
      const nextTags = add ? [...tr.tags, name] : tr.tags.filter((x) => x !== name);
      return fetch(getApiUrl(`/radio/tracks/${tr.id}`), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: nextTags }),
      });
    }));
    showToast(t("radioLibrary.tagsAppliedToast"));
    refreshAll();
  };

  const addSelectionToPlaylist = async (playlistId: number) => {
    const detail = await fetchJson<PlaylistDetail | null>(`/radio/playlists/${playlistId}`, null);
    if (!detail) { showToast(t("radioLibrary.playlistError"), "error"); return; }
    const existing = detail.items.map((i) => i.track.id);
    const merged = [...existing];
    selected.forEach((id) => { if (!merged.includes(id)) merged.push(id); });
    try {
      const res = await fetch(getApiUrl(`/radio/playlists/${playlistId}`), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: detail.name, track_ids: merged }),
      });
      if (res.ok) { showToast(t("radioLibrary.bulkAddedToPlaylistToast")); setBulkMenu(null); refreshAll(); }
      else showToast(t("radioLibrary.playlistError"), "error");
    } catch { showToast(t("radioLibrary.playlistError"), "error"); }
  };

  const confirmBulkDelete = async () => {
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) => fetch(getApiUrl(`/radio/tracks/${id}`), { method: "DELETE" }).catch(() => null)));
    showToast(t("radioLibrary.bulkDeletedToast", { count: ids.length }));
    setBulkDeleteOpen(false);
    clearSelection();
    refreshAll();
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

  // Réordonnancement glisser-déposer (natif HTML5, pas de dépendance).
  const handleItemDrop = (dropIndex: number) => {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragOverIndex(null);
    if (from === null || from === dropIndex || !editingPlaylist) return;
    const ids = editingPlaylist.items.map((i) => i.track.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(dropIndex, 0, moved);
    savePlaylist(editingPlaylist.id, editingPlaylist.name, ids);
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
      else if (res.status === 409) showToast(t("radioLibrary.tagExists"), "warning");
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
      if (res.ok) {
        showToast(t("radioLibrary.tagDeletedToast"));
        if (filter?.type === "tag" && filter.value === tag.name) setFilter(null);
        refreshAll();
      } else showToast(t("radioLibrary.tagError"), "error");
    } catch { showToast(t("radioLibrary.tagError"), "error"); }
  };

  const applyFilter = (f: Filter) => { setFilter(f); };

  // ---- Dérivés ----
  const genres = useMemo(() => {
    const map = new Map<string, number>();
    tracks.forEach((tr) => { if (tr.genre) map.set(tr.genre, (map.get(tr.genre) ?? 0) + 1); });
    return Array.from(map.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }, [tracks]);

  const q = search.trim().toLowerCase();
  const filteredTracks = useMemo(() => tracks.filter((tr) => {
    if (q && ![tr.title, tr.artist, tr.album].some((f) => (f ?? "").toLowerCase().includes(q))) return false;
    if (filter) {
      if (filter.type === "artist" && tr.artist !== filter.value && tr.album_artist !== filter.value) return false;
      if (filter.type === "album" && tr.album !== filter.value) return false;
      if (filter.type === "genre" && tr.genre !== filter.value) return false;
      if (filter.type === "tag" && !tr.tags.includes(filter.value)) return false;
    }
    return true;
  }), [tracks, q, filter]);

  const addableTracks = editingPlaylist
    ? tracks.filter((tr) => {
        const s = addTrackSearch.trim().toLowerCase();
        return !s || [tr.title, tr.artist, tr.album].some((f) => (f ?? "").toLowerCase().includes(s));
      })
    : [];

  const visibleIds = filteredTracks.map((tr) => tr.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  // État tri-valué d'un tag sur la sélection courante (pour le menu de tag en lot).
  const selectionTagState = (name: string): "all" | "some" | "none" => {
    const targets = tracks.filter((tr) => selected.has(tr.id));
    if (targets.length === 0) return "none";
    const withTag = targets.filter((tr) => tr.tags.includes(name)).length;
    if (withTag === 0) return "none";
    if (withTag === targets.length) return "all";
    return "some";
  };

  const filterLabel = filter ? filter.value : t("radioLibrary.allTracks");

  // ---- Rendu : carte morceau ----
  const trackCard = (track: RadioTrack) => {
    const isSel = selected.has(track.id);
    return (
      <div key={track.id} className={`video-card rl-card ${isSel ? "selected" : ""}`} onClick={() => openTrack(track)}>
        <button
          type="button"
          className={`rl-card-check ${isSel ? "on" : ""}`}
          title={t("radioLibrary.select")}
          onClick={(e) => { e.stopPropagation(); toggleSelect(track.id); }}
        >
          <Icon name={isSel ? "check_circle" : "radio_button_unchecked"} size={20} filled={isSel} />
        </button>
        <div className="thumbnail-wrapper rl-thumb">
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
            <span className="rl-card-artist">{track.artist || t("radioLibrary.unknownArtist")}</span>
          </div>
          {track.tags.length > 0 && (
            <div className="rl-card-tags">
              {track.tags.slice(0, 3).map((tg) => <span key={tg} className="rl-card-tag">{tg}</span>)}
              {track.tags.length > 3 && <span className="rl-card-tag">+{track.tags.length - 3}</span>}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Ligne cliquable de la barre latérale (filtre).
  const navItem = (active: boolean, icon: string, label: string, count: number | null, onClick: () => void, extra?: React.ReactNode) => (
    <div className={`rl-nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="rl-nav-label" title={label}>{label}</span>
      {count != null && <span className="rl-nav-count">{count}</span>}
      {extra}
    </div>
  );

  return (
    <div className="radio-lib">
      {toast && <div className={`toast ${toast.type}`}><span>{toast.message}</span></div>}

      {/* ==================== BARRE LATÉRALE ==================== */}
      <aside className="radio-lib-sidebar">
        <div className="rl-sidebar-head">
          <div>
            <h2 className="rl-title">{t("radioLibrary.title")}</h2>
            <p className="rl-subtitle">{t("radioLibrary.overviewSubtitle")}</p>
          </div>
          <button type="button" className="btn btn-primary rl-import-btn" onClick={() => setImportOpen(true)}>
            <Icon name="cloud_upload" size={16} /> {t("radioLibrary.importButton")}
          </button>
        </div>

        <input
          type="text" className="search-input rl-search"
          placeholder={t("radioLibrary.searchPlaceholder")}
          value={search} onChange={(e) => setSearch(e.target.value)}
        />

        <div className="rl-sidebar-scroll">
          {navItem(filter === null, "library_music", t("radioLibrary.allTracks"), tracks.length, () => setFilter(null))}

          {/* Playlists */}
          <div className="rl-section-head">
            <span>{t("radioLibrary.playlistsTitle")}</span>
            <span className="rl-nav-count">{playlists.length}</span>
          </div>
          <div className="rl-create-row">
            <input type="text" className="form-control" placeholder={t("radioLibrary.newPlaylistPlaceholder")} value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createPlaylist(); }} />
            <button type="button" className="btn btn-secondary" onClick={createPlaylist} title={t("radioLibrary.create")}><Icon name="add" size={16} /></button>
          </div>
          {playlists.length === 0 ? (
            <p className="rl-empty-note">{t("radioLibrary.noPlaylists")}</p>
          ) : playlists.map((p) => (
            <div key={p.id} className="rl-nav-item" onClick={() => openPlaylist(p.id)}>
              <Icon name={p.is_default ? "star" : "queue_music"} size={16} filled={p.is_default} />
              <span className="rl-nav-label" title={p.name}>{p.name}</span>
              <span className="rl-nav-count">{p.item_count}</span>
            </div>
          ))}

          {/* Tags */}
          <div className="rl-section-head">
            <span>{t("radioLibrary.tagsTitle")}</span>
            <span className="rl-nav-count">{tagsList.length}</span>
          </div>
          <div className="rl-create-row">
            <input type="text" className="form-control" placeholder={t("radioLibrary.newTagPlaceholder")} value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createTag(); }} />
            <button type="button" className="btn btn-secondary" onClick={createTag} title={t("radioLibrary.create")}><Icon name="add" size={16} /></button>
          </div>
          {tagsList.length === 0 ? (
            <p className="rl-empty-note">{t("radioLibrary.noTags")}</p>
          ) : tagsList.map((tag) => (
            <div key={tag.id} className={`rl-nav-item ${filter?.type === "tag" && filter.value === tag.name ? "active" : ""}`} onClick={() => applyFilter({ type: "tag", value: tag.name })}>
              <Icon name="label" size={16} />
              <span className="rl-nav-label" title={tag.name}>{tag.name}</span>
              <span className="rl-nav-count">{tag.track_count}</span>
              <span className="rl-nav-actions">
                <button type="button" title={t("radioLibrary.renameTag")} onClick={(e) => { e.stopPropagation(); renameTag(tag); }}><Icon name="edit" size={13} /></button>
                <button type="button" title={t("radioLibrary.deleteTag")} onClick={(e) => { e.stopPropagation(); deleteTag(tag); }}><Icon name="delete" size={13} /></button>
              </span>
            </div>
          ))}

          {/* Genres */}
          {genres.length > 0 && (
            <>
              <div className="rl-section-head"><span>{t("radioLibrary.genresTitle")}</span><span className="rl-nav-count">{genres.length}</span></div>
              {genres.map((g) => navItem(
                filter?.type === "genre" && filter.value === g.name, "graphic_eq", g.name, g.count,
                () => applyFilter({ type: "genre", value: g.name }),
              ))}
            </>
          )}

          {/* Artistes (repliable) */}
          {artists.length > 0 && (
            <>
              <div className="rl-section-head rl-collapsible" onClick={() => setArtistsOpen((o) => !o)}>
                <Icon name={artistsOpen ? "expand_more" : "chevron_right"} size={16} />
                <span>{t("radioLibrary.artistsTitle")}</span>
                <span className="rl-nav-count">{artists.length}</span>
              </div>
              {artistsOpen && artists.map((a) => navItem(
                filter?.type === "artist" && filter.value === a.name, "person", a.name, a.track_count,
                () => applyFilter({ type: "artist", value: a.name }),
              ))}
            </>
          )}
        </div>
      </aside>

      {/* ==================== ZONE PRINCIPALE ==================== */}
      <main className="radio-lib-main"
        onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleFileDrop}>
        {dragActive && (
          <div className="rl-drop-overlay"><Icon name="cloud_upload" size={40} /><span>{t("radioLibrary.dropHere")}</span></div>
        )}

        {selected.size === 0 ? (
          <div className="rl-toolbar">
            <div className="rl-filter-chip">
              <Icon name={filter ? (filter.type === "tag" ? "label" : filter.type === "genre" ? "graphic_eq" : "person") : "library_music"} size={16} />
              <span>{filterLabel}</span>
              {filter && <button type="button" onClick={() => setFilter(null)} title={t("radioLibrary.clearFilter")}><Icon name="close" size={14} /></button>}
            </div>
            <span className="rl-count">{t("radioLibrary.countLabel", { count: filteredTracks.length })}</span>
            <div className="rl-toolbar-spacer" />
            {filteredTracks.length > 0 && (
              <button type="button" className="btn btn-secondary" onClick={toggleSelectAllVisible}>
                <Icon name="checklist" size={16} /> {allVisibleSelected ? t("radioLibrary.deselectAll") : t("radioLibrary.selectAll")}
              </button>
            )}
          </div>
        ) : (
          <div className="rl-selection-bar">
            <button type="button" className="rl-sel-close" onClick={clearSelection} title={t("radioLibrary.clearSelection")}><Icon name="close" size={18} /></button>
            <span className="rl-sel-count">{t("radioLibrary.selectionCount", { count: selected.size })}</span>
            <div className="rl-toolbar-spacer" />
            <div className="rl-bulk-wrap">
              <button type="button" className="btn btn-secondary" onClick={() => setBulkMenu(bulkMenu === "tag" ? null : "tag")}><Icon name="label" size={16} /> {t("radioLibrary.bulkTag")}</button>
              {bulkMenu === "tag" && (
                <div className="rl-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="rl-popover-title">{t("radioLibrary.bulkTagTitle")}</div>
                  {tagsList.length === 0 ? <p className="rl-empty-note">{t("radioLibrary.noTags")}</p> : tagsList.map((tag) => {
                    const st = selectionTagState(tag.name);
                    return (
                      <button key={tag.id} type="button" className="rl-popover-item" onClick={() => applyTagToSelection(tag.name, st !== "all")}>
                        <Icon name={st === "all" ? "check_box" : st === "some" ? "indeterminate_check_box" : "check_box_outline_blank"} size={18} />
                        <span>{tag.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="rl-bulk-wrap">
              <button type="button" className="btn btn-secondary" onClick={() => setBulkMenu(bulkMenu === "playlist" ? null : "playlist")}><Icon name="playlist_add" size={16} /> {t("radioLibrary.bulkAddToPlaylist")}</button>
              {bulkMenu === "playlist" && (
                <div className="rl-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="rl-popover-title">{t("radioLibrary.addToPlaylistTitle")}</div>
                  {playlists.length === 0 ? <p className="rl-empty-note">{t("radioLibrary.noPlaylists")}</p> : playlists.map((p) => (
                    <button key={p.id} type="button" className="rl-popover-item" onClick={() => addSelectionToPlaylist(p.id)}>
                      <Icon name={p.is_default ? "star" : "queue_music"} size={16} filled={p.is_default} />
                      <span>{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="btn btn-danger" onClick={() => setBulkDeleteOpen(true)}><Icon name="delete" size={16} /> {t("radioLibrary.delete")}</button>
          </div>
        )}

        {/* Grille */}
        {loading ? (
          <div className="rl-center-note">{t("radioLibrary.loading")}</div>
        ) : tracks.length === 0 ? (
          <div className="rl-empty-state">
            <Icon name="radio" size={40} style={{ opacity: 0.25, marginBottom: "8px" }} />
            <p style={{ margin: 0, fontWeight: 600 }}>{t("radioLibrary.empty")}</p>
            <button type="button" className="btn btn-primary" style={{ marginTop: "12px" }} onClick={() => setImportOpen(true)}><Icon name="cloud_upload" size={16} /> {t("radioLibrary.importButton")}</button>
          </div>
        ) : filteredTracks.length === 0 ? (
          <div className="rl-center-note">{t("radioLibrary.noResults")}</div>
        ) : (
          <div className="videos-grid rl-grid">{filteredTracks.map(trackCard)}</div>
        )}
      </main>

      {/* Ferme les popovers en cliquant ailleurs */}
      {bulkMenu && <div className="rl-popover-scrim" onClick={() => setBulkMenu(null)} />}

      {/* ==================== MODALE : import ==================== */}
      {importOpen && (
        <div className="modal-overlay" onClick={() => setImportOpen(false)}>
          <div className="modal-content" style={{ maxWidth: "520px" }} onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header" style={{ padding: 0, marginBottom: "12px" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("radioLibrary.importTitle")}</h3>
              <button className="close-btn" onClick={() => setImportOpen(false)}><Icon name="close" size={20} /></button>
            </div>
            <div className={`upload-zone ${dragActive ? "drag-active" : ""}`}
              onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleFileDrop}
              onClick={openFilesPicker}>
              <input ref={fileInputRef} type="file" accept="audio/*,.zip" multiple
                style={{ display: "none" }} onChange={(e) => startFilesUpload(e.target.files)} />
              <Icon name="cloud_upload" size={44} className="upload-icon" />
              <p style={{ fontSize: "1rem", fontWeight: 800, color: "var(--text-main)", margin: "10px 0 0" }}>
                {t("radioLibrary.importCta")}
              </p>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "2px 0 0" }}>{t("radioLibrary.importHint")}</p>
              <button
                type="button"
                onClick={openFolderPicker}
                style={{
                  marginTop: "10px", background: "none", border: "none", padding: 0,
                  color: "var(--accent-primary)", fontWeight: 700, fontSize: "0.8rem",
                  cursor: "pointer", textDecoration: "underline",
                }}
              >
                {t("radioLibrary.chooseFolder")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== DRAWER : édition d'un morceau ==================== */}
      {selectedTrack && (
        <>
          <div className="detail-drawer-overlay" onClick={() => setSelectedTrack(null)} />
          <div className="detail-drawer">
            <div className="drawer-header">
              <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "80%" }}>{t("radioLibrary.editTitle")}</h3>
              <button className="close-btn" onClick={() => setSelectedTrack(null)}><Icon name="close" size={20} /></button>
            </div>
            <div className="drawer-body">
              <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", marginBottom: "16px" }}>
                <div style={{ width: "120px", height: "120px", flexShrink: 0, borderRadius: "8px", overflow: "hidden", background: "var(--bg-surface-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {selectedTrack.has_cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={trackCoverUrl(selectedTrack.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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

                {/* Tags en chips cliquables */}
                <div className="form-group">
                  <label className="form-label">{t("radioLibrary.fieldTags")}</label>
                  <div className="rl-chips">
                    {Array.from(new Set([...tagsList.map((tg) => tg.name), ...drawerTags])).sort((a, b) => a.localeCompare(b)).map((name) => {
                      const on = drawerTags.includes(name);
                      return (
                        <button key={name} type="button" className={`rl-chip ${on ? "on" : ""}`} onClick={() => toggleDrawerTag(name)}>
                          {on && <Icon name="check" size={13} />} {name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="rl-chip-add">
                    <input type="text" className="form-control" placeholder={t("radioLibrary.addTagPlaceholder")} value={newChip}
                      onChange={(e) => setNewChip(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChip(); } }} />
                    <button type="button" className="btn btn-secondary" onClick={addChip}><Icon name="add" size={16} /></button>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{t("radioLibrary.tagsChipsHint")}</span>
                </div>

                <div className="drawer-actions">
                  <button type="submit" className="btn btn-primary" style={{ flex: 1, height: "48px" }} disabled={savingDrawer}>{savingDrawer ? t("radioLibrary.saving") : t("radioLibrary.save")}</button>
                  <button type="button" className="btn btn-danger" style={{ height: "48px" }} onClick={() => setToDelete(selectedTrack)}>{t("radioLibrary.delete")}</button>
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

              <h4 className="rl-drawer-subhead">
                {t("radioLibrary.itemsInPlaylist", { count: editingPlaylist.items.length })}
                {editingPlaylist.items.length > 1 && <span className="rl-dnd-hint"> · {t("radioLibrary.dragHint")}</span>}
              </h4>
              {editingPlaylist.items.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("radioLibrary.emptyPlaylist")}</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "16px" }}>
                  {editingPlaylist.items.map((item, index) => (
                    <div key={item.id}
                      className={`rl-pl-item ${dragOverIndex === index ? "drag-over" : ""}`}
                      draggable
                      onDragStart={() => { dragIndexRef.current = index; }}
                      onDragOver={(e) => { e.preventDefault(); setDragOverIndex(index); }}
                      onDragLeave={() => setDragOverIndex((cur) => (cur === index ? null : cur))}
                      onDrop={(e) => { e.preventDefault(); handleItemDrop(index); }}
                      onDragEnd={() => { dragIndexRef.current = null; setDragOverIndex(null); }}
                    >
                      <Icon name="drag_indicator" size={16} className="rl-drag-handle" />
                      <span style={{ color: "var(--text-dim)", fontSize: "0.8rem", width: "20px" }}>{index + 1}</span>
                      <span style={{ flex: 1, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.track.title}<span style={{ color: "var(--text-muted)" }}> — {item.track.artist || t("radioLibrary.unknownArtist")}</span>
                      </span>
                      <button type="button" className="btn btn-danger" title={t("radioLibrary.remove")} onClick={() => removeFromPlaylist(item.track.id)}><Icon name="close" size={14} /></button>
                    </div>
                  ))}
                </div>
              )}

              <h4 className="rl-drawer-subhead" style={{ marginTop: "16px" }}>{t("radioLibrary.addTracksTitle")}</h4>
              <input type="text" className="form-control" placeholder={t("radioLibrary.addTracksSearch")} value={addTrackSearch} onChange={(e) => setAddTrackSearch(e.target.value)} style={{ marginBottom: "8px" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "280px", overflowY: "auto" }}>
                {addableTracks.map((tr) => {
                  const already = editingPlaylist.items.some((i) => i.track.id === tr.id);
                  return (
                    <div key={tr.id} className="rl-add-row">
                      <span style={{ flex: 1, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {tr.title}<span style={{ color: "var(--text-muted)" }}> — {tr.artist || t("radioLibrary.unknownArtist")}</span>
                      </span>
                      <button type="button" className="btn btn-secondary" disabled={already} onClick={() => addToPlaylist(tr.id)}>
                        <Icon name={already ? "check" : "add"} size={14} /> {already ? t("radioLibrary.added") : t("radioLibrary.add")}
                      </button>
                    </div>
                  );
                })}
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
      {bulkDeleteOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("radioLibrary.bulkDeleteTitle", { count: selected.size })}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>{t("radioLibrary.bulkDeleteText")}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setBulkDeleteOpen(false)}>{t("radioLibrary.cancel")}</button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmBulkDelete}>{t("radioLibrary.confirmDelete")}</button>
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
