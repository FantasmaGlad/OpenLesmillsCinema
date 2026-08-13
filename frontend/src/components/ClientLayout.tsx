"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/lib/useIsMobile";
import { useAppSettings } from "@/lib/AppSettingsContext";
import { useAutoFullscreen } from "@/lib/useAutoFullscreen";
import { useClickSound } from "@/lib/useClickSound";
import { navEntries, isNavGroup, footerNavLinks as footerNavLinkConfigs } from "@/lib/navLinks";
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
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
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
    pathname === "/coach" || pathname === "/coach/" ||
    // Poste radio dédié (réf. lot L4) : écran plein écran comme /kiosk, PAS
    // de préfixe (pathname.startsWith) pour ne pas avaler /radio-library et
    // /radio-remote, qui restent des pages d'admin normales.
    pathname === "/radio" || pathname === "/radio/";
  useClickSound(!isFullscreenRoute);

  // La navigation ferme le tiroir mobile automatiquement (réf. UX4.1).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronise l'état du tiroir avec le système de routing externe (Next.js), pas un simple calcul dérivable au rendu
    setDrawerOpen(false);
  }, [pathname]);

  // Réf. mission UI/UX — icônes Google Material Symbols reprises telles
  // quelles du design importé (surface "PC Admin") plutôt que les SVG
  // Heroicons d'origine, pour une identité visuelle cohérente avec le reste
  // de la refonte.
  const footerLinks = footerNavLinkConfigs.map((link) => ({ ...link, label: t(link.labelKey) }));

  // Regroupements dépliables (accordéon, réf. demande de réorganisation) :
  // ouverts par défaut si la page courante est dans le groupe ; l'utilisateur
  // peut ensuite plier/déplier à sa guise.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setOpenGroups((g) => ({ ...g, [key]: !(g[key] ?? false) }));

  const renderNavEntries = (onNavigate?: () => void) =>
    navEntries.map((entry, i) => {
      if (isNavGroup(entry)) {
        const groupActive = entry.children.some((c) => isNavLinkActive(pathname, c.href));
        const open = openGroups[entry.groupKey] ?? groupActive;
        return (
          <div key={entry.groupKey}>
            <button
              type="button"
              className="nav-link olc-press"
              style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer", font: "inherit", color: "inherit" }}
              onClick={() => toggleGroup(entry.groupKey)}
              aria-expanded={open}
            >
              <Icon name={entry.iconName} size={20} />
              <span style={{ flex: 1, textAlign: "left" }}>{t(entry.groupKey)}</span>
              <Icon name={open ? "expand_more" : "chevron_right"} size={18} />
            </button>
            {open && (
              <div style={{ marginLeft: "22px", borderLeft: "1px solid var(--border-color)", paddingLeft: "8px" }}>
                {entry.children.map((child) => {
                  const isActive = isNavLinkActive(pathname, child.href);
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      onClick={onNavigate}
                      className={`nav-link olc-press ${isActive ? "active" : ""}`}
                    >
                      <Icon name={child.iconName} size={20} />
                      <span>{t(child.labelKey)}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      }
      const isActive = entry.href === "/" ? pathname === "/" : isNavLinkActive(pathname, entry.href);
      return (
        <Link
          key={entry.href}
          href={entry.href}
          onClick={onNavigate}
          className={`nav-link olc-press olc-anim-in ${isActive ? "active" : ""}`}
          style={{ animationDelay: `${i * 30}ms` }}
        >
          <Icon name={entry.iconName} size={20} />
          <span>{t(entry.labelKey)}</span>
        </Link>
      );
    });

  // L'écran kiosk, l'interface cinéma adhérents et le mode coach mobile
  // n'ont ni sidebar ni en-tête d'administration : plein écran dédié
  // uniquement (réf. UX4.5).
  if (isFullscreenRoute) {
    return <>{children}</>;
  }

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
                {renderNavEntries(() => setDrawerOpen(false))}
                {footerLinks.map((link) => {
                  const isActive = link.href === "/" ? pathname === "/" : isNavLinkActive(pathname, link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setDrawerOpen(false)}
                      className={`nav-link olc-press ${isActive ? "active" : ""}`}
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
            {renderNavEntries()}
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
                style={{ animationDelay: `${(navEntries.length + i) * 30}ms` }}
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
        {/* En-tête retiré (réf. demande) : le contenu occupe tout l'espace ;
            le statut système (Watcher/Écran) est déplacé dans Paramètres. */}
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
