"use client";

import React, { useEffect, useState } from "react";
import { useAppSettings, type Theme } from "@/lib/AppSettingsContext";
import type { Language } from "@/lib/i18n";

interface SettingsData {
  wait_time_between_courses: number;
  volume_default: number;
  audio_chain_timer_seconds: number;
  paths: Record<string, string>;
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

// Aperçu à 4 couleurs par thème (réf. mission "thèmes cinéma") : mêmes
// valeurs que les blocs :root[data-theme="..."] de globals.css, pour que la
// vignette reflète fidèlement le thème réellement appliqué.
const THEME_SWATCHES: { value: Theme; labelKey: string; colors: [string, string, string, string] }[] = [
  { value: "les-mills-sombre", labelKey: "settingsPage.themeDark", colors: ["#0a0a0a", "#1e1e20", "#e4002b", "#ffffff"] },
  { value: "clair", labelKey: "settingsPage.themeLight", colors: ["#f4f4f5", "#ffffff", "#e4002b", "#16161a"] },
  { value: "lune", labelKey: "settingsPage.themeLune", colors: ["#cccccc", "#a3a3cc", "#5c5c99", "#292966"] },
  { value: "menthe", labelKey: "settingsPage.themeMenthe", colors: ["#98fbcb", "#bfffed", "#7fcfa8", "#558b71"] },
  { value: "automne", labelKey: "settingsPage.themeAutomne", colors: ["#ffb343", "#db9a39", "#b37e2e", "#614419"] },
  { value: "hiver", labelKey: "settingsPage.themeHiver", colors: ["#b8e3e9", "#93b1b5", "#4f7c82", "#0b2e33"] },
  { value: "chili", labelKey: "settingsPage.themeChili", colors: ["#cd1c18", "#ffa896", "#9b1313", "#38000a"] },
  { value: "ciel", labelKey: "settingsPage.themeCiel", colors: ["#b3ebf2", "#77cbda", "#4a9dae", "#2e6c7b"] },
  { value: "orchidee", labelKey: "settingsPage.themeOrchidee", colors: ["#ed80e9", "#c96dc6", "#784176", "#4f2b4e"] },
  { value: "taupe", labelKey: "settingsPage.themeTaupe", colors: ["#fcd3ae", "#ab8f76", "#826d5a", "#54463a"] },
  { value: "charbon", labelKey: "settingsPage.themeCharbon", colors: ["#f2f2f2", "#a1a1a1", "#4a4a4a", "#1a1a1a"] },
];

const PATH_LABEL_KEYS: Record<string, string> = {
  database_url: "settingsPage.paths.database_url",
  media_dir: "settingsPage.paths.media_dir",
  watch_dir: "settingsPage.paths.watch_dir",
  thumbnails_dir: "settingsPage.paths.thumbnails_dir",
  backgrounds_dir: "settingsPage.paths.backgrounds_dir",
  backgrounds_watch_dir: "settingsPage.paths.backgrounds_watch_dir",
  audio_dir: "settingsPage.paths.audio_dir",
  audio_watch_dir: "settingsPage.paths.audio_watch_dir",
};

export default function SettingsPage() {
  const { theme, language, setTheme, setLanguage, t } = useAppSettings();
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

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
          wait_time_between_courses: data.wait_time_between_courses,
          volume_default: data.volume_default,
          audio_chain_timer_seconds: data.audio_chain_timer_seconds,
        }),
      });
      if (res.ok) {
        setData(await res.json());
        showToast(t("settingsPage.savedToast"));
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || t("settingsPage.saveError"), "error");
      }
    } catch {
      showToast(t("common.networkError"), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleFullReset = async () => {
    setResetting(true);
    try {
      const res = await fetch(getApiUrl("/settings/system/reset"), { method: "POST" });
      if (res.ok) {
        showToast(t("settingsPage.syncResetSuccess"));
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || t("settingsPage.syncResetError"), "error");
      }
    } catch {
      showToast(t("common.networkError"), "error");
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
  };

  if (loading) {
    return <div className="live-empty">{t("common.loading")}</div>;
  }

  if (!data) {
    return <div className="live-empty">{t("settingsPage.loadError")}</div>;
  }

  return (
    <div className="dashboard-container" style={{ maxWidth: "640px" }}>
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      )}

      <form className="live-block" onSubmit={handleSave} style={{ gap: "20px" }}>
        <h3>{t("settingsPage.playbackSection")}</h3>

        <div className="form-group">
          <label className="form-label">{t("settingsPage.themeLabel")}</label>
          <div className="theme-picker-grid">
            {THEME_SWATCHES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`theme-picker-card ${theme === option.value ? "active" : ""}`}
                onClick={() => setTheme(option.value)}
              >
                <div className="theme-picker-swatch">
                  {option.colors.map((c, i) => (
                    <span key={i} style={{ background: c }} />
                  ))}
                </div>
                <span className="theme-picker-name">{t(option.labelKey)}</span>
              </button>
            ))}
          </div>
          <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", margin: "4px 0 0" }}>
            {t("settingsPage.themeHint")}
          </p>
        </div>

        <div className="form-group">
          <label className="form-label">{t("settingsPage.languageLabel")}</label>
          <select
            className="form-control"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            <option value="fr">{t("settingsPage.languageFr")}</option>
            <option value="en">{t("settingsPage.languageEn")}</option>
          </select>
          <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", margin: "4px 0 0" }}>
            {t("settingsPage.languageHint")}
          </p>
        </div>

        <div className="form-group">
          <label className="form-label">{t("settingsPage.waitTimeLabel")}</label>
          <input
            type="number"
            min={0}
            className="form-control"
            value={data.wait_time_between_courses}
            onChange={(e) => setData({ ...data, wait_time_between_courses: Number(e.target.value) })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t("settingsPage.volumeLabel")}</label>
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
          <label className="form-label">{t("settingsPage.chainTimerLabel")}</label>
          <input
            type="number"
            min={1}
            className="form-control"
            value={data.audio_chain_timer_seconds}
            onChange={(e) => setData({ ...data, audio_chain_timer_seconds: Number(e.target.value) })}
          />
        </div>

        <button type="submit" className="btn btn-primary" style={{ height: "48px" }} disabled={saving}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </form>

      <div className="live-block">
        <h3>{t("settingsPage.syncSection")}</h3>
        <p className="live-empty">{t("settingsPage.syncHint")}</p>
        <button
          type="button"
          className="btn btn-primary"
          style={{ height: "48px", backgroundColor: "var(--accent-error)" }}
          onClick={() => setShowResetConfirm(true)}
        >
          {t("settingsPage.syncResetButton")}
        </button>
      </div>

      {showResetConfirm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--text-main)" }}>
              {t("settingsPage.syncResetButton")}
            </h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              {t("settingsPage.syncResetConfirm")}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ backgroundColor: "var(--accent-error)" }}
                onClick={handleFullReset}
                disabled={resetting}
              >
                {resetting ? t("settingsPage.syncResetInProgress") : t("settingsPage.syncResetButton")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="live-block">
        <h3>{t("settingsPage.pathsSection")}</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Object.entries(data.paths).map(([key, value]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: "16px", fontSize: "0.85rem" }}>
              <span style={{ color: "var(--text-muted)" }}>{t(PATH_LABEL_KEYS[key] || key)}</span>
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
