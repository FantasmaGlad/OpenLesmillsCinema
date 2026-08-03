"use client";

import { useEffect, useState } from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";

function hexLuminance(hex: string): number | null {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Couleur de texte lisible sur un fond donné (réf. correctif "boutons cinéma
 * hors thème") : un texte blanc fixe devenait illisible sur certaines
 * teintes claires (ex. thèmes charbon/orchidée/taupe, contraste < 3:1).
 * Calculé depuis la couleur RÉSOLUE de la variable CSS, pas depuis le nom du
 * thème, pour rester juste même si les teintes évoluent.
 */
export function readableForeground(hex: string | null): string {
  const lum = hex ? hexLuminance(hex) : null;
  if (lum === null) return "#fff";
  const whiteContrast = 1.05 / (lum + 0.05);
  const blackContrast = (lum + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "#ffffff" : "#161116";
}

/**
 * Couleur de texte/icône lisible pour un élément dont le fond est l'accent du
 * THÈME actif (`--accent-primary`) — recalculée à chaque changement de
 * thème. Partagée par toute page dont un bouton/badge prend un fond en
 * pleine teinte d'accent (réf. mission "intégrer au thème" : cinema, coach).
 */
export function useThemeAccentForeground(): string {
  const { theme } = useAppSettings();
  const [fg, setFg] = useState("#fff");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const resolved = getComputedStyle(document.documentElement).getPropertyValue("--accent-primary");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lit une valeur résolue du DOM (système externe, pas dérivable au rendu), même motif que AppSettingsContext.tsx
    setFg(readableForeground(resolved));
  }, [theme]);
  return fg;
}
