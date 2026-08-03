export type CanvasElementType =
  | "logo"
  | "text"
  | "clock"
  | "next_course"
  | "countdown"
  | "timer"
  | "background_image"
  | "background_video";

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null;
  content?: string | null;
  font_size?: number | null;
  visible: boolean;
  z_index: number;
}

export interface CanvasDefinition {
  elements: CanvasElement[];
}

export type CanvasLayoutType = "waiting" | "pause";

export interface CanvasLayout {
  id: number;
  type: CanvasLayoutType;
  name: string;
  definition: CanvasDefinition;
  active: boolean;
}

// Sentinelle reconnue par les éléments "text" pour se lier au titre du cours
// en pause plutôt qu'à un texte littéral (réf. utils/canvas_defaults.py côté backend).
export const CURRENT_TITLE_BINDING = "{{current_title}}";

export function getApiUrl(path: string): string {
  if (typeof window !== "undefined" && window.location.port === "3000") {
    return `http://localhost:8001/api${path}`;
  }
  return `/api${path}`;
}

// Les assets canvas (logos, images de fond) sont stockés avec leur chemin
// complet "/api/canvas_assets/xxx" en base — à réécrire vers le backend :8000
// en dev (le serveur Next dev sur :3000 ne sert pas /api).
export function resolveMediaUrl(path: string): string {
  if (typeof window !== "undefined" && window.location.port === "3000" && path.startsWith("/api/")) {
    return `http://localhost:8001${path}`;
  }
  return path;
}

export function formatClock(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function newElementDefaults(type: CanvasElementType): Omit<CanvasElement, "id"> {
  const base = { type, x: 30, y: 40, width: 40, height: 20, color: null, content: null, font_size: null, visible: true, z_index: 1 };
  switch (type) {
    case "logo":
      return { ...base, width: 20, height: 20, z_index: 5 };
    case "text":
      return { ...base, content: "Texte", width: 40, height: 10, font_size: 3, z_index: 5 };
    case "clock":
      return { ...base, width: 30, height: 12, font_size: 8, z_index: 5 };
    case "next_course":
      return { ...base, width: 50, height: 26, font_size: 2.2, z_index: 5 };
    case "countdown":
      return { ...base, width: 40, height: 20, font_size: 12, z_index: 5 };
    case "timer":
      return { ...base, width: 40, height: 20, font_size: 10, z_index: 5 };
    case "background_image":
      return { ...base, x: 0, y: 0, width: 100, height: 100, z_index: 0 };
    case "background_video":
      return { ...base, x: 0, y: 0, width: 100, height: 100, z_index: 0 };
    default:
      return base;
  }
}
