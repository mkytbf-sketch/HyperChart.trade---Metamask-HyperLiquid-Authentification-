/**
 * Rémunération de l'interface quand l'app est mise en ligne : « builder code » et code de parrainage Hyperliquid.
 *
 * Réglés par variables d'environnement au moment du build (fichier `.env`, voir `.env.example`), jamais dans le
 * code : sans elles, rien n'est demandé aux utilisateurs et aucun frais n'est ajouté.
 *  - `VITE_HL_BUILDER` : adresse qui reçoit le frais d'interface ;
 *  - `VITE_HL_BUILDER_FEE` : frais en dixièmes de point de base (10 = 0,01 % ; 100 = 0,1 %, maximum d'Hyperliquid
 *    sur les perpétuels) ;
 *  - `VITE_HL_BUILDER_REQUIRED` : « false » pour laisser trader sans avoir autorisé le frais (obligatoire sinon) ;
 *  - `VITE_HL_REFERRAL_CODE` : code de parrainage proposé aux comptes qui n'ont pas encore de parrain.
 */

const env = import.meta.env as Record<string, string | undefined>;

/** Frais en dixièmes de point de base (entier de 0 à 100) ; hors bornes ou illisible : 0. */
export function parseFee(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : 0;
}

/** Taux au format attendu par l'autorisation d'Hyperliquid : 10 → « 0.01% ». */
export function feeRate(tenthsBp: number): `${string}%` {
  return `${Number((tenthsBp / 1000).toFixed(4))}%`;
}

/** Frais en pourcentage lisible : 10 → « 0,01 % ». */
export const feeText = (tenthsBp: number) => `${(tenthsBp / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 4 })} %`;

const address = /^0x[0-9a-fA-F]{40}$/.test(env.VITE_HL_BUILDER ?? '') ? (env.VITE_HL_BUILDER!.toLowerCase() as `0x${string}`) : null;
const code = /^[A-Za-z0-9_-]{1,20}$/.test(env.VITE_HL_REFERRAL_CODE ?? '') ? env.VITE_HL_REFERRAL_CODE! : null;

export const PARTNER = {
  /** Frais d'interface ; null si non configuré. */
  builder: address && parseFee(env.VITE_HL_BUILDER_FEE) > 0 ? { address, fee: parseFee(env.VITE_HL_BUILDER_FEE) } : null,
  /** Faut-il avoir autorisé le frais pour passer des ordres ? */
  required: env.VITE_HL_BUILDER_REQUIRED !== 'false',
  /** Code de parrainage proposé ; null si non configuré. */
  referral: code,
};
