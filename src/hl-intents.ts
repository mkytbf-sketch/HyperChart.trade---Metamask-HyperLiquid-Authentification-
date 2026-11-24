/**
 * Intentions d'envoi (ordres dont la réponse peut se perdre) : échéances et garde dans le stockage local. Découpé de
 * hyperliquid.ts (Q-01, 24/11/2026) ; la classe `Hyperliquid` garde la logique de rapprochement.
 */

/**
 * Échéance des actions envoyées à Hyperliquid (`expiresAfter`, 23/11/2026) : une action reçue après est refusée par
 * Hyperliquid. Une réponse perdue n'est donc plus incertaine indéfiniment : passé l'échéance (plus une marge pour
 * l'écart d'horloge), un ordre toujours inconnu d'Hyperliquid n'a pas été reçu et ne le sera plus.
 */
export const ACTION_TTL_MS = 30_000;
/** Marge ajoutée à l'échéance avant de conclure qu'un ordre inconnu n'a pas été reçu (horloge du poste décalée). */
export const ACTION_SKEW_MS = 30_000;
/**
 * Intention enregistrée avant le 23/11/2026, sans échéance d'action : tranchée, comme avant, une minute après son
 * envoi (Hyperliquid traite un ordre en une ou deux secondes).
 */
export const LEGACY_UNKNOWN_MS = 60_000;

/**
 * Ordre dont la réponse peut se perdre, enregistré AVANT son envoi (23/11/2026) : lié au compte, à l'actif et à son
 * identifiant client, il est levé à la réponse. Une intention restée en place (réponse perdue, page rechargée pendant
 * l'envoi) bloque les nouveaux ordres d'ouverture jusqu'à ce que son sort soit tranché.
 */
export interface Intent {
  cloid: `0x${string}`;
  at: number;
  coin: string;
  address: string;
  /** Échéance de l'action (`expiresAfter`, ms) ; null pour une intention enregistrée avant le 23/11/2026. */
  expiresAt: number | null;
}

/** Clé de stockage des intentions d'un emplacement. */
export const intentsKey = (storeKey: string): string => `${storeKey}:intents`;

/** Ancienne forme (avant le 23/11/2026) : une seule incertitude, sans actif ni échéance. */
export const legacyPendingKey = (storeKey: string): string => `${storeKey}:pending`;

/**
 * Intentions en cours, relues du stockage à chaque fois : un autre onglet a pu en ajouter ou en lever une. Une
 * intention de plus d'un jour est abandonnée (son sort est de toute façon tranché depuis longtemps). L'ancienne
 * forme est rattachée au compte `address` ; stockage illisible : `fallback` (intentions gardées en mémoire).
 */
export function readIntents(storeKey: string, address: string | undefined, fallback: Intent[]): Intent[] {
  const fresh = (i: Intent) =>
    typeof i?.cloid === 'string' && /^0x[0-9a-f]{32}$/.test(i.cloid) && typeof i.at === 'number' && Date.now() - i.at < 86_400_000;
  try {
    const list = (JSON.parse(localStorage.getItem(intentsKey(storeKey)) ?? '[]') as Intent[]).filter(fresh);
    const legacy = JSON.parse(localStorage.getItem(legacyPendingKey(storeKey)) ?? 'null') as { cloid: `0x${string}`; at: number } | null;
    if (legacy && address) list.push({ cloid: legacy.cloid, at: legacy.at, coin: '', address, expiresAt: null });
    return list.filter(fresh);
  } catch {
    return fallback;
  }
}

/** Écrit les intentions (et efface l'ancienne forme) ; stockage indisponible : rien (l'appelant les garde en mémoire). */
export function writeIntents(storeKey: string, list: Intent[]): void {
  try {
    if (list.length) localStorage.setItem(intentsKey(storeKey), JSON.stringify(list));
    else localStorage.removeItem(intentsKey(storeKey));
    localStorage.removeItem(legacyPendingKey(storeKey));
  } catch {
    /* stockage indisponible : l'état reste en mémoire pour cet onglet */
  }
}
