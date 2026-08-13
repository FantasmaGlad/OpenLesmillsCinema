import React from "react";

interface AppLogoProps {
  size?: number;
  className?: string;
}

/**
 * Logo officiel de l'application, servi depuis /public/logo.png. `size` est
 * la HAUTEUR affichée ; le bandeau fait ~2,34× cette hauteur en largeur.
 */
export default function AppLogo({ size = 32, className }: AppLogoProps) {
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
