/**
 * Erreurs et comptes rendus du trading Hyperliquid (ordres non protégés, réponses perdues, prix ou actif changés,
 * statuts d'envoi, messages d'erreur lisibles) : découpés de hyperliquid.ts (Q-01, 24/11/2026), qui les réexporte.
 */

/**
 * Écart maximal entre le prix montré dans la confirmation d'un ordre au marché et le prix relu juste avant l'envoi
 * (audit H-02, 24/11/2026) : au-delà, l'ordre est refusé avant tout envoi et doit être reconfirmé.
 */
export const CONFIRM_DRIFT = 0.005;

/**
 * Ordre d'entrée exécuté, mais une protection demandée avec lui (stop loss, take profit) n'a pas pu être posée.
 * Ce n'est pas un échec de l'ordre : la position est ouverte, et il ne faut pas le renvoyer.
 */
export class UnprotectedError extends Error {
  constructor(
    readonly done: string,
    readonly missing: string[],
  ) {
    super(`${done}. ${missing.join(' ; ')}`);
    this.name = 'UnprotectedError';
  }
}

/**
 * Ordre dont la réponse s'est perdue (réseau coupé, délai dépassé) et qu'Hyperliquid n'a pas pu confirmer ni
 * démentir : il a peut-être été reçu. Aucun nouvel envoi n'est permis tant qu'il n'est pas retrouvé ou écarté.
 */
export class PendingOrderError extends Error {
  constructor(
    readonly cloid: string,
    cause: string,
  ) {
    super(
      `Réponse d’Hyperliquid perdue (${cause}) : l’ordre a peut-être été reçu. Aucun nouvel ordre d’ouverture ne partira tant que son sort n’est pas tranché (fermer, annuler et poser un stop restent possibles) ; vérifie la liste des ordres et la position, puis « Vérifier l’ordre en suspens » dans la carte.`,
    );
    this.name = 'PendingOrderError';
  }
}

/**
 * Statuts d'un envoi d'ordres. Le SDK lève `ApiRequestError` dès qu'un seul des ordres d'un groupe est refusé, en
 * gardant la réponse complète dans `error.response` : une entrée acceptée avec une protection refusée doit être lue
 * comme telle, pas comme un échec global (la renvoyer doublerait l'exposition). null : pas de statuts lisibles.
 */
export function orderStatuses(err: unknown): unknown[] | null {
  const s = (err as { response?: { response?: { data?: { statuses?: unknown } } } } | null)?.response?.response?.data?.statuses;
  return Array.isArray(s) ? s : null;
}

/** Erreur dont on sait que l'ordre n'est pas parti, ou a été refusé par Hyperliquid (réponse reçue). */
export function definitive(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'ApiRequestError' || name === 'ValidationError' || name === 'PendingOrderError';
}

/** Ordre retrouvé par son identifiant client : ce qu'on peut en dire à l'utilisateur. */
export function describeFound(status: string): string {
  if (status === 'filled') return 'Ordre exécuté';
  if (status === 'open' || status === 'triggered') return 'Ordre placé dans le carnet';
  if (status === 'canceled' || status.endsWith('Canceled')) return `Ordre reçu puis annulé (${status})`;
  if (status === 'rejected' || status.endsWith('Rejected')) throw new Error(`Ordre refusé par Hyperliquid (${status})`);
  return `Ordre reçu (${status})`;
}

/**
 * Ordre refusé avant tout envoi : il visait un autre actif que celui du compte ou que celui affiché (changement
 * d'actif pendant sa préparation). Rien n'est parti.
 */
