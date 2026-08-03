"use client";

import { useEffect, useRef } from "react";

const CLICK_SOUND_SRC = "/sounds/clic.mp3";
// Éléments considérés "interactifs" pour le son de clic (réf. mission UI/UX) :
// tout le reste (clic dans le vide, sélection de texte) reste silencieux.
const INTERACTIVE_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"], select';

/**
 * Retour sonore sur les interactions de l'interface d'administration (réf.
 * mission UI/UX) : un clic sur un élément interactif (bouton, lien, contrôle
 * de formulaire) joue un petit son. Écouteur global posé une seule fois sur
 * `document` plutôt que sur chaque bouton individuellement — cette page
 * compte des centaines d'éléments cliquables à travers toutes les vues
 * admin, les instrumenter un par un serait à la fois fastidieux et fragile
 * (tout nouveau bouton ajouté plus tard serait silencieux par oubli).
 */
export function useClickSound(enabled: boolean) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const audio = new Audio(CLICK_SOUND_SRC);
    audio.volume = 0.5;
    audioRef.current = audio;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(INTERACTIVE_SELECTOR)) return;
      const el = audioRef.current;
      if (!el) return;
      el.currentTime = 0;
      el.play().catch(() => {
        // Autoplay refusé (rare pour un son déclenché par le clic lui-même,
        // qui EST le geste utilisateur) : sans conséquence, silencieux.
      });
    };

    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      audioRef.current = null;
    };
  }, [enabled]);
}
