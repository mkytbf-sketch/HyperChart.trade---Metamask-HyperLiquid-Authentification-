/**
 * SUBSTITUT pour le dépôt d'audit — ce n'est PAS le fichier de l'application : des réglages de l'interface, seuls
 * les deux champs lus par positions-panel.ts (mêmes types que dans app/src/ui/settings.ts).
 */
export interface Settings {
  posFolded?: boolean;
  posTab?: 'positions' | 'orders';
}
