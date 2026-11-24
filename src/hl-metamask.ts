import { getAddress, type EIP1193Provider } from 'viem';
import { message } from './hl-errors';

/**
 * Dialogue avec MetaMask (EIP-1193) : signataire de l'autorisation de l'agent, comptes connectés à la page et
 * verdict sur le compte exposé. Découpé de hyperliquid.ts (Q-01, 24/11/2026), qui le réexporte.
 */

/**
 * Signataire MetaMask pour l'autorisation de l'agent. viem refuse, avant même de solliciter le portefeuille, le
 * nom de type « HyperliquidTransaction:ApproveAgent » qu'exige Hyperliquid (deux-points interdit par sa
 * validation) : la signature est donc demandée directement à MetaMask (eth_signTypedData_v4), comme le fait
 * l'interface d'Hyperliquid. L'objet a la forme d'un compte viem JSON-RPC, reconnue par le SDK.
 */
export function metamaskSigner(eth: EIP1193Provider, owner: string) {
  return {
    async signTypedData(args: { domain: unknown; types: unknown; primaryType: string; message: unknown }): Promise<`0x${string}`> {
      const json = JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      return (await eth.request({ method: 'eth_signTypedData_v4', params: [owner as `0x${string}`, json] } as never)) as `0x${string}`;
    },
    async getAddresses(): Promise<`0x${string}`[]> {
      return [owner as `0x${string}`];
    },
    async getChainId(): Promise<number> {
      return parseInt((await eth.request({ method: 'eth_chainId' })) as string, 16);
    },
  };
}

type Permission = { parentCapability?: string; caveats?: { type?: string; value?: unknown }[] };

/** Comptes listés dans une permission eth_accounts de MetaMask (caveat restrictReturnedAccounts). */
export function permittedIn(perms: unknown): string[] {
  if (!Array.isArray(perms)) return [];
  const out: string[] = [];
  for (const p of perms as Permission[]) {
    if (p?.parentCapability !== 'eth_accounts') continue;
    for (const c of p.caveats ?? []) {
      if (c?.type !== 'restrictReturnedAccounts' || !Array.isArray(c.value)) continue;
      for (const a of c.value) if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) out.push(getAddress(a));
    }
  }
  return out;
}

/**
 * Ouvre le choix des comptes de MetaMask (wallet_requestPermissions), pour connecter à la page un compte de plus,
 * et renvoie les comptes autorisés qu'il annonce. Vide si le portefeuille ne le permet pas ; un refus est remonté.
 */
export async function pickAccounts(eth: EIP1193Provider): Promise<string[]> {
  try {
    return permittedIn(await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] } as never));
  } catch (err) {
    if (/User rejected|denied/i.test(message(err))) throw err;
    return [];
  }
}

/**
 * Tous les comptes connectés à la page. MetaMask ne renvoie souvent par eth_accounts que le compte affiché ;
 * la liste complète est dans ses permissions. Le compte affiché vient en premier.
 */
export async function permittedAccounts(eth: EIP1193Provider, extra: string[] = []): Promise<string[]> {
  const shown = ((await eth.request({ method: 'eth_requestAccounts' })) as string[]).map(a => getAddress(a));
  let granted: string[] = [];
  try {
    granted = permittedIn(await eth.request({ method: 'wallet_getPermissions' } as never));
  } catch {
    /* portefeuille sans wallet_getPermissions : le compte affiché seul */
  }
  return [...new Set([...shown, ...extra, ...granted])];
}

/**
 * Audit S-02 (23/11/2026) : verdict sur les comptes que MetaMask expose à la page (`accountsChanged`) au regard du
 * compte suivi. `ok` : pas de compte suivi, ou il est exposé ; `other` : seulement d'autres comptes ; `none` : aucun
 * compte (MetaMask verrouillé, page déconnectée).
 */
export function walletVerdict(accounts: unknown, followed: string | null): 'ok' | 'other' | 'none' {
  if (!followed) return 'ok';
  const list = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string').map(a => a.toLowerCase()) : [];
  if (!list.length) return 'none';
  return list.includes(followed.toLowerCase()) ? 'ok' : 'other';
}

export function provider(): (EIP1193Provider & { on?: (event: string, cb: (accounts: string[]) => void) => void }) | undefined {
  return (window as unknown as { ethereum?: EIP1193Provider & { on?: (event: string, cb: (accounts: string[]) => void) => void } })
    .ethereum;
}
