/**
 * Script exécuté de manière synchrone pendant le parsing HTML, avant toute
 * hydratation React (réf. UX1.3/1.4, tâche 11.4/11.5) — nécessaire pour
 * appliquer le thème/la langue mis en cache avant le premier paint sans
 * flash. Ce composant suit le patron documenté par cette version de Next.js
 * (node_modules/next/dist/docs/.../preventing-flash-before-hydration.md) :
 * `type="text/plain"` côté client évite l'avertissement "script tag
 * rencontré en rendant un composant React" tout en laissant le script
 * s'exécuter normalement côté serveur/premier chargement.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
