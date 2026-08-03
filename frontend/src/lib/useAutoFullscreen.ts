"use client";

import { useEffect } from "react";

/**
 * Passage en plein écran navigateur au premier geste utilisateur (réf.
 * mission UI/UX — "plein écran de base sur mobile"). La Fullscreen API exige
 * un geste utilisateur pour s'activer ; impossible de la déclencher au
 * chargement de la page. Ce hook écoute donc le tout premier tap/clic et
 * tente `requestFullscreen()` à ce moment précis — échec silencieux si le
 * navigateur ne le permet pas (ex. iOS Safari ne l'autorise pas hors
 * élément <video>) : le mode "ajouter à l'écran d'accueil" (manifest.json,
 * display:"standalone") reste le chemin fiable pour un plein écran garanti.
 */
export function useAutoFullscreen(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const tryFullscreen = () => {
      const el = document.documentElement;
      const isFullscreen = document.fullscreenElement != null;
      if (!isFullscreen && el.requestFullscreen) {
        el.requestFullscreen().catch(() => {
          // Refusé par le navigateur (ex. iOS Safari) — sans effet, pas de retry.
        });
      }
      document.removeEventListener("touchend", tryFullscreen);
      document.removeEventListener("click", tryFullscreen);
    };

    document.addEventListener("touchend", tryFullscreen, { once: true });
    document.addEventListener("click", tryFullscreen, { once: true });

    return () => {
      document.removeEventListener("touchend", tryFullscreen);
      document.removeEventListener("click", tryFullscreen);
    };
  }, [enabled]);
}
