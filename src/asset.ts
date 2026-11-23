/**
 * SUBSTITUT pour le dépôt d'audit — ce n'est PAS le fichier de l'application.
 *
 * Le vrai `src/asset.ts` (≈ 750 lignes) résout la liste des marchés sur six places (Binance, Bybit, OKX…) et n'a
 * aucun lien avec le portefeuille. hyperliquid.ts n'en utilise que l'actif affiché (`asset.coin`) et l'actif de
 * repli (`assetFallback`) ; format.ts, les décimales. Ce substitut fixe ces valeurs à celles du BTC, comme l'app au
 * démarrage.
 */
export interface AssetSpec {
  coin: string;
  digits: number;
  szDecimals: number;
  /** Autres champs du vrai module (marchés, unités…), sans usage ici : admis pour les essais. */
  [champ: string]: unknown;
}

/** Contrat BTC, actif de départ de l'app (seuls les champs lus par le code publié). */
export const BTC_SPEC: AssetSpec = { coin: 'BTC', digits: 1, szDecimals: 5 };

export let asset: AssetSpec = BTC_SPEC;

/** Actif demandé qui n'a pas pu être chargé (l'app est alors repassée sur un autre) ; null sinon. */
export let assetFallback: string | null = null;

/** Réservé aux essais : change l'actif affiché. */
export function setAsset(spec: AssetSpec, fallback: string | null = null): void {
  asset = spec;
  assetFallback = fallback;
}
