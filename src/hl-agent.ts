import type { ExchangeClient } from '@nktkas/hyperliquid';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SealedSecret } from './agent-vault';

/**
 * Agent de trading Hyperliquid : nom et durée de validité, révocation par remplacement, état chez Hyperliquid,
 * connexion gardée dans le stockage local et remarques sur la garde de sa clé. Découpé de hyperliquid.ts (Q-01,
 * 24/11/2026), qui le réexporte.
 */

/**
 * Nom technique de l'agent tel qu'Hyperliquid l'affiche dans la liste des agents autorisés du compte. Ancien nom de
 * l'application, gardé exprès (voir l'en-tête) : la révocation remplace l'agent de même nom.
 */
export const AGENT_NAME = 'HyperDashboard';
/**
 * Durée de validité de l'agent, en jours : passé ce délai, Hyperliquid le refuse d'office et une nouvelle signature
 * MetaMask est demandée. Une clé d'agent dérobée cesse ainsi d'être utilisable d'elle-même. 7 jours (audit S-01,
 * 23/11/2026, 15 jours avant) : compromis entre le temps pendant lequel une clé volée resterait utilisable et la
 * fréquence des signatures. L'échéance est écrite chez Hyperliquid dans le nom de l'agent (`valid_until`) et gardée
 * en absolu (`agentUntil`) : un agent approuvé avant le changement reste valable jusqu'à sa propre échéance.
 */
export const AGENT_DAYS = 7;
export const AGENT_TTL_MS = AGENT_DAYS * 86_400_000;
/** Durée de validité de l'agent de remplacement posé par une révocation (sa clé n'existe plus : simple ménage). */
export const REVOKE_TTL_MS = 3_600_000;

/** Nom sous lequel l'agent est autorisé : le nom affiché par Hyperliquid, suivi de sa fin de validité (ms). */
export const agentName = (until: number) => `${AGENT_NAME} valid_until ${until}`;

/**
 * Révoque l'agent HyperDashboard du compte. Hyperliquid désinscrit un agent nommé dès qu'un autre agent est
 * autorisé sous le même nom (documentation « Nonces and API wallets ») : on autorise donc, par une signature du
 * compte, un agent de remplacement dont la clé est tirée au hasard et jamais conservée. L'ancienne clé, où qu'elle
 * se trouve, ne peut plus rien signer ; la nouvelle n'existe plus, et son autorisation s'éteint en une heure.
 */
export async function revokeNamedAgent(master: Pick<ExchangeClient, 'approveAgent'>, now = Date.now()): Promise<`0x${string}`> {
  const discarded = privateKeyToAccount(generatePrivateKey());
  await master.approveAgent({ agentAddress: discarded.address, agentName: agentName(now + REVOKE_TTL_MS) });
  return discarded.address;
}

/** Agent autorisé d'un compte, tel que listé par Hyperliquid (info `extraAgents`). */
export interface ListedAgent {
  address: string;
  name: string;
  /** Fin de validité (ms) ; null pour un agent sans expiration. */
  validUntil: number | null;
}

/** Nom de base d'un agent listé, sans un éventuel suffixe « valid_until … ». */
const baseName = (name: string) => name.replace(/ valid_until \d+$/, '');

/**
 * Agents HyperChart (nom technique `AGENT_NAME`) encore valables parmi ceux d'un compte (23/11/2026) : ceux
 * qu'une nouvelle autorisation sous ce nom remplacerait.
 */
export function ourAgents(list: readonly ListedAgent[], now = Date.now()): ListedAgent[] {
  return list.filter(a => baseName(a.name) === AGENT_NAME && (a.validUntil === null || a.validUntil > now));
}

/**
 * État chez Hyperliquid de l'agent `address` (23/11/2026) : autorisé et valable (avec sa fin de validité), ou non
 * (absent de la liste : remplacé, révoqué, jamais enregistré ; ou périmé). Sert avant de réutiliser une clé
 * enregistrée et après une révocation.
 */
export function agentStatus(
  list: readonly ListedAgent[],
  address: string,
  now = Date.now(),
): { valid: true; until: number | null } | { valid: false; why: 'absent' | 'expired' } {
  const a = list.find(x => x.address.toLowerCase() === address.toLowerCase());
  if (!a) return { valid: false, why: 'absent' };
  if (a.validUntil !== null && a.validUntil <= now) return { valid: false, why: 'expired' };
  return { valid: true, until: a.validUntil };
}

