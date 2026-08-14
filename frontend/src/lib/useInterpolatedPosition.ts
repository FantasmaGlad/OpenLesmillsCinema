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
 *
 * Correctif "le minuteur tourne dans le vide à l'infini" (réf. retour user,
 * radio) : si le flux réel se bloque (hoquet réseau) sans jamais déclencher
 * `ended`/`error`, plus aucun rapport de position n'arrive alors que `playing`
 * reste vrai côté serveur — sans garde-fou, l'extrapolation ci-dessous
 * continuait indéfiniment à partir de la dernière position connue, donnant
 * l'illusion d'une lecture qui avance alors que le son s'est tu. Passé
 * `MAX_EXTRAPOLATION_MS` sans nouveau rapport, on gèle l'affichage au lieu
 * d'inventer du temps qui ne s'écoule plus réellement — un signal honnête,
 * complémentaire de la récupération active côté lecteur (`/radio/page.tsx`).
 */
const MAX_EXTRAPOLATION_MS = 6000;
export function useInterpolatedPosition(
  serverPosition: number,
  playing: boolean,
  cause: string,
): number {
  // 0 plutôt que Date.now() ici : un useRef() est réévalué à chaque rendu même
  // si React n'utilise le résultat qu'au tout premier (règle react-hooks/purity
  // — pas d'appel impur pendant le rendu). Sans incidence : le premier effet
  // ci-dessous, qui APPELLE Date.now() dans un effet (donc hors rendu, permis),
  // écrase cette valeur dès le premier rapport serveur reçu.
  const baselineRef = useRef({ value: serverPosition, receivedAt: 0 });
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
      const elapsedMs = Math.min(Date.now() - receivedAt, MAX_EXTRAPOLATION_MS);
      setDisplay(value + elapsedMs / 1000);
    }, 200);
    return () => clearInterval(id);
  }, [playing]);

  return display;
}
