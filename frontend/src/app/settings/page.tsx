"use client";

import React, { useEffect, useState } from "react";
import { useAppSettings, type Theme } from "@/lib/AppSettingsContext";
import type { Language } from "@/lib/i18n";
import SystemStatus from "@/components/SystemStatus";
import Icon from "@/components/Icon";

interface SettingsData {
  wait_time_between_courses: number;
  volume_default: number;
  audio_chain_timer_seconds: number;
  radio_announcement_fade_ms: number;
  paths: Record<string, string>;
}

interface StorageData {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_percent: number;
  app_bytes: number;
  path: string;
}

interface SystemUsageData {
  cpu_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_percent: number;
}

/** Jauge circulaire (réf. mission "supervision cpu/ram en plus du stockage,
 * via des camemberts") : même technique conic-gradient déjà utilisée pour
 * l'anneau de progression "à suivre" de l'écran cinéma (cinema/page.tsx) —
 * aucune dépendance de graphique supplémentaire. */
function UsageGauge({ label, percent, detail, size = 96 }: { label: string; percent: number; detail: string; size?: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const color = clamped >= 90 ? "var(--accent-error)" : clamped >= 75 ? "#f59e0b" : "var(--accent-primary)";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", flex: "1 1 140px", minWidth: "140px" }}>
      <div
        style={{
          position: "relative", width: size, height: size, borderRadius: "50%",
          background: `conic-gradient(${color} ${clamped * 3.6}deg, var(--bg-surface-hover) 0deg)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.6s ease",
        }}
      >
        <div style={{
          width: size - 18, height: size - 18, borderRadius: "50%", background: "var(--bg-surface)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ fontSize: "1.1rem", fontWeight: 800, color: "var(--text-main)", fontVariantNumeric: "tabular-nums" }}>
            {clamped.toFixed(0)}%
          </span>
        </div>
      </div>
      <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main)" }}>{label}</span>
      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "center" }}>{detail}</span>
    </div>
  );
}

/** Octets -> unité lisible (Go/Mo…), base 1024. */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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
  { value: "beige", labelKey: "settingsPage.themeBeige", colors: ["#ede8d0", "#c9bfa0", "#6b5751", "#372528"] },
  { value: "lavande", labelKey: "settingsPage.themeLavande", colors: ["#d3d3ff", "#bcbcf0", "#a47dab", "#2c2140"] },
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

// Phrase à recopier pour armer la désinstallation (comparée sans casse/accent).
const UNINSTALL_PHRASE = "DÉSINSTALLER";
const normalizePhrase = (s: string) => s.trim().toUpperCase().replace(/É/g, "E");

export default function SettingsPage() {
  const { theme, language, setTheme, setLanguage, t } = useAppSettings();
  const [data, setData] = useState<SettingsData | null>(null);
  const [storage, setStorage] = useState<StorageData | null>(null);
  const [system, setSystem] = useState<SystemUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showUninstall, setShowUninstall] = useState(false);
  const [uninstallConfirm, setUninstallConfirm] = useState("");
  const [uninstalling, setUninstalling] = useState(false);

  const showToast = (message: string, type: ToastState["type"] = "success") => setToast({ message, type });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    fetch(getApiUrl("/settings"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchStorage = () => {
      fetch(getApiUrl("/settings/storage"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => {
          if (!cancelled) setStorage(d);
        })
        .catch(() => {
          if (!cancelled) setStorage(null);
        });
    };
    fetchStorage();
    const id = setInterval(fetchStorage, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchSystem = () => {
      fetch(getApiUrl("/settings/system"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => {
          if (!cancelled) setSystem(d);
        })
        .catch(() => {
          if (!cancelled) setSystem(null);
        });
    };
    fetchSystem();
    // Intervalle plus court que le stockage (30s) : le CPU/RAM évoluent vite,
    // un affichage "en direct" a besoin d'un rafraîchissement fréquent.
    const id = setInterval(fetchSystem, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
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
          radio_announcement_fade_ms: data.radio_announcement_fade_ms,
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

  const handleUninstall = async () => {
    setUninstalling(true);
    try {
      const res = await fetch(getApiUrl("/settings/system/uninstall"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: uninstallConfirm }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(payload.message || t("settingsPage.uninstallStarted"), "warning");
      } else {
        showToast(payload.detail || t("settingsPage.uninstallError"), "error");
      }
    } catch {
      showToast(t("common.networkError"), "error");
    } finally {
      setUninstalling(false);
      setShowUninstall(false);
      setUninstallConfirm("");
    }
  };

  const uninstallReady = normalizePhrase(uninstallConfirm) === "DESINSTALLER";

  if (loading) {
    return <div className="live-empty">{t("common.loading")}</div>;
  }
  if (!data) {
    return <div className="live-empty">{t("settingsPage.loadError")}</div>;
  }

  return (
    <div className="settings-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      )}

      <div className="settings-head">
        <h1 className="settings-title">{t("header.settingsTitle")}</h1>
        <p className="settings-subtitle">{t("settingsPage.subtitle")}</p>
      </div>

      {/* ---- Apparence : thèmes + langue ---- */}
      <section className="live-block">
        <h3><Icon name="palette" size={18} /> {t("settingsPage.appearanceSection")}</h3>
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
          <p className="settings-hint">{t("settingsPage.themeHint")}</p>
        </div>

        <div className="form-group" style={{ maxWidth: "320px" }}>
          <label className="form-label">{t("settingsPage.languageLabel")}</label>
          <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
            <option value="fr">{t("settingsPage.languageFr")}</option>
            <option value="en">{t("settingsPage.languageEn")}</option>
          </select>
          <p className="settings-hint">{t("settingsPage.languageHint")}</p>
        </div>
      </section>

      {/* ---- Lecture ---- */}
      <form className="live-block" onSubmit={handleSave}>
        <h3><Icon name="play_circle" size={18} /> {t("settingsPage.playbackSection")}</h3>
        <div className="settings-fields">
          <div className="form-group">
            <label className="form-label">{t("settingsPage.waitTimeLabel")}</label>
            <input type="number" min={0} className="form-control" value={data.wait_time_between_courses}
              onChange={(e) => setData({ ...data, wait_time_between_courses: Number(e.target.value) })} />
          </div>
          <div className="form-group">
            <label className="form-label">{t("settingsPage.volumeLabel")}</label>
            <input type="number" min={0} max={100} className="form-control" value={data.volume_default}
              onChange={(e) => setData({ ...data, volume_default: Number(e.target.value) })} />
          </div>
          <div className="form-group">
            <label className="form-label">{t("settingsPage.chainTimerLabel")}</label>
            <input type="number" min={1} className="form-control" value={data.audio_chain_timer_seconds}
              onChange={(e) => setData({ ...data, audio_chain_timer_seconds: Number(e.target.value) })} />
          </div>
          <div className="form-group">
            <label className="form-label">{t("settingsPage.announcementFadeLabel")}</label>
            <input type="number" min={0} className="form-control" value={data.radio_announcement_fade_ms}
              onChange={(e) => setData({ ...data, radio_announcement_fade_ms: Number(e.target.value) })} />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" style={{ height: "48px", alignSelf: "flex-start", marginTop: "4px" }} disabled={saving}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </form>

      {/* ---- Supervision (stockage, CPU, RAM) ---- */}
      <section className="live-block">
        <h3><Icon name="monitor_heart" size={18} /> {t("settingsPage.monitoringSection")}</h3>
        {storage || system ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "20px", justifyContent: "space-around" }}>
              {storage && (
                <UsageGauge
                  label={t("settingsPage.storageSection")}
                  percent={storage.used_percent}
                  detail={t("settingsPage.storageFreeOfTotal", { free: formatBytes(storage.free_bytes), total: formatBytes(storage.total_bytes) })}
                />
              )}
              {system && (
                <UsageGauge label={t("settingsPage.cpuLabel")} percent={system.cpu_percent} detail={t("settingsPage.cpuHint")} />
              )}
              {system && (
                <UsageGauge
                  label={t("settingsPage.ramLabel")}
                  percent={system.memory_percent}
                  detail={t("settingsPage.ramDetail", { used: formatBytes(system.memory_used_bytes), total: formatBytes(system.memory_total_bytes) })}
                />
              )}
            </div>
            {storage && (
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{t("settingsPage.storageApp", { app: formatBytes(storage.app_bytes) })}</span>
            )}
            <p className="settings-hint">{t("settingsPage.storageHint")}</p>
          </div>
        ) : (
          <p className="live-empty">{t("settingsPage.storageError")}</p>
        )}
      </section>

      {/* ---- État système (déplacé depuis l'en-tête) ---- */}
      <section className="live-block">
        <h3><Icon name="monitor_heart" size={18} /> {t("settingsPage.statusSection")}</h3>
        <SystemStatus />
      </section>

      {/* ---- Maintenance : resync ---- */}
      <section className="live-block">
        <h3><Icon name="sync" size={18} /> {t("settingsPage.syncSection")}</h3>
        <p className="settings-hint" style={{ marginTop: 0 }}>{t("settingsPage.syncHint")}</p>
        <button type="button" className="btn btn-secondary" style={{ height: "44px", alignSelf: "flex-start" }} onClick={() => setShowResetConfirm(true)}>
          <Icon name="sync" size={16} /> {t("settingsPage.syncResetButton")}
        </button>
      </section>

      {/* ---- Zone de danger : désinstallation ---- */}
      <section className="live-block settings-danger">
        <h3><Icon name="warning" size={18} /> {t("settingsPage.dangerSection")}</h3>
        <p className="settings-hint" style={{ marginTop: 0 }}>{t("settingsPage.uninstallHint")}</p>
        <button type="button" className="btn btn-danger" style={{ height: "44px", alignSelf: "flex-start" }} onClick={() => setShowUninstall(true)}>
          <Icon name="delete_forever" size={16} /> {t("settingsPage.uninstallButton")}
        </button>
      </section>

      {/* ---- Documentation : chemins (lecture seule) ---- */}
      <section className="live-block">
        <h3><Icon name="description" size={18} /> {t("settingsPage.docSection")}</h3>
        <p className="settings-hint" style={{ marginTop: 0 }}>{t("settingsPage.docHint")}</p>
        <div className="settings-paths">
          {Object.entries(data.paths).map(([key, value]) => (
            <div key={key} className="settings-path-row">
              <span className="settings-path-key">{t(PATH_LABEL_KEYS[key] || key)}</span>
              <span className="settings-path-val">{value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Modale : resync ---- */}
      {showResetConfirm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--text-main)" }}>{t("settingsPage.syncResetButton")}</h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>{t("settingsPage.syncResetConfirm")}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowResetConfirm(false)} disabled={resetting}>{t("common.cancel")}</button>
              <button type="button" className="btn btn-primary" style={{ backgroundColor: "var(--accent-error)" }} onClick={handleFullReset} disabled={resetting}>
                {resetting ? t("settingsPage.syncResetInProgress") : t("settingsPage.syncResetButton")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Modale : désinstallation (recopie de phrase obligatoire) ---- */}
      {showUninstall && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0, color: "var(--accent-error)" }}>
              <Icon name="delete_forever" size={20} /> {t("settingsPage.uninstallButton")}
            </h3>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>{t("settingsPage.uninstallConfirmText")}</p>
            <ul className="settings-uninstall-list">
              <li>{t("settingsPage.uninstallItemServices")}</li>
              <li>{t("settingsPage.uninstallItemApp")}</li>
              <li>{t("settingsPage.uninstallItemData")}</li>
              <li>{t("settingsPage.uninstallItemKeepPackages")}</li>
            </ul>
            <label className="form-label" style={{ marginBottom: "4px" }}>
              {t("settingsPage.uninstallTypeLabel", { phrase: UNINSTALL_PHRASE })}
            </label>
            <input
              type="text"
              className="form-control"
              value={uninstallConfirm}
              onChange={(e) => setUninstallConfirm(e.target.value)}
              placeholder={UNINSTALL_PHRASE}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setShowUninstall(false); setUninstallConfirm(""); }} disabled={uninstalling}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" onClick={handleUninstall} disabled={!uninstallReady || uninstalling}>
                {uninstalling ? t("settingsPage.uninstallInProgress") : t("settingsPage.uninstallConfirmButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
