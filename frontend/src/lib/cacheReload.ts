/**
 * Rechargement « synchronisation des écrans » (réf. bouton Paramètres
 * « Synchronisation des écrans ») : vide les caches du navigateur de l'appareil
 * AVANT de recharger, pour qu'il re-télécharge les nouveaux assets depuis le
 * serveur au lieu de resservir d'anciennes versions mises en cache.
 *
 * Concrètement : purge le Cache Storage (API `caches`, utilisé par un éventuel
 * service worker / PWA) et désenregistre les service workers, puis recharge la
 * page. Sans service worker aujourd'hui ces étapes sont sans effet mais
 * inoffensives — et le rechargement suffit à revalider les fichiers servis par
 * FastAPI (StaticFiles renvoie ETag/Last-Modified, donc un asset modifié est
 * bien re-téléchargé). Toute erreur est avalée : le rechargement doit avoir
 * lieu quoi qu'il arrive.
 */
export async function clearCachesAndReload(): Promise<void> {
  try {
    if (typeof window !== "undefined" && "caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    // Cache/SW indisponibles ou refusés : on recharge quand même.
  }
  window.location.reload();
}
