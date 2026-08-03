import React from "react";

interface AppLogoProps {
  size?: number;
  className?: string;
}

/**
 * Logo officiel de l'application (réf. mission "logo imposant") : servi
 * depuis /public/logo.png, version ROGNÉE sur son contenu réel du fichier
 * fourni — l'original (logo.svg) est un canevas carré 2024×2024 presque vide
 * où le bandeau "OPEN LesMILLS CINEMA" n'occupe qu'une fine bande centrale,
 * ce qui le rendait minuscule à taille d'affichage égale. `size` reste la
 * HAUTEUR affichée ; le bandeau fait ~2,45× cette hauteur en largeur.
 */
export default function AppLogo({ size = 32, className }: AppLogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="OpenLesMillsCinema"
      className={`app-logo${className ? ` ${className}` : ""}`}
      style={{ height: size, width: "auto", display: "block" }}
    />
  );
}
