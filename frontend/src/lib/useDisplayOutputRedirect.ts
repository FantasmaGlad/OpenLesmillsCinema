"use client";

import { useEffect, useRef } from "react";

/**
 * Vrai uniquement pour le navigateur de l'écran câblé du Wyse : le kiosk
 * Chromium local accède au serveur via 127.0.0.1 (cf. install.sh KIOSK_URL).
 * Les visiteurs LAN (téléphones, PC admin, kiosks miroirs) passent par l'IP
 * ou le nom mDNS et ne sont donc jamais redirigés — seule la sortie câblée
 * suit la bascule kiosk/cinéma décidée dans l'admin.
 */
export function isWiredDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

/**
 * Fait suivre à la page affichée la sortie choisie par l'admin pour SON
 * canal (réf. canaux de diffusion indépendants câblé/réseau).
 *
 * Correctif "kiosk et cinéma dépendants" : seule la sortie CÂBLÉE (l'écran
 * du Wyse) applique la valeur stockée dès le montage — elle doit démarrer
 * dans le bon mode au boot. Un appareil du RÉSEAU, lui, n'est redirigé que
 * lorsqu'un admin bascule réellement le canal PENDANT que la page est
 * ouverte : quelqu'un qui ouvre volontairement /cinema sur son téléphone ou
 * son PC y reste, même si le canal réseau est réglé sur "kiosk" — sans quoi
 * il était éjecté vers /kiosk au montage et se retrouvait à afficher la
 * lecture partagée lancée depuis l'admin (les deux pages semblaient liées).
 */
export function useDisplayOutputRedirect(
  current: "kiosk" | "cinema",
  cableOutput: "kiosk" | "cinema" | null,
  networkOutput: "kiosk" | "cinema" | null,
) {
  // Dernière valeur observée pour le canal de cet appareil : permet de
  // distinguer la valeur initiale (chargée du serveur au montage — ignorée
  // sur le réseau) d'un vrai changement poussé par l'admin (suivi partout).
  const lastSeenRef = useRef<"kiosk" | "cinema" | null>(null);

  useEffect(() => {
    const wired = isWiredDisplay();
    const target = wired ? cableOutput : networkOutput;
    if (!target) return;

    const previous = lastSeenRef.current;
    lastSeenRef.current = target;

    if (target === current) return;
    // Écran câblé : suit toujours la valeur stockée (boot dans le bon mode).
    // Appareil réseau : ne suit que les bascules décidées en direct (la
    // première valeur observée après le montage n'en est pas une).
    if (!wired && previous === null) return;
    window.location.replace(`/${target}`);
  }, [cableOutput, networkOutput, current]);
}
