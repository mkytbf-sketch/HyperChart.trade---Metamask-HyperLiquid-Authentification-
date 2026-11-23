/**
 * Coffre de la clé de l'agent de trading (23/11/2026, E1 de docs/AUDIT-PASSAGE-A-L-ECHELLE-2026-11-23.md). Jusqu'ici,
 * la clé privée de l'agent était écrite en clair dans le localStorage (`strate:hyperliquid`, `strate:hyperliquid:2`).
 *
 * Désormais elle y est chiffrée (AES-GCM 256 bits, IV aléatoire de 12 octets à chaque chiffrement). La clé de
 * chiffrement est une clé WebCrypto créée **non exportable** et gardée dans IndexedDB : le navigateur la conserve
 * sous forme opaque, aucun script ne peut en lire les octets, seulement s'en servir depuis cette origine.
 *
 * Ce que cela protège : une copie isolée du localStorage (sauvegarde ou synchronisation de ce seul stockage, extension
 * qui le lit) n'y trouve qu'un texte chiffré, inutilisable sans la clé non exportable.
 * Ce que cela ne protège pas (précisé le 23/11/2026) : la copie du profil complet du navigateur, qui emporte aussi
 * IndexedDB et donc la clé du coffre ; un script qui s'exécute sur l'origine de l'application (XSS, dépendance
 * compromise), qui peut demander le déchiffrement comme l'application elle-même, ou plus simplement trader
 * directement avec l'agent. Contre cela, ce sont la CSP sans script inline, Trusted Types et la durée limitée de
 * l'agent qui comptent.
 *
 * Repli : sans IndexedDB ou sans WebCrypto (certains modes de navigation privée, navigateurs anciens), le coffre est
 * indisponible (`sealSecret` rend null). Depuis le 23/11/2026, l'appelant ne garde alors la clé qu'en mémoire, pour
 * la session, et ne l'écrit jamais en clair (il faut réautoriser après un rechargement).
 */

/** Forme chiffrée d'un secret : IV et texte chiffré (avec son étiquette d'authentification), en base64. */
export interface SealedSecret {
  iv: string;
  ct: string;
}

/** Où le coffre garde sa clé de chiffrement : IndexedDB dans le navigateur, une mémoire dans les essais. */
export interface VaultKeyStore {
  /** Clé existante, ou `fresh` enregistrée et rendue s'il n'y en a pas encore (sans écraser celle d'un autre onglet). */
  getOrPut(fresh: CryptoKey): Promise<CryptoKey>;
}

const DB_NAME = 'hyperchart-coffre';
const DB_STORE = 'cles';
const KEY_ID = 'agent';

/** Clé gardée dans IndexedDB : lue et, au besoin, écrite dans une seule transaction (deux onglets qui démarrent ensemble gardent la même). */
const indexedDbStore: VaultKeyStore = {
  getOrPut: fresh =>
    new Promise<CryptoKey>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
      open.onerror = () => reject(open.error ?? new Error('IndexedDB indisponible'));
      open.onblocked = () => reject(new Error('IndexedDB bloqué'));
      open.onsuccess = () => {
        const db = open.result;
        let tx: IDBTransaction;
        try {
          tx = db.transaction(DB_STORE, 'readwrite');
        } catch (e) {
          db.close();
          return reject(e instanceof Error ? e : new Error('IndexedDB indisponible'));
        }
        const store = tx.objectStore(DB_STORE);
        let key: CryptoKey = fresh;
        const read = store.get(KEY_ID);
        read.onsuccess = () => {
          if (read.result instanceof CryptoKey) key = read.result;
          else store.put(fresh, KEY_ID);
        };
        tx.oncomplete = () => {
          db.close();
          resolve(key);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB : écriture refusée'));
        };
      };
    }),
};

let keyStore: VaultKeyStore | null = null;
let keyPromise: Promise<CryptoKey | null> | null = null;

/** Remplace le lieu de garde de la clé (essais) ; `null` rétablit IndexedDB. La clé en mémoire est oubliée. */
export function setVaultKeyStore(store: VaultKeyStore | null): void {
  keyStore = store;
  keyPromise = null;
}

const available = () =>
  typeof crypto !== 'undefined' &&
  typeof crypto.subtle?.generateKey === 'function' &&
  (keyStore !== null || typeof indexedDB !== 'undefined');

/** Clé de chiffrement du coffre (créée au premier usage), ou null si le coffre est indisponible. */
function vaultKey(): Promise<CryptoKey | null> {
  keyPromise ??= (async () => {
    if (!available()) return null;
    try {
      // Non exportable (`false`) : ni `exportKey` ni `wrapKey` ne pourront en sortir les octets.
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return await (keyStore ?? indexedDbStore).getOrPut(fresh);
    } catch {
      return null;
    }
  })();
  return keyPromise;
}

/** Le coffre est-il utilisable dans ce navigateur ? (ouvre ou crée la clé au passage) */
export async function vaultAvailable(): Promise<boolean> {
  return (await vaultKey()) !== null;
}

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (text: string): Uint8Array<ArrayBuffer> => {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * Chiffre `plain`, lié à `label` (donnée authentifiée : le texte chiffré d'un emplacement ne se déchiffre pas sous un
 * autre). Null si le coffre est indisponible : l'appelant décide du repli.
 */
export async function sealSecret(plain: string, label: string): Promise<SealedSecret | null> {
  const key = await vaultKey();
  if (!key) return null;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) },
      key,
      new TextEncoder().encode(plain),
    );
    return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  } catch {
    return null;
  }
}

/** Forme chiffrée lisible (deux chaînes base64), ou null. */
export function asSealed(v: unknown): SealedSecret | null {
  if (typeof v !== 'object' || v === null) return null;
  const { iv, ct } = v as Record<string, unknown>;
  return typeof iv === 'string' && typeof ct === 'string' && iv.length > 0 && ct.length > 0 ? { iv, ct } : null;
}

/**
 * Déchiffre un secret. Null si c'est impossible : coffre indisponible, clé du coffre effacée (données du site
 * supprimées), texte altéré ou venu d'un autre emplacement. Le secret est alors perdu, jamais deviné.
 */
export async function openSecret(sealed: SealedSecret, label: string): Promise<string | null> {
  const key = await vaultKey();
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: new TextEncoder().encode(label) },
      key,
      fromB64(sealed.ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
