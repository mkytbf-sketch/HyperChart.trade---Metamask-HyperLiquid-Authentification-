import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSealed, openSecret, sealSecret, setVaultKeyStore, vaultAvailable, type VaultKeyStore } from './agent-vault';
import { Hyperliquid, KEY_LOST_NOTE, KEY_PLAIN_NOTE } from './hyperliquid';
import { memoryStorage } from './test-support/fake-socket';

/**
 * Clé de l'agent chiffrée au repos (23/11/2026, E1 de docs/AUDIT-PASSAGE-A-L-ECHELLE-2026-11-23.md). IndexedDB est
 * remplacé par une mémoire (`VaultKeyStore`) ; le chiffrement est le vrai (WebCrypto de Node). Aucune signature ni
 * aucun ordre : les clés sont des valeurs d'essai, et le réseau est coupé (fetch refusé).
 */

const SLOT = 'strate:hyperliquid';
const ADDRESS = '0x1111111111111111111111111111111111111111';
const AGENT_KEY = `0x${'ab'.repeat(32)}` as const;

/** Lieu de garde en mémoire : la même clé tant qu'on ne le remplace pas (comme IndexedDB d'un même navigateur). */
function memoryKeyStore(): VaultKeyStore & { key: CryptoKey | null } {
  const store = {
    key: null as CryptoKey | null,
    getOrPut: async (fresh: CryptoKey) => (store.key ??= fresh),
  };
  return store;
}

/** Navigateur d'essai : stockage en mémoire, réseau coupé (le suivi du compte échoue sans rien envoyer). */
function browser() {
  const storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('réseau coupé (essai)');
    }),
  );
  return storage;
}

afterEach(() => {
  setVaultKeyStore(null);
  vi.unstubAllGlobals();
});

