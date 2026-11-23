/**
 * EXTRAIT de app/src/chart/shared.ts : le seul type `TradeLine` (lignes des ordres sur le graphique), recopié tel
 * quel. Le vrai src/chart.ts (le graphique) n'a aucun lien avec le portefeuille.
 */
/** Ligne de trading sur le prix : entrée et liquidation de la position, ordres ouverts (déplaçables). */
export interface TradeLine {
  id: string;
  /** Actif de la ligne (position ou ordre) : un glissement est refusé si l'actif affiché a changé entre-temps. */
  coin?: string;
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
  /** Un ordre : il se glisse vers un nouveau prix. */
  draggable?: boolean;
  /** Étiquette pendant le glissement, au prix visé (par exemple le gain d'un TP à ce prix). */
  preview?: (price: number) => string;
}
