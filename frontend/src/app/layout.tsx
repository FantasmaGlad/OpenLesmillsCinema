import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ClientLayout from "@/components/ClientLayout";
import { AppSettingsProvider } from "@/lib/AppSettingsContext";
import { InlineScript } from "@/components/InlineScript";
import { UploadManagerProvider } from "@/lib/UploadManager";

// Applique le thème/la langue mis en cache (localStorage) avant même
// l'hydratation React, pour éviter un flash du mauvais thème au premier
// affichage (réf. UX1.3/UX1.4, tâche 11.4/11.5) — script bloquant volontaire
// (pas de défer/async), s'exécute donc avant tout rendu visible. Le contenu
// est statique (jamais de données utilisateur injectées ici), sans risque XSS.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('olc-theme');if(t)document.documentElement.setAttribute('data-theme',t);var l=localStorage.getItem('olc-language');if(l)document.documentElement.lang=l;}catch(e){}})();`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenLesmillsCinema - Administration",
  description: "Système de cinéma automatisé pour les cours Les Mills",
  manifest: "/manifest.json",
};

// Réf. mission UI/UX — "plein écran de base sur mobile" : ces meta forcent le
// mode standalone (sans barre d'adresse) quand la page est ajoutée à l'écran
// d'accueil (Android/iOS). Un vrai plein écran navigateur (Fullscreen API)
// exige un geste utilisateur — voir le hook useAutoFullscreen déclenché au
// premier tap, dans ClientLayout.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      data-theme="les-mills-sombre"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400..700,0..1,0&display=block"
          rel="stylesheet"
        />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {/* Icône requise pour que la PWA soit réellement installable (réf.
            correctif "pas de plein écran sur téléphone") : avec `icons: []`
            dans le manifest, Chrome Android ne créait qu'un simple raccourci
            qui rouvrait le navigateur classique — le mode
            fullscreen/standalone du manifest était ignoré. */}
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <InlineScript html={THEME_INIT_SCRIPT} />
      </head>
      <body>
        <AppSettingsProvider>
          <UploadManagerProvider>
            <ClientLayout>{children}</ClientLayout>
          </UploadManagerProvider>
        </AppSettingsProvider>
      </body>
    </html>
  );
}