/** Prix trop éloigné de celui de la confirmation (ordre au marché) : refusé avant tout envoi, à reconfirmer. */
export class PriceMovedError extends Error {
  constructor(
    readonly expected: number,
    readonly mid: number,
  ) {
    const pct = (Math.abs(mid / expected - 1) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    super(`Le prix a bougé de ${pct} % depuis la confirmation : rien n’a été envoyé. Vérifie le nouveau prix et reconfirme l’ordre.`);
    this.name = 'PriceMovedError';
  }
}

/** Refuse l'ordre au marché si le prix frais s'écarte de plus de `CONFIRM_DRIFT` du prix confirmé (sans prix confirmé : rien). */
export function checkConfirmedPrice(expected: number | null | undefined, mid: number): void {
  if (!expected || !(expected > 0)) return;
  if (Math.abs(mid / expected - 1) > CONFIRM_DRIFT) throw new PriceMovedError(expected, mid);
}

export class CoinChangedError extends Error {
  constructor(
    readonly wanted: string,
    readonly current: string,
  ) {
    super(`Actif changé (${wanted} → ${current}) : rien n’a été envoyé. Vérifie l’ordre sur l’actif affiché et recommence.`);
    this.name = 'CoinChangedError';
  }
}

/**
 * Issue d'une entrée limite groupée avec ses protections : l'entrée d'abord (son refus est une erreur), puis
 * chaque protection, nommée. Une protection refusée n'efface jamais l'entrée acceptée.
 */
export function describeBracket(statuses: unknown[], sent: number, tp: boolean, sl: boolean): string {
  const text = describe(statuses[0]);
  if (sent < 2) return text;
  const names = [tp ? 'TP' : '', sl ? 'SL' : ''].filter(Boolean);
  if (statuses.length < sent) return `${text}. ${names.join(' et ')} à vérifier dans la liste des ordres (réponse incomplète)`;
  const refused: string[] = [];
  statuses.slice(1).forEach((st, i) => {
    try {
      describe(st);
    } catch (err) {
      refused.push(`${names[i] ?? 'protection'} REFUSÉ (${message(err)})`);
    }
  });
  if (refused.length)
    return `${text}, mais ${refused.join(' ; ')} : l’entrée est bien en place, ne la renvoie pas ; pose la protection depuis le graphique`;
  // Rattachés à une entrée qui attend au carnet, TP / SL sont EN ATTENTE : Hyperliquid ne les place qu'une fois
  // l'entrée entièrement exécutée (23/11/2026). Ne jamais les annoncer comme une protection active avant.
  const entryFilled = !!statuses[0] && typeof statuses[0] === 'object' && 'filled' in (statuses[0] as object);
  return entryFilled
    ? `${text}, avec ${names.join(' et ')} rattachés`
    : `${text}, avec ${names.join(' et ')} rattachés EN ATTENTE : actifs seulement quand l’entrée sera entièrement exécutée (une exécution partielle n’est pas protégée)`;
}

export function describe(status: unknown): string {
  if (status && typeof status === 'object') {
    if ('found' in status) return (status as { found: string }).found;
    if ('filled' in status) {
      const f = (status as { filled: { totalSz: string; avgPx: string } }).filled;
      const px = +f.avgPx;
      return `Exécuté : ${(+f.totalSz * px).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} USDC à ${px.toLocaleString('fr-FR')}`;
    }
    if ('resting' in status) return 'Ordre placé dans le carnet';
    if ('error' in status) throw new Error((status as { error: string }).error);
  }
  if (status === 'waitingForTrigger') return 'Ordre conditionnel en place';
  if (status === 'waitingForFill') return 'Ordre en attente d’exécution';
  return 'Ordre envoyé';
}

export function message(err: unknown): string {
  // Les erreurs de viem et du SDK portent le détail dans `shortMessage` ou `details`, et la cause en dessous.
  const e = err as { shortMessage?: string; details?: string; message?: string; cause?: unknown } | undefined;
  const inner = e?.cause as { message?: string } | undefined;
  const text = [e?.shortMessage ?? e?.message ?? String(err), e?.details, inner?.message]
    .filter((x, i, all) => x && all.indexOf(x) === i)
    .join(' — ');
  if (/User rejected|denied/i.test(text)) return 'signature refusée dans MetaMask';
  if (/deposit/i.test(text))
    return `ce compte n’a encore rien déposé sur Hyperliquid : un premier dépôt est nécessaire avant d’autoriser un agent (${text})`;
  if (/chainId|chain id/i.test(text)) return `réseau de MetaMask refusé (${text}) : passe MetaMask sur Arbitrum One puis réessaie`;
  if (/does not exist|API wallet/i.test(text)) return 'portefeuille agent inconnu d’Hyperliquid : réactive le trading';
  if (/Insufficient margin/i.test(text)) return 'marge insuffisante';
  // Action reçue après son échéance (`expiresAfter`) : refusée, donc sans effet (23/11/2026).
  if (/expire|stale/i.test(text) && !/agent/i.test(text))
    return `action arrivée après son échéance, refusée par Hyperliquid sans effet (horloge de l’ordinateur décalée ?) : ${text}`;
  if (/could not immediately match/i.test(text)) return 'aucune contrepartie dans la tolérance de prix (1 %)';
  return text;
}
