"use client";

/**
 * UploadManager — Gestionnaire global des imports (vidéos, fonds animés,
 * cours audio) — réf. correctif P3, étendu réf. mission "queue en direct des
 * importations + import parallèle".
 *
 * Problème résolu (P3) : dans l'implémentation précédente, le XHR était
 * instancié à l'intérieur du composant LibraryPage. Quand Next.js démontait
 * ce composant lors d'une navigation, le XHR était GC'd et l'upload était
 * annulé.
 *
 * Solution : ce Context React vit dans layout.tsx (niveau racine de l'app).
 * Les XHR sont référencés dans ce Context → ils survivent aux navigations.
 * Un panneau flottant (bas-droit) affiche la progression en permanence, pour
 * les 3 types d'import confondus.
 *
 * Deux phases bien distinctes par tâche (réf. mission "vitesse
 * d'importation") :
 * 1. "uploading" — transfert réseau du fichier, suivi par XHR (progress 0-100).
 *    Jusqu'à MAX_CONCURRENT_UPLOADS transferts en parallèle : aucune raison
 *    de les sérialiser, ce n'est que de la bande passante.
 * 2. "processing" — le serveur a accepté le fichier (HTTP 202 + job_id) et
 *    traite l'import en arrière-plan (analyse ffprobe, réencodage ffmpeg
 *    éventuel, miniature, écriture en base). Suivi par polling de
 *    `GET /api/import-jobs`, PAS par XHR (la requête HTTP d'upload, elle,
 *    est déjà terminée). Le réencodage ffmpeg lui-même reste sérialisé
 *    côté serveur (verrou global, cf. app/utils/video_utils.py) — c'est
 *    voulu, pour ne pas reproduire le bug déjà corrigé "l'importation des
 *    fonds animés bloque et ne termine jamais" (CPU limité du Wyse 5070) —
 *    mais cette sérialisation n'empêche plus de LANCER d'autres imports
 *    pendant ce temps ni d'en suivre l'avancement réel (étape + position
 *    dans la file) plutôt qu'un indicateur muet.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Icon from "@/components/Icon";

const MAX_CONCURRENT_UPLOADS = 3;
const JOB_POLL_INTERVAL_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadKind = "video" | "background" | "audio_files" | "audio_zip" | "radio_files" | "radio_zip";

export interface PendingUploadSpec {
  kind: UploadKind;
  /** Fichier unique — vidéo, fond animé, ou archive ZIP (cours audio / radio). */
  file?: File;
  /** Fichiers multiples — pistes MP3 d'un cours audio ("audio_files") ou
   *  morceaux de la bibliothèque radio ("radio_files"). */
  files?: File[];
  title: string;
  program?: string | null;
  release?: string | null;
}

export type UploadTaskStatus = "pending" | "uploading" | "processing" | "done" | "error";

export interface UploadTask extends PendingUploadSpec {
  id: string;
  status: UploadTaskStatus;
  /** Progression du TRANSFERT réseau (0-100), pas de l'import serveur. */
  progress: number;
  /** Identifiant de la tâche d'import côté serveur (app.utils.import_jobs),
   *  connu une fois le transfert terminé (réponse 202). */
  jobId?: string;
  /** Étape d'import serveur courante (queued/probing/normalizing/...), mise
   *  à jour par polling tant que status === "processing". */
  stage?: string;
  stageLabel?: string;
  /** Position estimée dans la file d'attente (0 = prochain traité). */
  queuePosition?: number | null;
  /** Identifiant de l'élément créé (vidéo/fond/cours) une fois status === "done". */
  resultId?: number | null;
  error?: string;
  xhr?: XMLHttpRequest;
}

interface UploadManagerContextValue {
  uploads: UploadTask[];
  /** Ajoute une liste de fichiers à la file d'attente et démarre le 1er si idle. */
  addUploads: (specs: PendingUploadSpec[]) => void;
  /** Annule un upload en cours ou supprime un upload en attente. */
  cancelUpload: (id: string) => void;
  /** Supprime les uploads terminés (done + error) de l'affichage. */
  clearCompleted: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const UploadManagerContext = createContext<UploadManagerContextValue | null>(null);

function getApiUrl(path: string) {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
  }
  return `/api${path}`;
}

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const UPLOAD_ENDPOINTS: Record<UploadKind, string> = {
  video: "/videos/upload",
  background: "/backgrounds/upload",
  audio_files: "/audio/upload",
  audio_zip: "/audio/upload-zip",
  radio_files: "/radio/tracks/upload",
  radio_zip: "/radio/tracks/upload-zip",
};