describe('coffre de la clé de l’agent', () => {
  it('chiffre et déchiffre, avec un IV neuf à chaque fois, sans jamais écrire le secret en clair', async () => {
    setVaultKeyStore(memoryKeyStore());
    const a = await sealSecret(AGENT_KEY, SLOT);
    const b = await sealSecret(AGENT_KEY, SLOT);
    expect(a && b).toBeTruthy();
    expect(a!.iv).not.toBe(b!.iv);
    expect(a!.ct).not.toBe(b!.ct);
    expect(JSON.stringify(a)).not.toContain('abab');
    expect(await openSecret(a!, SLOT)).toBe(AGENT_KEY);
  });

  it('la clé du coffre est non exportable', async () => {
    const store = memoryKeyStore();
    setVaultKeyStore(store);
    expect(await vaultAvailable()).toBe(true);
    expect(store.key!.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', store.key!)).rejects.toThrow();
  });

  it('un texte chiffré ne s’ouvre ni sous un autre emplacement, ni altéré, ni avec une autre clé du coffre', async () => {
    setVaultKeyStore(memoryKeyStore());
    const box = (await sealSecret(AGENT_KEY, SLOT))!;
    expect(await openSecret(box, 'strate:hyperliquid:2')).toBeNull();
    const bytes = atob(box.ct);
    const flipped = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    expect(await openSecret({ ...box, ct: flipped }, SLOT)).toBeNull();
    // Données du site effacées : nouvelle clé du coffre, l'ancien texte est illisible.
    setVaultKeyStore(memoryKeyStore());
    expect(await openSecret(box, SLOT)).toBeNull();
  });

  it('coffre indisponible (IndexedDB absent) : sealSecret rend null, l’appelant se replie', async () => {
    setVaultKeyStore(null);
    vi.stubGlobal('indexedDB', undefined);
    expect(await vaultAvailable()).toBe(false);
    expect(await sealSecret(AGENT_KEY, SLOT)).toBeNull();
  });

  it('asSealed n’accepte que deux chaînes non vides', () => {
    expect(asSealed({ iv: 'a', ct: 'b' })).toEqual({ iv: 'a', ct: 'b' });
    expect(asSealed({ iv: '', ct: 'b' })).toBeNull();
    expect(asSealed('x')).toBeNull();
    expect(asSealed(null)).toBeNull();
  });
});

describe('clé de l’agent dans le stockage local (Hyperliquid)', () => {
  it('migre une clé en clair au premier chargement : chiffrée, et le clair est supprimé', async () => {
    setVaultKeyStore(memoryKeyStore());
    const storage = browser();
    storage.setItem(
      SLOT,
      JSON.stringify({ address: ADDRESS, agentKey: AGENT_KEY, agentFor: ADDRESS, agentUntil: Date.now() + 86_400_000 }),
    );
    const hl = new Hyperliquid(() => {});
    expect(hl.keyPending).toBe(true);
    await hl.whenKeyReady();
    expect(hl.keyPending).toBe(false);
    const raw = storage.getItem(SLOT)!;
    expect(raw).not.toContain(AGENT_KEY.slice(2));
    const saved = JSON.parse(raw) as Record<string, unknown>;
    expect(saved.agentKey).toBeUndefined();
    expect(asSealed(saved.agentSealed)).not.toBeNull();
    expect(saved).toMatchObject({ address: ADDRESS, agentFor: ADDRESS });
    // Les autres lecteurs du stockage (compte suivi, apparence) lisent toujours l'adresse.
    expect(hl.state.keyNote).toBeNull();
    // Le trading s'active une fois la clé lue.
    await vi.waitFor(() => expect(hl.state.trading).toBe(true));
  });

  it('au rechargement, la clé chiffrée est déchiffrée et le trading reprend', async () => {
    setVaultKeyStore(memoryKeyStore());
    const storage = browser();
    storage.setItem(
      SLOT,
      JSON.stringify({ address: ADDRESS, agentKey: AGENT_KEY, agentFor: ADDRESS, agentUntil: Date.now() + 86_400_000 }),
    );
    await new Hyperliquid(() => {}).whenKeyReady();
    const sealed = storage.getItem(SLOT);
    // Rechargement de la page : nouvel objet, même stockage, même coffre.
    const again = new Hyperliquid(() => {});
    expect(again.state.trading).toBe(false);
    await again.whenKeyReady();
    await vi.waitFor(() => expect(again.state.trading).toBe(true));
    expect((again as unknown as { saved: { agentKey?: string } }).saved.agentKey).toBe(AGENT_KEY);
    // Rien n'est réécrit en clair.
    expect(storage.getItem(SLOT)).not.toContain(AGENT_KEY.slice(2));
    expect(JSON.parse(storage.getItem(SLOT)!).agentSealed).toEqual(JSON.parse(sealed!).agentSealed);
  });

  it('clé chiffrée illisible (coffre effacé) : inutilisable, trading inactif, l’agent reste connu (23/11/2026)', async () => {
    setVaultKeyStore(memoryKeyStore());
    const storage = browser();
    storage.setItem(SLOT, JSON.stringify({ address: ADDRESS, agentKey: AGENT_KEY, agentFor: ADDRESS }));
    await new Hyperliquid(() => {}).whenKeyReady();
    setVaultKeyStore(memoryKeyStore());
    const hl = new Hyperliquid(() => {});
    await hl.whenKeyReady();
    expect(hl.state.keyNote).toBe(KEY_LOST_NOTE);
    // Adresse, compte et forme chiffrée gardés : l'agent reste révocable (et la clé relisible si le coffre revient).
    const kept = JSON.parse(storage.getItem(SLOT)!);
    expect(kept).toMatchObject({ address: ADDRESS, agentFor: ADDRESS });
    expect(kept.agentKey).toBeUndefined();
    expect(asSealed(kept.agentSealed)).not.toBeNull();
    await vi.waitFor(() => expect(hl.state.address).toBe(ADDRESS));
    expect(hl.state.trading).toBe(false);
    expect(hl.state.orphanAgent).not.toBeNull();
  });

  it('sans coffre (navigation privée) : clé effacée du stockage, gardée en mémoire pour la session (23/11/2026)', async () => {
    setVaultKeyStore(null);
    vi.stubGlobal('indexedDB', undefined);
    const storage = browser();
    storage.setItem(
      SLOT,
      JSON.stringify({ address: ADDRESS, agentKey: AGENT_KEY, agentFor: ADDRESS, agentUntil: Date.now() + 86_400_000 }),
    );
    const hl = new Hyperliquid(() => {});
    await hl.whenKeyReady();
    expect(JSON.parse(storage.getItem(SLOT)!).agentKey).toBeUndefined();
    expect(storage.getItem(SLOT)).not.toContain(AGENT_KEY.slice(2));
    expect(hl.state.keyNote).toBe(KEY_PLAIN_NOTE);
    await vi.waitFor(() => expect(hl.state.trading).toBe(true));
  });

  it('« Oublier » efface la forme chiffrée', async () => {
    setVaultKeyStore(memoryKeyStore());
    const storage = browser();
    storage.setItem(SLOT, JSON.stringify({ address: ADDRESS, agentKey: AGENT_KEY, agentFor: ADDRESS }));
    const hl = new Hyperliquid(() => {});
    await hl.forget();
    expect(storage.getItem(SLOT)).toBeNull();
    expect(hl.state.trading).toBe(false);
  });
});
