"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import { useIsMobile } from "@/lib/useIsMobile";

interface ClientLayoutProps {
  children: React.ReactNode;
}

const SCREEN_STATE_LABELS: Record<string, string> = {
  waiting: "Attente",
  countdown: "Compte à rebours",
  paused: "Pause",
  coach_mode: "Mode coach",
  offline: "Hors ligne",
};

export default function ClientLayout({ children }: ClientLayoutProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [watcherStatus] = useState<string>("Actif");
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const { state: playbackState, connected: playbackConnected } = usePlaybackSocket();

  // La navigation ferme le tiroir mobile automatiquement (réf. UX4.1).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronise l'état du tiroir avec le système de routing externe (Next.js), pas un simple calcul dérivable au rendu
    setDrawerOpen(false);
  }, [pathname]);

  // Détecter l'URL API correcte
  const getApiUrl = (path: string) => {
    if (typeof window !== "undefined") {
      if (window.location.port === "3000") {
        return `http://localhost:8000/api${path}`;
      }
    }
    return `/api${path}`;
  };

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(getApiUrl("/health"), { cache: "no-store" });
        if (res.ok) {
          setIsOnline(true);
        } else {
          setIsOnline(false);
        }
      } catch {
        setIsOnline(false);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  const navLinks = [
    {
      href: "/",
      label: "Tableau de bord",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" />
        </svg>
      ),
    },
    {
      href: "/library",
      label: "Bibliothèque",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      href: "/audio",
      label: "Cours audio",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      ),
    },
    {
      href: "/backgrounds",
      label: "Fonds animés",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      href: "/playlists",
      label: "Playlists",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h12" />
        </svg>
      ),
    },
    {
      href: "/schedule",
      label: "Planning",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
  ];

  const footerLinks = [
    {
      href: "/settings",
      label: "Paramètres",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      href: "/logs",
      label: "Logs",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
  ];

  // L'écran kiosk (cinéma) et le mode coach mobile n'ont ni sidebar ni
  // en-tête d'administration : plein écran dédié uniquement (réf. UX4.5).
  if (pathname === "/kiosk" || pathname === "/kiosk/" || pathname === "/coach" || pathname === "/coach/") {
    return <>{children}</>;
  }

  const screenLabel = !playbackConnected
    ? "Hors ligne"
    : playbackState.state === "playing"
    ? `Lecture : ${playbackState.current_video?.title ?? ""}`
    : SCREEN_STATE_LABELS[playbackState.state] ?? playbackState.state;

  const screenDotClass = !playbackConnected
    ? "offline"
    : playbackState.state === "playing"
    ? "active"
    : "attente";

  const allLinks = [...navLinks, ...footerLinks];

  if (isMobile) {
    // Réf. UX4.1 : pas de navigation permanente visible sur mobile — l'écran
    // principal (la page courante, généralement la télécommande) occupe tout
    // l'espace, la navigation reste dans un tiroir discret (burger).
    return (
      <div className="mobile-app-container">
        <header className="mobile-topbar">
          <button className="mobile-burger-btn" onClick={() => setDrawerOpen(true)} aria-label="Ouvrir le menu">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="mobile-topbar-brand">LM CINEMA</span>
          <div className={`status-dot ${screenDotClass}`} title={screenLabel} />
        </header>

        <main className="mobile-page-content">{children}</main>

        {drawerOpen && (
          <>
            <div className="mobile-drawer-overlay" onClick={() => setDrawerOpen(false)} />
            <div className="mobile-drawer">
              <div className="sidebar-brand">
                <span className="brand-logo">LM CINEMA</span>
              </div>
              <nav className="mobile-drawer-nav">
                {allLinks.map((link) => {
                  const isActive = pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
                  return (
                    <Link key={link.href} href={link.href} className={`nav-link ${isActive ? "active" : ""}`}>
                      {link.icon}
                      <span>{link.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="app-sidebar">
        <div>
          <div className="sidebar-brand">
            <span className="brand-logo">LM CINEMA</span>
          </div>
          <nav className="sidebar-nav">
            {navLinks.map((link) => {
              const isActive = pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`nav-link ${isActive ? "active" : ""}`}
                >
                  {link.icon}
                  <span>{link.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          {footerLinks.map((link) => {
            const isActive = pathname === link.href || pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`nav-link ${isActive ? "active" : ""}`}
              >
                {link.icon}
                <span>{link.label}</span>
              </Link>
            );
          })}
        </div>
      </aside>

      {/* Main Area */}
      <div className="app-main">
        {/* Permanent Header */}
        <header className="app-header">
          <div>
            <h2 style={{ fontSize: "1.1rem", margin: 0 }}>
              {pathname === "/"
                ? "Tableau de bord"
                : pathname.startsWith("/library")
                ? "Bibliothèque Vidéo"
                : pathname.startsWith("/audio")
                ? "Cours Audio"
                : pathname.startsWith("/backgrounds")
                ? "Fonds Animés"
                : pathname.startsWith("/playlists")
                ? "Playlists"
                : pathname.startsWith("/schedule")
                ? "Planning"
                : pathname.startsWith("/settings")
                ? "Paramètres"
                : "OpenLesmillsCinema"}
            </h2>
          </div>

          <div className="status-indicator">
            <div className="status-details" style={{ marginRight: "16px", textAlign: "right" }}>
              <span className="status-label">Watcher Dossier</span>
              <span className="status-val">{isOnline ? watcherStatus : "Inactif"}</span>
            </div>
            <div className="status-details" style={{ marginRight: "24px", textAlign: "right" }}>
              <span className="status-label">Écran Cinéma</span>
              <span className="status-val">{screenLabel}</span>
            </div>
            <div
              className={`status-dot ${screenDotClass}`}
              title={playbackConnected ? "Écran cinéma connecté" : "Écran cinéma hors ligne"}
            />
          </div>
        </header>

        {/* Dynamic page content */}
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
