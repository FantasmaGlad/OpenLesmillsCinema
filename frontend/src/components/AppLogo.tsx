import React from "react";

interface AppLogoProps {
  size?: number;
  className?: string;
}

/**
 * Logo officiel de l'application, servi depuis /public/logo.png. `size` est
 * la HAUTEUR affichée (px) ; le bandeau fait ~2,34× cette hauteur en largeur.
 * Si `size` est omis, aucune hauteur inline n'est posée : c'est alors la
 * classe CSS (`className`) qui pilote la taille — utile pour un logo
 * responsive (ex. écran radio « hors diffusion », réf. .radio-brand-logo).
 */
export default function AppLogo({ size, className }: AppLogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="Bobine"
      className={`app-logo${className ? ` ${className}` : ""}`}
      style={{ height: size, width: "auto", display: "block" }}
    />
  );
}
