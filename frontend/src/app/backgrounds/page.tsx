"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useUploadManager, PendingUploadSpec } from "@/lib/UploadManager";
import Icon from "@/components/Icon";

interface BackgroundItem {
  id: number;
  file_path: string;
  title: string;
  duration_seconds: number | null;
  thumbnail_path: string | null;
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

function BackgroundCard({
  bg,
  isActive,
  onLaunch,
  onDelete,
}: {
  bg: BackgroundItem;
  isActive: boolean;
  onLaunch: () => void;
  onDelete: () => void;
}) {
  const { t } = useAppSettings();
  const [hovering, setHovering] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (hovering) {
      video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [hovering]);

  const thumbSrc = bg.thumbnail_path
    ? getApiUrl(`/thumbnails/${bg.thumbnail_path.split("/").pop()}`)
    : null;

  return (
    <div
      className={`video-card ${isActive ? "program-rpm" : ""}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={onLaunch}
    >
      <div className="thumbnail-wrapper">
        {hovering ? (
          <video
            ref={videoRef}
            className="card-thumbnail"
            src={getApiUrl(`/backgrounds/${bg.id}/stream`)}
            muted
            loop
            playsInline
          />
        ) : thumbSrc ? (
          <img src={thumbSrc} alt={bg.title} className="card-thumbnail" />
        ) : (
          <div style={{ position: "absolute", inset: 0, background: "var(--bg-surface-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="gradient" size={32} style={{ opacity: 0.2 }} />
          </div>
        )}
        {isActive && <span className="card-duration" style={{ background: "var(--accent-success)", left: 8, right: "auto" }}>{t("backgrounds.onScreen")}</span>}
      </div>
      <div className="card-content">
        <h4 className="card-title" title={bg.title}>
          {bg.title}
        </h4>
        <div className="card-meta-row">
          <span className="release-badge">{t("backgrounds.infiniteLoop")}</span>
          <button
            type="button"
            className="btn btn-danger"
            style={{ height: "32px", padding: "0 10px", fontSize: "0.75rem" }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            {t("common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BackgroundsPage() {
  const { t } = useAppSettings();
  // Canal ciblé par "Lancer" (réf. correctif "afficher un fond ne marche
  // pas — le kiosk réseau ne le lance jamais") : `usePlaybackSocket()` sans
  // argument cible TOUJOURS le canal câblé par défaut — cette page n'avait
  // aucun moyen de viser le réseau, un clic "Lancer" depuis ici n'affichait
  // donc jamais rien sur un kiosk réseau, quel que soit l'appareil utilisé
  // pour cliquer. Même sélecteur de canal que la page Planning.
  const [channel, setChannel] = useState<"cable" | "network">("cable");
  const { state, sendCommand } = usePlaybackSocket(undefined, undefined, channel);
  const [backgrounds, setBackgrounds] = useState<BackgroundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Mini-formulaires pour préparer les titres avant l'upload, même principe
  // que la bibliothèque vidéo (réf. mission "queue en direct des
  // importations + import parallèle") : plusieurs fichiers peuvent être
  // sélectionnés et lancés à la fois, et la zone reste utilisable pendant
  // qu'un import précédent est encore traité côté serveur — l'ancienne
  // version bloquait la sélection d'un second fichier tant que le premier
  // n'était pas totalement terminé (transfert + normalisation ffmpeg
  // éventuelle), impossible de lancer un second import en attendant.
  const [pendingSpecs, setPendingSpecs] = useState<Array<PendingUploadSpec & { key: string }>>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { addUploads, uploads } = useUploadManager();
  // Réf. mission "voir en direct les importations" : évite de redéclencher
  // un fetch à chaque tick de polling tant qu'aucun import de fond animé n'a
  // nouvellement terminé (effet déclaré plus bas, après `fetchBackgrounds`).
  const seenDoneIds = useRef<Set<string>>(new Set());

  const [toDelete, setToDelete] = useState<BackgroundItem | null>(null);

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fetchBackgrounds = async () => {
    setLoading(true);
    try {
      const res = await fetch(getApiUrl("/backgrounds"), { cache: "no-store" });
      if (res.ok) setBackgrounds(await res.json());
      else showToast(t("backgrounds.fetchError"), "error");
    } catch {
      showToast(t("backgrounds.connectionError"), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement initial, même motif que les autres pages (library/playlists/schedule)
    fetchBackgrounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rafraîchit la liste dès qu'un import de fond animé se termine (réf.
  // mission "voir en direct les importations") — voir library/page.tsx pour
  // le même mécanisme.
  useEffect(() => {
    const newlyDone = uploads.filter(
      (u) => u.kind === "background" && u.status === "done" && !seenDoneIds.current.has(u.id)
    );
    if (newlyDone.length === 0) return;
    newlyDone.forEach((u) => seenDoneIds.current.add(u.id));
    fetchBackgrounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads]);

  const addPendingSpecs = (files: File[]) => {
    const specs = files.map((file) => ({
      key: Math.random().toString(36).slice(2),
      kind: "background" as const,
      file,
      title: file.name.substring(0, file.name.lastIndexOf(".")) || file.name,
    }));
    setPendingSpecs((prev) => [...prev, ...specs]);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(e.type === "dragenter" || e.type === "dragover");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.length) addPendingSpecs(Array.from(e.dataTransfer.files));
  };

  const updatePendingSpec = (key: string, patch: Partial<PendingUploadSpec>) => {
    setPendingSpecs((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const removePendingSpec = (key: string) => {
    setPendingSpecs((prev) => prev.filter((s) => s.key !== key));
  };

  const submitPendingUploads = () => {
    if (pendingSpecs.length === 0) return;
    addUploads(pendingSpecs.map(({ file, title }) => ({ kind: "background" as const, file, title })));
    // Le résultat de chaque import (succès/échec) est visible en direct dans
    // le panneau d'imports flottant — plus besoin d'un toast générique ici.
    setPendingSpecs([]);
  };

  const handleLaunch = (bg: BackgroundItem) => {
    sendCommand("load_background", { background_id: bg.id });
    showToast(t("backgrounds.launchedToast", { title: bg.title }));
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      const res = await fetch(getApiUrl(`/backgrounds/${toDelete.id}`), { method: "DELETE" });
      if (res.ok) {
        showToast(t("backgrounds.deletedToast"));
        setBackgrounds((prev) => prev.filter((b) => b.id !== toDelete.id));
      } else {
        showToast(t("backgrounds.deleteError"), "error");
      }
    } finally {
      setToDelete(null);
    }
  };

  return (
    <div className="library-container">
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      )}

      {/* Sélecteur de canal (réf. correctif "afficher un fond ne marche
          pas") : détermine sur quel écran "Lancer" affiche le fond cliqué,
          et duquel des deux canaux le badge "à l'écran" reflète l'état. */}
      <div className="view-toggle" style={{ alignSelf: "flex-start" }}>
        <button
          className={`view-btn olc-press ${channel === "cable" ? "active" : ""}`}
          onClick={() => setChannel("cable")}
          title={t("backgrounds.channelCableTitle")}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "0 12px" }}
        >
          <Icon name="cable" size={16} />
          {t("backgrounds.channelTabCable")}
        </button>
        <button
          className={`view-btn olc-press ${channel === "network" ? "active" : ""}`}
          onClick={() => setChannel("network")}
          title={t("backgrounds.channelNetworkTitle")}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "0 12px" }}
        >
          <Icon name="wifi" size={16} />
          {t("backgrounds.channelTabNetwork")}
        </button>
      </div>

      <div
        className={`upload-zone ${dragActive ? "drag-active" : ""}`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => {
          if (pendingSpecs.length === 0 && fileInputRef.current) fileInputRef.current.click();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) addPendingSpecs(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        {pendingSpecs.length === 0 ? (
          <>
            <Icon name="cloud_upload" size={48} className="upload-icon" />
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>
              {t("backgrounds.dropHint")}
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
              {t("backgrounds.formatsHint")}
            </p>
          </>
        ) : (
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "560px", textAlign: "left" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 800, marginBottom: "12px", color: "var(--accent-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "8px" }}>
              {pendingSpecs.length} fichier{pendingSpecs.length > 1 ? "s" : ""} sélectionné{pendingSpecs.length > 1 ? "s" : ""}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "320px", overflowY: "auto", paddingRight: "4px" }}>
              {pendingSpecs.map((spec) => (
                <div key={spec.key} style={{ background: "var(--bg-surface-hover)", borderRadius: "8px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={spec.file?.name}>
                      {spec.file?.name} ({((spec.file?.size ?? 0) / (1024 * 1024)).toFixed(1)} Mo)
                    </span>
                    <button onClick={() => removePendingSpec(spec.key)} className="olc-press" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, display: "flex" }}>
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                  <input
                    type="text"
                    className="form-control"
                    placeholder={t("backgrounds.nameLabel")}
                    value={spec.title}
                    onChange={(e) => updatePendingSpec(spec.key, { title: e.target.value })}
                    style={{ padding: "6px 10px", fontSize: "0.85rem" }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "12px", marginTop: "14px" }}>
              <button type="button" className="btn btn-primary" onClick={submitPendingUploads} style={{ flex: 1, height: "44px" }}>
                {t("backgrounds.startImport")} ({pendingSpecs.length})
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setPendingSpecs([])} style={{ height: "44px" }}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} style={{ height: "44px", whiteSpace: "nowrap" }}>
                + Ajouter
              </button>
            </div>
          </div>
        )}
      </div>

      {state.state === "background" && (
        <div className="interrupted-block" style={{ borderColor: "color-mix(in srgb, var(--accent-success) 35%, transparent)" }}>
          <div className="interrupted-text">
            <span className="interrupted-label" style={{ color: "var(--accent-success)" }}>{t("backgrounds.onScreenNow")}</span>
            <span className="interrupted-title">{state.current_background?.title}</span>
          </div>
          <button className="btn btn-secondary" onClick={() => sendCommand("stop")}>
            {t("backgrounds.stop")}
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          {t("backgrounds.loadingBackgrounds")}
        </div>
      ) : backgrounds.length === 0 ? (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{t("backgrounds.noBackgroundsTitle")}</p>
          <p style={{ fontSize: "0.85rem", margin: "4px 0 0" }}>{t("backgrounds.noBackgroundsHint")}</p>
        </div>
      ) : (
        <div className="videos-grid">
          {backgrounds.map((bg) => (
            <BackgroundCard
              key={bg.id}
              bg={bg}
              isActive={state.state === "background" && state.current_background?.id === bg.id}
              onLaunch={() => handleLaunch(bg)}
              onDelete={() => setToDelete(bg)}
            />
          ))}
        </div>
      )}

      {toDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{t("backgrounds.deleteBackgroundTitle")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              {t("backgrounds.deleteBackgroundConfirmBefore")}{" "}
              <strong style={{ color: "var(--text-main)" }}>{toDelete.title}</strong>{t("backgrounds.deleteBackgroundConfirmAfter")}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setToDelete(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={confirmDelete}>
                {t("backgrounds.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
