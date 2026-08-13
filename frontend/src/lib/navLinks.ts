export interface NavLinkConfig {
  href: string;
  labelKey: string;
  iconName: string;
}

// Regroupement dépliable (accordéon) de plusieurs sections sous une même
// catégorie (réf. demande "regrouper pour éviter que le menu devienne
// illisible") : `groupKey` est la clé i18n du titre de catégorie.
export interface NavGroupConfig {
  groupKey: string;
  iconName: string;
  children: NavLinkConfig[];
}

export type NavEntry = NavLinkConfig | NavGroupConfig;

export function isNavGroup(entry: NavEntry): entry is NavGroupConfig {
  return (entry as NavGroupConfig).children !== undefined;
}

// Arborescence de la barre latérale (réf. demande de réorganisation) :
// - "Sortie Câblé" / "Sortie Réseau" (ex-tableaux de bord) en tête, puis
//   "Radio" et "Coach" remontés juste en dessous (réf. demande).
// - "Radio" regroupe télécommande + bibliothèque + rappels.
// - "Coach" regroupe cours audio + fonds animés.
// - "Playlist" est une page unique fusionnant playlists vidéo et audio.
export const navEntries: NavEntry[] = [
  { href: "/dashboard-cable", labelKey: "nav.dashboardCable", iconName: "cable" },
  { href: "/dashboard-network", labelKey: "nav.dashboardNetwork", iconName: "wifi" },
  {
    groupKey: "nav.radioGroup",
    iconName: "radio",
    children: [
      { href: "/radio-remote", labelKey: "nav.radioRemote", iconName: "graphic_eq" },
      { href: "/radio-library", labelKey: "nav.radioLibrary", iconName: "album" },
      { href: "/radio-announcements", labelKey: "nav.radioAnnouncements", iconName: "campaign" },
    ],
  },
  {
    groupKey: "nav.coachGroup",
    iconName: "fitness_center",
    children: [
      { href: "/audio", labelKey: "nav.audio", iconName: "library_music" },
      { href: "/backgrounds", labelKey: "nav.backgrounds", iconName: "gradient" },
    ],
  },
  { href: "/library", labelKey: "nav.library", iconName: "video_library" },
  { href: "/playlists", labelKey: "nav.playlists", iconName: "playlist_play" },
  { href: "/schedule", labelKey: "nav.schedule", iconName: "calendar_month" },
];

export const footerNavLinks: NavLinkConfig[] = [
  { href: "/settings", labelKey: "nav.settings", iconName: "settings" },
  { href: "/logs", labelKey: "nav.logs", iconName: "receipt_long" },
];

// Liste PLATE de toutes les sections (groupes aplatis) : utilisée par le mode
// coach en plein écran, qui liste toutes les pages accessibles sans quitter le
// plein écran (réf. correctif "impossible de naviguer hors du mode coach").
export const navLinks: NavLinkConfig[] = navEntries.flatMap((entry) =>
  isNavGroup(entry) ? entry.children : [entry],
);
