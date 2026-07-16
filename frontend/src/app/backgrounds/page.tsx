"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";

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
    return `http://localhost:8000/api${path}`;
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
          <div style={{ position: "absolute", inset: 0, background: "#0c0c0e", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.2, width: "32px", height: "32px" }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
        {isActive && <span className="card-duration" style={{ background: "var(--accent-success)", left: 8, right: "auto" }}>À l&apos;écran</span>}
      </div>
      <div className="card-content">
        <h4 className="card-title" title={bg.title}>
          {bg.title}
        </h4>
        <div className="card-meta-row">
          <span className="release-badge">Boucle infinie</span>
          <button
            type="button"
            className="btn btn-danger"
            style={{ height: "32px", padding: "0 10px", fontSize: "0.75rem" }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            Supprimer
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BackgroundsPage() {
  const { state, sendCommand } = usePlaybackSocket();
  const [backgrounds, setBackgrounds] = useState<BackgroundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadProgress, setUploadProgress] = useState(-1);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      else showToast("Erreur lors de la récupération des fonds animés", "error");
    } catch {
      showToast("Impossible de se connecter au serveur", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement initial, même motif que les autres pages (library/playlists/schedule)
    fetchBackgrounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setupUpload = (file: File) => {
    setUploadFile(file);
    setUploadTitle(file.name.substring(0, file.name.lastIndexOf(".")) || file.name);
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
    if (e.dataTransfer.files?.[0]) setupUpload(e.dataTransfer.files[0]);
  };

  const cancelUpload = () => {
    setUploadFile(null);
    setUploadTitle("");
    setUploadProgress(-1);
  };

  const executeUpload = () => {
    if (!uploadFile) return;
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", uploadFile);
    if (uploadTitle) formData.append("title", uploadTitle);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        showToast("Fond animé importé avec succès !");
        fetchBackgrounds();
        cancelUpload();
      } else {
        let errMsg = "Erreur lors de l'importation";
        try {
          errMsg = JSON.parse(xhr.responseText).detail || errMsg;
        } catch {}
        showToast(errMsg, "error");
        setUploadProgress(-1);
      }
    });
    xhr.addEventListener("error", () => {
      showToast("Erreur réseau pendant l'upload", "error");
      setUploadProgress(-1);
    });
    xhr.open("POST", getApiUrl("/backgrounds/upload"));
    xhr.send(formData);
  };

  const handleLaunch = (bg: BackgroundItem) => {
    sendCommand("load_background", { background_id: bg.id });
    showToast(`Fond animé « ${bg.title} » lancé à l'écran`);
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      const res = await fetch(getApiUrl(`/backgrounds/${toDelete.id}`), { method: "DELETE" });
      if (res.ok) {
        showToast("Fond animé supprimé");
        setBackgrounds((prev) => prev.filter((b) => b.id !== toDelete.id));
      } else {
        showToast("Impossible de supprimer le fond animé", "error");
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

      <div
        className={`upload-zone ${dragActive ? "drag-active" : ""}`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => !uploadFile && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && setupUpload(e.target.files[0])}
        />
        {!uploadFile ? (
          <>
            <svg className="w-10 h-10 upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ width: "40px", height: "40px" }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "8px 0 4px" }}>
              Faites glisser une boucle d&apos;ambiance ici ou cliquez pour parcourir
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>
              Formats recommandés : MP4, WebM, MKV. Joué en boucle, sans son.
            </p>
          </>
        ) : (
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "500px", textAlign: "left" }}>
            <div className="form-group">
              <label className="form-label">Nom du fond animé</label>
              <input
                type="text"
                className="form-control"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                disabled={uploadProgress >= 0}
              />
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "12px 0" }}>
              Fichier : <span style={{ color: "var(--text-main)", fontWeight: 600 }}>{uploadFile.name}</span> (
              {(uploadFile.size / (1024 * 1024)).toFixed(1)} Mo)
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
              <div style={{ display: "flex", gap: "12px" }}>
                <button type="button" className="btn btn-primary" onClick={executeUpload} style={{ flex: 1, height: "48px" }}>
                  Lancer l&apos;importation
                </button>
                <button type="button" className="btn btn-secondary" onClick={cancelUpload} style={{ height: "48px" }}>
                  Annuler
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {state.state === "background" && (
        <div className="interrupted-block" style={{ borderColor: "rgba(48, 209, 88, 0.35)" }}>
          <div className="interrupted-text">
            <span className="interrupted-label" style={{ color: "var(--accent-success)" }}>À l&apos;écran en ce moment</span>
            <span className="interrupted-title">{state.current_background?.title}</span>
          </div>
          <button className="btn btn-secondary" onClick={() => sendCommand("stop")}>
            Arrêter
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          Chargement des fonds animés...
        </div>
      ) : backgrounds.length === 0 ? (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "300px", color: "var(--text-muted)" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Aucun fond animé importé</p>
          <p style={{ fontSize: "0.85rem", margin: "4px 0 0" }}>Importez une boucle d&apos;ambiance pour les cours donnés en physique</p>
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
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>Supprimer ce fond animé ?</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              Êtes-vous sûr de vouloir supprimer définitivement{" "}
              <strong style={{ color: "var(--text-main)" }}>{toDelete.title}</strong> ? Cette action est irréversible.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setToDelete(null)}>
                Annuler
              </button>
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
