"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Retour sonore au survol (réf. mission UI/UX, interface cinéma) : une seule
 * instance <audio> réutilisée (remise à zéro puis rejouée) plutôt qu'un
 * `new Audio()` par survol — évite d'accumuler des lectures qui se
 * chevauchent quand la souris parcourt rapidement plusieurs cartes.
 */
export function useHoverSound(src: string, volume = 0.4) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const audio = new Audio(src);
    audio.volume = volume;
    audioRef.current = audio;
    return () => {
      audioRef.current = null;
    };
  }, [src, volume]);

  return useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => {
      // Autoplay bloqué tant qu'aucun geste utilisateur n'a eu lieu sur la
      // page (politique navigateur) : silencieux jusqu'au premier clic.
    });
  }, []);
}
