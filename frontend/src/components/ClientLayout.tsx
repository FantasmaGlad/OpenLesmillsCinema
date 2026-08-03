"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePlaybackSocket } from "@/lib/usePlaybackSocket";
import { useIsMobile } from "@/lib/useIsMobile";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useAutoFullscreen } from "@/lib/useAutoFullscreen";
import { useClickSound } from "@/lib/useClickSound";
import { navLinks as navLinkConfigs, footerNavLinks as footerNavLinkConfigs } from "@/lib/navLinks";
import Icon from "@/components/Icon";
import AppLogo from "@/components/AppLogo";

interface ClientLayoutProps {
  children: React.ReactNode;
}

/**
 * Un lien de nav est actif sur sa propre page ET ses sous-pages, mais pas sur
 * une AUTRE page dont le chemin partage juste le même préfixe textuel (bug
 * "Playlists audio sélectionne aussi Cours audio" : "/audio-playlists/"
 * commence bien par "/audio" en tant que chaîne, sans être une sous-page de
 * "/audio/"). On exige donc une frontière de segment (`/`) après le préfixe.
 */
function isNavLinkActive(pathname: string, href: string): boolean {
  return pathname === href || pathname === `${href}/` || pathname.startsWith(`${href}/`);
}

export default function ClientLayout({ children }: ClientLayoutProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { t } = useAppSettings();
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const { state: playbackState, connected: playbackConnected } = usePlaybackSocket();
  // Réf. mission UI/UX — "plein écran de base sur mobile" : demande le
  // plein écran navigateur dès le premier tap (le remote/coach mobile n'a
  // aucune raison de garder la barre d'adresse visible).
  useAutoFullscreen(isMobile);
  // Son de clic (réf. mission UI/UX) : uniquement dans le studio admin, pas
  // sur l'écran cinéma/kiosk ni le mode coach (appels de hooks toujours
  // inconditionnels, seul `enabled` varie selon la route).
  const isFullscreenRoute =
    pathname === "/kiosk" || pathname === "/kiosk/" ||
    pathname === "/cinema" || pathname === "/cinema/" ||
    pathname === "/coach" || pathname === "/coach/";
  useClickSound(!isFullscreenRoute);

  const SCREEN_STATE_LABELS: Record<string, string> = {
    waiting: t("playbackState.waiting"),
    paused: t("playbackState.paused"),
    coach_mode: t("playbackState.coach_mode"),
    offline: t("playbackState.offline"),
  };

  // La navigation ferme le tiroir mobile automatiquement (réf. UX4.1).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronise l'état du tiroir avec le système de routing externe (Next.js), pas un simple calcul dérivable au rendu
    setDrawerOpen(false);
  }, [pathname]);

  // Détecter l'URL API correcte
  const getApiUrl = (path: string) => {
    if (typeof window !== "undefined") {
      if (window.location.port === "3000") {
        return `http://localhost:8001/api${path}`;
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
    // 30 s : suffisant pour détecter une panne sans surcharger le serveur
    // (le kiosque a ses propres timers indépendants dans kiosk/page.tsx)
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  // Réf. mission UI/UX — icônes Google Material Symbols reprises telles
  // quelles du design importé (surface "PC Admin") plutôt que les SVG
  // Heroicons d'origine, pour une identité visuelle cohérente avec le reste
  // de la refonte.
  const navLinks = navLinkConfigs.map((link) => ({ ...link, label: t(link.labelKey) }));
  const footerLinks = footerNavLinkConfigs.map((link) => ({ ...link, label: t(link.labelKey) }));

  // L'écran kiosk, l'interface cinéma adhérents et le mode coach mobile
  // n'ont ni sidebar ni en-tête d'administration : plein écran dédié
  // uniquement (réf. UX4.5).
  if (isFullscreenRoute) {
    return <>{children}</>;
  }

  const screenLabel = !playbackConnected
    ? t("playbackState.offline")
    : playbackState.state === "playing"
    ? t("playbackState.playing", { title: playbackState.current_video?.title ?? "" })
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
          <button className="mobile-burger-btn olc-press" onClick={() => setDrawerOpen(true)} aria-label={t("nav.openMenu")}>
            <Icon name="menu" size={24} />
          </button>
          <AppLogo size={32} className="mobile-topbar-logo" />
          <div className={`status-dot ${screenDotClass} ${screenDotClass === "active" ? "olc-live-dot" : ""}`} title={screenLabel} />
        </header>

        <main className="mobile-page-content">{children}</main>

        {drawerOpen && (
          <>
            <div className="mobile-drawer-overlay" onClick={() => setDrawerOpen(false)} />
            <div className="mobile-drawer">
              <div className="sidebar-brand">
                <AppLogo size={72} className="brand-logo" />
              </div>
              <nav className="mobile-drawer-nav">
                {allLinks.map((link, i) => {
                  const isActive = link.href === "/" ? pathname === "/" : isNavLinkActive(pathname, link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={`nav-link olc-press olc-anim-in ${isActive ? "active" : ""}`}
                      style={{ animationDelay: `${i * 30}ms` }}
                    >
                      <Icon name={link.iconName} size={20} />
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
            <AppLogo size={72} className="brand-logo" />
          </div>
          <nav className="sidebar-nav">
            {navLinks.map((link, i) => {
              const isActive = link.href === "/" ? pathname === "/" : isNavLinkActive(pathname, link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`nav-link olc-press olc-anim-in ${isActive ? "active" : ""}`}
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <Icon name={link.iconName} size={20} />
                  <span>{link.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          {footerLinks.map((link, i) => {
            const isActive = link.href === "/" ? pathname === "/" : isNavLinkActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`nav-link olc-press olc-anim-in ${isActive ? "active" : ""}`}
                style={{ animationDelay: `${(navLinks.length + i) * 30}ms` }}
              >
                <Icon name={link.iconName} size={20} />
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
              {pathname === "/" || pathname.startsWith("/dashboard-cable")
                ? t("nav.dashboardCable")
                : pathname.startsWith("/dashboard-network")
                ? t("nav.dashboardNetwork")
                : pathname.startsWith("/library")
                ? t("header.libraryTitle")
                : pathname.startsWith("/audio-playlists")
                ? t("nav.audioPlaylists")
                : pathname.startsWith("/audio")
                ? t("header.audioTitle")
                : pathname.startsWith("/backgrounds")
                ? t("header.backgroundsTitle")
                : pathname.startsWith("/playlists")
                ? t("nav.playlists")
                : pathname.startsWith("/schedule")
                ? t("header.scheduleTitle")
                : pathname.startsWith("/settings")
                ? t("header.settingsTitle")
                : t("header.appName")}
            </h2>
          </div>

          <div className="status-indicator">
            <div className="status-details" style={{ marginRight: "16px", textAlign: "right" }}>
              <span className="status-label">{t("header.watcherLabel")}</span>
              <span className="status-val">{isOnline ? t("header.watcherActive") : t("header.watcherInactive")}</span>
            </div>
            <div className="status-details" style={{ marginRight: "24px", textAlign: "right" }}>
              <span className="status-label">{t("header.screenLabel")}</span>
              <span className="status-val">{screenLabel}</span>
            </div>
            <div
              className={`status-dot ${screenDotClass} ${screenDotClass === "active" ? "olc-live-dot" : ""}`}
              title={playbackConnected ? t("header.screenOnline") : t("header.screenOffline")}
            />
          </div>
        </header>

        {/* Dynamic page content */}
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