/**
 * Connexion gardée dans le stockage local, une par emplacement (`HL_SLOT_KEYS`). En mémoire, `agentKey` est la clé de
 * l'agent en clair ; dans le stockage, seule sa forme chiffrée (`agentSealed`) est écrite. Sans coffre, la clé n'est
 * gardée qu'en mémoire, pour la session (23/11/2026 : plus jamais en clair dans le stockage). Les métadonnées de
 * l'agent (adresse, compte, échéance) sont gardées indépendamment de la clé : un agent dont la clé est perdue reste
 * connu, donc révocable.
 */
export interface Saved {
  address?: string;
  agentKey?: `0x${string}`;
  /** Clé de l'agent chiffrée (`agent-vault.ts`) : seule forme de la clé écrite dans le stockage. */
  agentSealed?: SealedSecret;
  /** Adresse publique de l'agent (23/11/2026) : gardée même si la clé est perdue, pour la révocation et l'affichage. */
  agentAddress?: string;
  agentFor?: string;
  /** Fin de validité de l'agent (ms) ; absente pour un agent autorisé avant l'ajout de l'expiration. */
  agentUntil?: number;
}

/**
 * Coffre indisponible (navigation privée, navigateur ancien) : la clé de l'agent n'est gardée qu'en mémoire, jamais en
 * clair dans le stockage (23/11/2026). Dit avant l'activation et dans la carte.
 */
export const KEY_SESSION_NOTE =
  'Chiffrement indisponible dans ce navigateur (navigation privée ?) : la clé de l’agent n’est gardée qu’en mémoire, pour cette session. Après un rechargement de la page, il faudra réautoriser le trading (nouvelle signature MetaMask).';
/** Ancien nom (clé en clair), gardé pour les imports existants : c'est désormais la clé en mémoire seulement. */
export const KEY_PLAIN_NOTE = KEY_SESSION_NOTE;
/** Clé chiffrée devenue illisible (données du site effacées, coffre inaccessible) : l'agent reste autorisé, révocable. */
export const KEY_LOST_NOTE =
  'La clé de l’agent n’a pas pu être déchiffrée (données du navigateur effacées ou coffre inaccessible) : ce navigateur ne peut plus trader avec. L’agent reste autorisé chez Hyperliquid jusqu’à son échéance : révoque-le (« Révoquer ») ou réactive le trading, ce qui le remplace.';
/** Agent enregistré absent de la liste d'Hyperliquid, ou périmé : sa clé n'est pas réutilisée (23/11/2026). */
export const AGENT_GONE_NOTE =
  'L’agent enregistré dans ce navigateur n’est plus autorisé chez Hyperliquid (remplacé depuis un autre navigateur, révoqué ou expiré) : sa clé est abandonnée. Réactive le trading pour trader d’ici.';

/**
 * Verdict sur un agent enregistré, d'après la liste des agents du compte chez Hyperliquid (23/11/2026) :
 *  - `valid` : listé et valable ;
 *  - `gone` : périmé, ou absent alors qu'un autre agent HyperChart est listé (remplacé depuis un autre navigateur),
 *    ou absent et sans échéance locale (ancien agent qu'on ne peut pas confirmer : pas réutilisé) ;
 *  - `unknown` : absent d'une liste sans agent HyperChart, avec une échéance locale encore à venir. Rien n'est conclu
 *    (la liste d'Hyperliquid n'est pas tenue pour exhaustive tant que ce n'est pas vérifié sur un vrai compte).
 */
export function agentVerdict(
  list: readonly ListedAgent[],
  address: string,
  hasLocalUntil: boolean,
  now = Date.now(),
): { verdict: 'valid'; until: number | null } | { verdict: 'gone' | 'unknown' } {
  const st = agentStatus(list, address, now);
  if (st.valid) return { verdict: 'valid', until: st.until };
  if (st.why === 'expired') return { verdict: 'gone' };
  if (ourAgents(list, now).length > 0 || !hasLocalUntil) return { verdict: 'gone' };
  return { verdict: 'unknown' };
}
