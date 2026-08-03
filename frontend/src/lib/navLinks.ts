export interface NavLinkConfig {
  href: string;
  labelKey: string;
  iconName: string;
}

// Partagé entre ClientLayout (sidebar/tiroir mobile) et le mode coach (réf.
// correctif "impossible de naviguer vers une autre fonction sans quitter le
// mode coach") : une seule source pour la liste des sections admin.
export const navLinks: NavLinkConfig[] = [
  { href: "/dashboard-cable", labelKey: "nav.dashboardCable", iconName: "cable" },
  { href: "/dashboard-network", labelKey: "nav.dashboardNetwork", iconName: "wifi" },
  { href: "/library", labelKey: "nav.library", iconName: "video_library" },
  { href: "/audio", labelKey: "nav.audio", iconName: "library_music" },
  { href: "/backgrounds", labelKey: "nav.backgrounds", iconName: "gradient" },
  { href: "/playlists", labelKey: "nav.playlists", iconName: "playlist_play" },
  { href: "/audio-playlists", labelKey: "nav.audioPlaylists", iconName: "queue_music" },
  { href: "/schedule", labelKey: "nav.schedule", iconName: "calendar_month" },
];

export const footerNavLinks: NavLinkConfig[] = [
  { href: "/settings", labelKey: "nav.settings", iconName: "settings" },
  { href: "/logs", labelKey: "nav.logs", iconName: "receipt_long" },
];
