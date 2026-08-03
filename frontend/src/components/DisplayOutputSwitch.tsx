"use client";

import React from "react";
import { useAppSettings } from "@/lib/AppSettingsContext";
import Icon from "@/components/Icon";

interface DisplayOutputSwitchProps {
  displayOutput: "kiosk" | "cinema" | null;
  onSetDisplayOutput: (output: "kiosk" | "cinema") => void;
  /** Libellé/infobulle spécifiques au canal (réf. canaux indépendants
   * câblé/réseau) — par défaut le texte générique historique. */
  label?: string;
  hint?: string;
}

/**
 * Sélecteur de la sortie affichée sur UN canal de diffusion (câblé ou
 * réseau, réf. canaux indépendants) : kiosk (écran piloté par l'admin,
 * défaut) ou cinéma (les adhérents choisissent leur cours à la souris). La
 * bascule est instantanée : le backend diffuse le changement et la page
 * affichée navigue d'elle-même. Instancié une fois par canal.
 */
export default function DisplayOutputSwitch({ displayOutput, onSetDisplayOutput, label, hint }: DisplayOutputSwitchProps) {
  const { t } = useAppSettings();
  return (
    <div className="display-output-switch" title={hint ?? t("dashboard.displayOutputHint")}>
      <span className="display-output-label">{label ?? t("dashboard.displayOutputLabel")}</span>
      <div className="display-output-buttons">
        <button
          className={`display-output-btn olc-press ${displayOutput === "kiosk" || displayOutput === null ? "active" : ""}`}
          onClick={() => onSetDisplayOutput("kiosk")}
          disabled={displayOutput === null}
        >
          <Icon name="tv" size={16} />
          {t("dashboard.displayOutputKiosk")}
        </button>
        <button
          className={`display-output-btn olc-press ${displayOutput === "cinema" ? "active" : ""}`}
          onClick={() => onSetDisplayOutput("cinema")}
          disabled={displayOutput === null}
        >
          <Icon name="theaters" size={16} />
          {t("dashboard.displayOutputCinema")}
        </button>
      </div>
    </div>
  );
}
