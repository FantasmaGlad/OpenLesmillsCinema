"use client";

import { useEffect } from "react";

/**
 * L'ancien tableau de bord unique est scindé en deux tableaux distincts, un
 * par canal de diffusion (réf. mission "Tableau de bord Câblé / Réseau").
 * La racine redirige vers le canal câblé — l'écran principal de la salle —
 * pour que les marque-pages et l'URL d'accueil restent valides.
 */
export default function RootRedirect() {
  useEffect(() => {
    window.location.replace("/dashboard-cable/");
  }, []);
  return null;
}
