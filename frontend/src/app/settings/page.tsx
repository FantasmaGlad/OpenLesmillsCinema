"use client";

import React, { useEffect, useState } from "react";

interface SettingsData {
  countdown_seconds: number;
  wait_time_between_courses: number;
  volume_default: number;
  audio_chain_timer_seconds: number;
  theme: string;
  language: string;
  paths: Record<string, string>;
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

const PATH_LABELS: Record<string, string> = {
  database_url: "Base de données",
  media_dir: "Vidéos",
  watch_dir: "Dossier surveillé (vidéos)",
  thumbnails_dir: "Miniatures",
  backgrounds_dir: "Fonds animés",
  backgrounds_watch_dir: "Dossier surveillé (fonds animés)",
  audio_dir: "Cours audio",
  audio_watch_dir: "Dossier surveillé (cours audio)",
};

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    fetch(getApiUrl("/settings"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setSaving(true);
    try {
      const res = await fetch(getApiUrl("/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countdown_seconds: data.countdown_seconds,
          wait_time_between_courses: data.wait_time_between_courses,
          volume_default: data.volume_default,
          audio_chain_timer_seconds: data.audio_chain_timer_seconds,
          theme: data.theme,
          language: data.language,
        }),
      });
      if (res.ok) {
        setData(await res.json());
        showToast("Paramètres enregistrés — appliqués immédiatement");
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Erreur lors de la sauvegarde", "error");
      }
    } catch {
      showToast("Erreur réseau lors de la sauvegarde", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="live-empty">Chargement des paramètres...</div>;
  }

  if (!data) {
    return <div className="live-empty">Impossible de charger les paramètres.</div>;
  }

  return (
    <div className="dashboard-container" style={{ maxWidth: "640px" }}>
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      )}

      <form className="live-block" onSubmit={handleSave} style={{ gap: "20px" }}>
        <h3>Lecture & habillage</h3>

        <div className="form-group">
          <label className="form-label">Thème</label>
          <select className="form-control" value={data.theme} onChange={(e) => setData({ ...data, theme: e.target.value })}>
            <option value="les-mills-sombre">Les Mills sombre (défaut)</option>
            <option value="clair">Clair</option>
          </select>
          <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", margin: "4px 0 0" }}>
            Persisté ici ; l&apos;application visuelle multi-thème arrive au Lot 11.
          </p>
        </div>

        <div className="form-group">
          <label className="form-label">Langue</label>
          <select className="form-control" value={data.language} onChange={(e) => setData({ ...data, language: e.target.value })}>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
          <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", margin: "4px 0 0" }}>
            Persisté ici ; la traduction complète de l&apos;interface arrive au Lot 11.
          </p>
        </div>

        <div className="form-group">
          <label className="form-label">Durée du compte à rebours de lancement (secondes, 0 = désactivé)</label>
          <input
            type="number"
            min={0}
            max={10}
            className="form-control"
            value={data.countdown_seconds}
            onChange={(e) => setData({ ...data, countdown_seconds: Number(e.target.value) })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Durée d&apos;attente entre les cours d&apos;une playlist (secondes)</label>
          <input
            type="number"
            min={0}
            className="form-control"
            value={data.wait_time_between_courses}
            onChange={(e) => setData({ ...data, wait_time_between_courses: Number(e.target.value) })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Volume par défaut (%)</label>
          <input
            type="number"
            min={0}
            max={100}
            className="form-control"
            value={data.volume_default}
            onChange={(e) => setData({ ...data, volume_default: Number(e.target.value) })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Minuterie par défaut entre pistes en mode coach « auto + minuterie » (secondes)</label>
          <input
            type="number"
            min={1}
            className="form-control"
            value={data.audio_chain_timer_seconds}
            onChange={(e) => setData({ ...data, audio_chain_timer_seconds: Number(e.target.value) })}
          />
        </div>

        <button type="submit" className="btn btn-primary" style={{ height: "48px" }} disabled={saving}>
          {saving ? "Enregistrement..." : "Enregistrer"}
        </button>
      </form>

      <div className="live-block">
        <h3>Éditeur de canvas</h3>
        <p className="live-empty">
          L&apos;édition des compositions d&apos;attente et de pause arrive au Lot 12. La composition par défaut
          actuellement affichée sur l&apos;écran cinéma est fixe (Lot 4).
        </p>
      </div>

      <div className="live-block">
        <h3>Chemins (lecture seule)</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Object.entries(data.paths).map(([key, value]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: "16px", fontSize: "0.85rem" }}>
              <span style={{ color: "var(--text-muted)" }}>{PATH_LABELS[key] || key}</span>
              <span style={{ color: "var(--text-main)", fontFamily: "monospace", textAlign: "right", wordBreak: "break-all" }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
