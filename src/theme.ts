import { SETTINGS_KEY } from './storage-keys';

/** Thème choisi dans l'application (réglages du navigateur), appliqué aux pages hors graphique : connexion, compte. */
export function applyStoredTheme(): void {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as { theme?: unknown } | null;
    if (s?.theme === 'light' || s?.theme === 'dark') document.documentElement.dataset.theme = s.theme;
  } catch {
    /* réglages illisibles : thème par défaut */
  }
}

/** Échappe un texte destiné à du HTML (défini avec le gabarit sûr `html`, safe-html.ts). */
export { esc } from './safe-html';

/**
 * Site public, version française (mentions légales, confidentialité, questions fréquentes) : l'application est en
 * français. Un lien vers la racine mènerait à la version anglaise, la règle de langue du site prenant le référent
 * app.hyperchart.trade pour un visiteur ayant choisi l'anglais (audit du 22/11/2026, Q-13). Sans barre finale :
 * chaque usage ajoute son chemin, terminé par « / » comme les adresses du site.
 */
export const SITE = 'https://hyperchart.trade/fr';
