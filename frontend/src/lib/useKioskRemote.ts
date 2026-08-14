"use client";

import { useEffect, useRef } from "react";

/**
 * Support des TÉLÉCOMMANDES à dongle USB (présentateur / média / "air remote")
 * sur les écrans kiosk `/cinema` et `/radio` — PAS l'admin (réf. demande).
 *
 * Ces télécommandes se présentent comme un clavier HID standard : elles
 * émettent des touches (flèches, Entrée, Échap, Espace, Page↑/↓) et souvent des
 * touches MÉDIA (Play/Pause, piste suivante/précédente, volume). Chromium en
 * kiosk les reçoit comme de simples `keydown` — aucun pilote ni code matériel
 * nécessaire. Ce hook traduit ces touches en actions sémantiques ; chaque page
 * fournit les gestes utiles à son état courant (grille vs lecture, etc.).
 *
 * `getHandlers` est relu à CHAQUE touche (via ref) pour toujours refléter l'état
 * courant sans réattacher l'écouteur.
 */
export interface RemoteHandlers {
  onLeft?: () => void;
  onRight?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  /** OK / sélection (Entrée). */
  onEnter?: () => void;
  /** Retour (Échap / Backspace / touche retour). */
  onBack?: () => void;
  /** Espace ou touche média Play/Pause. */
  onPlayPause?: () => void;
  /** Piste/élément suivant (média Next / Page↓). */
  onNext?: () => void;
  /** Piste/élément précédent (média Prev / Page↑). */
  onPrev?: () => void;
  onVolumeUp?: () => void;
  onVolumeDown?: () => void;
  onMute?: () => void;
}

export function useKioskRemote(getHandlers: () => RemoteHandlers, enabled = true) {
  const handlersRef = useRef(getHandlers);
  handlersRef.current = getHandlers;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Ne jamais détourner les touches quand l'utilisateur tape dans un champ.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const h = handlersRef.current();
      let action: (() => void) | undefined;
      switch (e.key) {
        case "ArrowLeft": action = h.onLeft; break;
        case "ArrowRight": action = h.onRight; break;
        case "ArrowUp": action = h.onUp; break;
        case "ArrowDown": action = h.onDown; break;
        case "Enter": action = h.onEnter; break;
        case "Escape":
        case "Backspace":
        case "BrowserBack":
        case "GoBack": action = h.onBack; break;
        case " ":
        case "Spacebar": action = h.onPlayPause ?? h.onEnter; break;
        case "MediaPlayPause":
        case "MediaPlay":
        case "MediaPause": action = h.onPlayPause; break;
        case "MediaTrackNext": action = h.onNext; break;
        case "MediaTrackPrevious": action = h.onPrev; break;
        case "PageDown": action = h.onNext ?? h.onDown; break;
        case "PageUp": action = h.onPrev ?? h.onUp; break;
        case "MediaStop": action = h.onBack; break;
        case "AudioVolumeUp": action = h.onVolumeUp; break;
        case "AudioVolumeDown": action = h.onVolumeDown; break;
        case "AudioVolumeMute": action = h.onMute; break;
        default: return;
      }
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Classe posée par la télécommande sur l'élément « sélectionné ». On la gère
 *  en JS (plutôt que le pseudo `:focus`) car un kiosk n'a pas toujours le focus
 *  fenêtre OS — auquel cas `:focus` ne matcherait pas et le repère visuel
 *  disparaîtrait. Le CSS stylise cette classe (halo). */
const REMOTE_FOCUS_CLASS = "kiosk-remote-focus";

/**
 * Déplace la sélection télécommande entre des boutons (cartes de cours), dans
 * l'ordre du DOM (lecture visuelle : rangées de haut en bas, cartes de gauche à
 * droite). Pose la classe de repère sur la cible et l'ôte des autres, place
 * aussi le focus natif (pour l'accessibilité) et amène la carte à l'écran.
 * Robuste quelle que soit la mise en page (rangées + grille complète).
 */
export function moveDomFocus(selector: string, direction: 1 | -1): void {
  if (typeof document === "undefined") return;
  const items = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  let at = items.findIndex((el) => el.classList.contains(REMOTE_FOCUS_CLASS));
  if (at < 0 && active) at = items.indexOf(active);
  const next = at < 0 ? (direction === 1 ? 0 : items.length - 1) : (at + direction + items.length) % items.length;
  const el = items[next];
  for (const it of items) it.classList.toggle(REMOTE_FOCUS_CLASS, it === el);
  el.focus();
  el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

/** Active (clique) l'élément sélectionné par la télécommande, ou le focalisé,
 *  ou le premier à défaut. */
export function activateDomFocus(selector: string): void {
  if (typeof document === "undefined") return;
  const items = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  const marked = items.find((el) => el.classList.contains(REMOTE_FOCUS_CLASS));
  const active = document.activeElement as HTMLElement | null;
  (marked ?? (active && items.includes(active) ? active : items[0])).click();
}
