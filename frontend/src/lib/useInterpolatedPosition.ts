"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Lisse l'affichage de la tête de lecture entre deux rapports serveur peu
 * fréquents (le kiosk primaire ne rapporte sa position réelle qu'1x/s,
 * cf. `handleTimeUpdate` côté kiosk) : sans ça, la barre/le chiffre affichés
 * restent figés ~750ms puis sautent d'un coup d'une seconde, ce qui donnait
 * l'impression d'un tremblement (retour utilisateur 2026-07-21 : "avance de
 * 1s puis recule"). Le serveur reste le seul maître — cette interpolation
 * n'invente jamais de valeur, elle ne fait qu'estimer l'écoulement RÉEL entre
 * deux annonces déjà reçues, et se recale immédiatement dessus.
 *
 * `cause` distingue un rapport de routine ("position_tick", pure diffusion à
 * 4 Hz de la dernière position connue) d'un évènement qui représente une
 * VRAIE discontinuité voulue (chargement, recherche manuelle, arrêt, reprise
 * de playlist...) : seul le premier cas est lissé sans jamais reculer : les
 * autres causes sont toujours appliquées telles quelles, y compris vers
 * l'arrière (ex. une recherche en arrière sur la barre de progression).
 */
export function useInterpolatedPosition(
  serverPosition: number,
  playing: boolean,
  cause: string,
): number {
  const baselineRef = useRef({ value: serverPosition, receivedAt: Date.now() });
  const [display, setDisplay] = useState(serverPosition);

  useEffect(() => {
    let value = serverPosition;
    if (cause === "position_tick" && playing) {
      const prev = baselineRef.current;
      const extrapolated = prev.value + (Date.now() - prev.receivedAt) / 1000;
      value = Math.max(serverPosition, extrapolated);
    }
    baselineRef.current = { value, receivedAt: Date.now() };
    setDisplay(value);
  }, [serverPosition, playing, cause]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const { value, receivedAt } = baselineRef.current;
      setDisplay(value + (Date.now() - receivedAt) / 1000);
    }, 200);
    return () => clearInterval(id);
  }, [playing]);

  return display;
}
