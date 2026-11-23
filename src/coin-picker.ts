/**
 * SUBSTITUT pour le dépôt d'audit — ce n'est PAS le fichier de l'application.
 *
 * Le vrai `src/coin-picker.ts` est la liste des actifs (recherche, favoris). positions-panel.ts n'en utilise que
 * `rowPrice` (recopiée telle quelle ci-dessous) et `chooseCoin` (affiche un autre actif ; sans effet ici).
 */
export function rowPrice(p: number): string {
  if (!(p > 0)) return '—';
  const d = Math.max(0, Math.min(8, 5 - Math.ceil(Math.log10(p))));
  return p.toLocaleString('fr-FR', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: Math.max(d, 1) });
}

/** Affiche l'actif `coin` dans l'application ; sans effet dans ce dépôt. */
export function chooseCoin(coin: string): void {
  void coin;
}