const STAGE_ICONS: Record<string, string> = {
  queued: "hourglass_empty",
  probing: "search",
  normalizing: "autorenew",
  copying: "drive_file_move",
  thumbnail: "image",
  extracting: "folder_zip",
  saving: "save",
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function UploadManagerProvider({ children }: { children: React.ReactNode }) {
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  // Ref pour accéder à la liste sans dépendre du closure de state (nécessaire
  // dans les callbacks XHR/polling qui capturent la valeur au moment de la création).
  const uploadsRef = useRef<UploadTask[]>([]);

  const updateTask = useCallback((id: string, patch: Partial<UploadTask>) => {
    setUploads((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      uploadsRef.current = next;
      return next;
    });
  }, []);

  const buildFormData = (task: UploadTask): FormData => {
    const formData = new FormData();
    if (task.kind === "audio_files" || task.kind === "radio_files") {
      (task.files ?? []).forEach((f) => formData.append("files", f));
    } else if (task.file) {
      formData.append("file", task.file);
    }
    // Les endpoints radio n'attendent pas de `title` (métadonnées lues des tags
    // ID3), mais l'ajouter est inoffensif (FastAPI ignore les champs non déclarés).
    formData.append("title", task.title);
    if (task.kind === "video" || task.kind === "audio_files" || task.kind === "audio_zip") {
      if (task.program) formData.append("program", task.program);
      if (task.release) formData.append("release", task.release);
    }
    return formData;
  };

  /** Lance l'upload XHR d'une tâche. Appelé par startNext(). Libère son
   * créneau réseau (onDone) dès que le TRANSFERT est fini (réponse 202 avec
   * job_id) — le traitement serveur qui suit ne bloque plus la file
   * d'upload, il est suivi séparément par pollJobs(). */
  const runUpload = useCallback(
    (task: UploadTask, onDone: () => void) => {
      const xhr = new XMLHttpRequest();
      updateTask(task.id, { status: "uploading", xhr });

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          updateTask(task.id, { progress: Math.round((e.loaded / e.total) * 100) });
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText);
            updateTask(task.id, {
              status: "processing",
              progress: 100,
              jobId: body.job_id,
              stage: "queued",
              stageLabel: "En attente",
            });
          } catch {
            // Réponse inattendue (ancienne version du backend ?) : on
            // considère quand même le transfert réussi.
            updateTask(task.id, { status: "done", progress: 100 });
          }
        } else {
          let errMsg = "Erreur lors de l'upload";
          try {
            const body = JSON.parse(xhr.responseText);
            errMsg = body.detail || errMsg;
          } catch {
            // réponse non-JSON
          }
          updateTask(task.id, { status: "error", error: errMsg });
        }
        onDone();
      });

      xhr.addEventListener("error", () => {
        updateTask(task.id, { status: "error", error: "Erreur réseau" });
        onDone();
      });

      xhr.addEventListener("abort", () => {
        // L'upload a été annulé volontairement — on retire la tâche.
        setUploads((prev) => {
          const next = prev.filter((t) => t.id !== task.id);
          uploadsRef.current = next;
          return next;
        });
        onDone();
      });

      xhr.open("POST", getApiUrl(UPLOAD_ENDPOINTS[task.kind]));
      xhr.send(buildFormData(task));
    },
    [updateTask],
  );

  /**
   * Démarre autant d'uploads en attente que de créneaux réseau libres
   * jusqu'à MAX_CONCURRENT_UPLOADS (réf. audit plan-corrections-bugs, point
   * 5, et mission "import parallèle" : le créneau se libère dès la fin du
   * TRANSFERT, pas de l'import complet — voir runUpload). Appelé après
   * chaque fin de transfert (succès, erreur ou annulation) pour reprendre le
   * créneau libéré, et à l'ajout de nouveaux fichiers — y compris pendant
   * qu'un import précédent est encore en train d'être traité côté serveur.
   */
  const fillSlots = useCallback(() => {
    const activeCount = uploadsRef.current.filter((t) => t.status === "uploading").length;
    const slotsFree = MAX_CONCURRENT_UPLOADS - activeCount;
    if (slotsFree <= 0) return;
    const toStart = uploadsRef.current.filter((t) => t.status === "pending").slice(0, slotsFree);
    toStart.forEach((task) => runUpload(task, fillSlots));
  }, [runUpload]);

  const addUploads = useCallback(
    (specs: PendingUploadSpec[]) => {
      const newTasks: UploadTask[] = specs.map((spec) => ({
        ...spec,
        id: uuid(),
        status: "pending",
        progress: 0,
      }));

      setUploads((prev) => {
        const next = [...prev, ...newTasks];
        uploadsRef.current = next;
        return next;
      });

      // On utilise setTimeout(0) pour laisser le setState se propager d'abord.
      setTimeout(fillSlots, 0);
    },
    [fillSlots],
  );

  const cancelUpload = useCallback((id: string) => {
    const task = uploadsRef.current.find((t) => t.id === id);
    if (!task) return;
    if (task.status === "uploading" && task.xhr) {
      task.xhr.abort(); // déclenche l'événement "abort" → nettoyage automatique
    } else {
      // En attente, en traitement serveur, ou terminé : retirer directement
      // (le traitement serveur d'une tâche déjà transférée continue en tâche
      // de fond côté backend, cette annulation n'affecte que l'affichage).
      setUploads((prev) => {
        const next = prev.filter((t) => t.id !== id);
        uploadsRef.current = next;
        return next;
      });
    }
  }, []);

  const clearCompleted = useCallback(() => {
    setUploads((prev) => {
      const next = prev.filter((t) => t.status === "uploading" || t.status === "pending" || t.status === "processing");
      uploadsRef.current = next;
      return next;
    });
  }, []);

  // Polling des tâches d'import serveur en cours (réf. mission "voir en
  // direct les importations et l'estimation d'où elles en sont") : ces
  // tâches (réencodage compris) peuvent durer bien plus longtemps qu'un XHR
  // ne reste ouvert — un intervalle léger suffit, pas besoin d'un canal
  // WebSocket dédié pour une progression qui évolue à l'échelle de la seconde.
  useEffect(() => {
    const interval = setInterval(() => {
      const processing = uploadsRef.current.filter((t) => t.status === "processing" && t.jobId);
      if (processing.length === 0) return;
      fetch(getApiUrl("/import-jobs"), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : []))
        .then((jobs: Array<{ id: string; stage: string; stage_label: string; queue_position: number | null; error: string | null; result_id: number | null }>) => {
          const byId = new Map(jobs.map((j) => [j.id, j]));
          processing.forEach((task) => {
            const job = task.jobId ? byId.get(task.jobId) : undefined;
            if (!job) return;
            if (job.stage === "done") {
              updateTask(task.id, { status: "done", stage: job.stage, stageLabel: job.stage_label, resultId: job.result_id, queuePosition: null });
            } else if (job.stage === "error") {
              updateTask(task.id, { status: "error", stage: job.stage, stageLabel: job.stage_label, error: job.error || "Échec de l'import", queuePosition: null });
            } else {
              updateTask(task.id, { stage: job.stage, stageLabel: job.stage_label, queuePosition: job.queue_position ?? null });
            }
          });
        })
        .catch(() => {
          // Panne réseau/serveur passagère : on retentera au prochain tick,
          // pas la peine de faire échouer l'affichage pour un poll manqué.
        });
    }, JOB_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [updateTask]);

  return (
    <UploadManagerContext.Provider value={{ uploads, addUploads, cancelUpload, clearCompleted }}>
      {children}
      <UploadFloatingPanel />
    </UploadManagerContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useUploadManager(): UploadManagerContextValue {
  const ctx = useContext(UploadManagerContext);
  if (!ctx) throw new Error("useUploadManager must be used inside <UploadManagerProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Panneau flottant (bas-droit, persistant entre navigations)
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<UploadKind, string> = {
  video: "Cours",
  background: "Fond animé",
  audio_files: "Cours audio",
  audio_zip: "Cours audio",
  radio_files: "Musique radio",
  radio_zip: "Musique radio",
};

function UploadFloatingPanel() {
  const { uploads, cancelUpload, clearCompleted } = useContext(UploadManagerContext)!;
  const [minimized, setMinimized] = useState(false);

  const visible = uploads.length > 0;
  if (!visible) return null;

  const active = uploads.filter((u) => u.status === "uploading" || u.status === "pending" || u.status === "processing");
  const completed = uploads.filter((u) => u.status === "done" || u.status === "error");

  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: 9999,
        width: minimized ? "auto" : "360px",
        background: "var(--bg-surface-elevated)",
        border: "1px solid var(--border-color)",
        borderRadius: "12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        overflow: "hidden",
        fontFamily: "var(--font-body)",
        fontSize: "0.85rem",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "var(--bg-surface-hover)",
          borderBottom: minimized ? "none" : "1px solid var(--border-color)",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setMinimized((m) => !m)}
      >
        <span style={{ fontWeight: 700, color: "var(--text-main)", display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="upload" size={16} />
          {active.length > 0
            ? `${active.length} import${active.length > 1 ? "s" : ""} en cours`
            : `${completed.length} import${completed.length > 1 ? "s" : ""} terminé${completed.length > 1 ? "s" : ""}`}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: "0.75rem", display: "flex", alignItems: "center" }}>
          <Icon name={minimized ? "expand_less" : "expand_more"} size={16} />
        </span>
      </div>

      {/* Body */}
      {!minimized && (
        <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px", maxHeight: "320px", overflowY: "auto" }}>
          {uploads.map((task) => (
            <div key={task.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span
                  style={{
                    color: task.status === "error" ? "var(--accent-error)" : task.status === "done" ? "var(--accent-success)" : "var(--text-main)",
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "220px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                  title={task.title}
                >
                  {task.status === "done" && <Icon name="check" size={14} color="var(--accent-success)" />}
                  {task.status === "error" && <Icon name="close" size={14} color="var(--accent-error)" />}
                  {task.status === "pending" && <Icon name="hourglass_empty" size={14} />}
                  {task.status === "processing" && (
                    <Icon name={STAGE_ICONS[task.stage ?? ""] ?? "autorenew"} size={14} className="olc-spin" />
                  )}
                  {task.title}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  {task.status === "uploading" && (
                    <span style={{ color: "var(--text-muted)" }}>{task.progress}%</span>
                  )}
                  {(task.status === "uploading" || task.status === "pending" || task.status === "processing") && (
                    <button
                      onClick={() => cancelUpload(task.id)}
                      title="Retirer de la liste"
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        padding: "2px 4px",
                        fontSize: "0.9rem",
                        lineHeight: 1,
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
              </div>
              <span style={{ color: "var(--text-dim)", fontSize: "0.72rem" }}>
                {KIND_LABELS[task.kind]}
                {task.status === "processing" && (
                  <>
                    {" — "}
                    {task.stageLabel ?? "Traitement…"}
                    {typeof task.queuePosition === "number" && task.queuePosition > 0 &&
                      ` (${task.queuePosition} devant)`}
                  </>
                )}
              </span>
              {task.status === "uploading" && (
                <div style={{ height: "3px", background: "var(--border-color)", borderRadius: "2px" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${task.progress}%`,
                      background: "var(--accent-primary)",
                      borderRadius: "2px",
                      transition: "width 0.2s",
                    }}
                  />
                </div>
              )}
              {task.status === "processing" && (
                <div style={{ height: "3px", background: "var(--border-color)", borderRadius: "2px", overflow: "hidden" }}>
                  <div className="olc-indeterminate-bar" style={{ background: "var(--accent-primary)" }} />
                </div>
              )}
              {task.status === "error" && task.error && (
                <span style={{ color: "var(--accent-error)", fontSize: "0.78rem" }}>{task.error}</span>
              )}
            </div>
          ))}

          {completed.length > 0 && (
            <button
              onClick={clearCompleted}
              style={{
                marginTop: "4px",
                alignSelf: "flex-end",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: "0.78rem",
                padding: "4px 0",
              }}
            >
              Effacer les terminés
            </button>
          )}
        </div>
      )}
    </div>
  );
}
