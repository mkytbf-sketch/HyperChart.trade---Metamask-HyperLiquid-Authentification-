import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExchangeClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { setVaultKeyStore } from './agent-vault';
import { memoryStorage } from './test-support/fake-socket';
import {
  describeBracket,
  describeFound,
  entryCloid,
  Hyperliquid,
  orderStatuses,
  PendingOrderError,
  PriceMovedError,
  tpCloid,
} from './hyperliquid';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ASSET = { coin: 'BTC', index: 0, szDecimals: 5, maxLeverage: 40 };

/** Réponse groupée d'Hyperliquid : entrée au carnet, TP accepté, SL refusé. */
const MIXED = {
  status: 'ok',
  response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }, 'waitingForTrigger', { error: 'Invalid TP/SL price.' }] } },
};

/** Compte prêt à trader, avec un échange et des lectures simulés. */
function account(
  ex: Partial<Record<'order' | 'cancel' | 'modify' | 'updateLeverage', (...a: unknown[]) => unknown>>,
  info: Record<string, (...a: unknown[]) => unknown> = {},
) {
  const hl = new Hyperliquid(() => {});
  const h = hl as unknown as Record<string, unknown>;
  h.exchange = ex;
  h.asset = ASSET;
  h.info = {
    clearinghouseState: async () => ({ marginSummary: { accountValue: '1000' }, withdrawable: '1000', assetPositions: [] }),
    frontendOpenOrders: async () => [],
    allMids: async () => ({ BTC: '100000' }),
    ...info,
  };
  h.lookupDelayMs = 0;
  hl.state.address = ADDRESS;
  hl.state.mid = 100_000;
  h.midAt = Date.now();
  return hl;
}

describe('T1 · réponse groupée avec un refus partiel', () => {
  it('le SDK installé lève sur un refus partiel, la réponse complète reste lisible', async () => {
    const transport = { isTestnet: false, request: async () => MIXED };
    const ex = new ExchangeClient({ transport: transport as never, wallet: privateKeyToAccount(`0x${'12'.repeat(32)}`) });
    const err = await ex
      .order({ orders: [{ a: 0, b: true, p: '100000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' })
      .catch(e => e);
    expect(err?.name).toBe('ApiRequestError');
    expect(orderStatuses(err)).toEqual(MIXED.response.data.statuses);
  });

  it('annonce l’entrée en place et nomme la protection refusée', () => {
    const text = describeBracket(MIXED.response.data.statuses, 3, true, true);
    expect(text).toMatch(/^Ordre placé dans le carnet, mais SL REFUSÉ \(Invalid TP\/SL price\.\)/);
    expect(text).toMatch(/ne la renvoie pas/);
    // Entrée au carnet : TP / SL rattachés EN ATTENTE, jamais annoncés comme une protection active (23/11/2026).
    expect(describeBracket([{ resting: { oid: 7 } }, 'waitingForTrigger'], 2, true, false)).toMatch(
      /^Ordre placé dans le carnet, avec TP rattachés EN ATTENTE : actifs seulement quand l’entrée sera entièrement exécutée/,
    );
    expect(describeBracket([{ filled: { totalSz: '0.001', avgPx: '99000' } }, 'waitingForTrigger'], 2, true, false)).toMatch(
      /avec TP rattachés$/,
    );
    expect(() => describeBracket([{ error: 'Insufficient margin' }, 'waitingForTrigger'], 2, true, false)).toThrow('Insufficient margin');
  });

  it('enter() rend l’issue réelle au lieu d’un échec global', async () => {
    const order = vi.fn(async () => {
      const e = new Error('order 2: Invalid TP/SL price.') as Error & { response: unknown };
      e.name = 'ApiRequestError';
      e.response = MIXED;
      throw e;
    });
    const hl = account({ order });
    const text = await hl.enter('BTC', true, 0.001, { price: 99_000, tp: 101_000, sl: 98_000 });
    expect(text).toMatch(/Ordre placé dans le carnet, mais SL REFUSÉ/);
    expect(order).toHaveBeenCalledTimes(1);
  });
});

describe('T2 · réponse perdue', () => {
  it('chaque entrée porte un identifiant client propre', async () => {
    expect(entryCloid()).toMatch(/^0xe17e[0-9a-f]{28}$/);
    expect(entryCloid()).not.toBe(entryCloid());
    const order = vi.fn(async (_p: unknown) => ({ response: { data: { statuses: [{ resting: { oid: 1 } }] } } }));
    await account({ order }).limit('BTC', true, 0.001, 99_000);
    expect((order.mock.calls[0][0] as { orders: { c?: string }[] }).orders[0].c).toMatch(/^0xe17e/);
  });

  it('retrouve l’ordre par son identifiant après une coupure', async () => {
    const order = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const orderStatus = vi.fn(async () => ({ status: 'order', order: { status: 'open' } }));
    const text = await account({ order }, { orderStatus }).limit('BTC', true, 0.001, 99_000);
    expect(text).toBe('Ordre placé dans le carnet (réponse perdue, ordre retrouvé)');
    expect(orderStatus).toHaveBeenCalledTimes(1);
  });

  it('bloque tout nouvel envoi tant que l’ordre n’est ni retrouvé ni écarté', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const order = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const orderStatus = vi.fn(async () => ({ status: 'unknownOid' }));
    const hl = account({ order }, { orderStatus });
    await expect(hl.limit('BTC', true, 0.001, 99_000)).rejects.toBeInstanceOf(PendingOrderError);
    expect(order).toHaveBeenCalledTimes(1);
    // Deuxième clic : rien ne part.
    await expect(hl.limit('BTC', true, 0.001, 99_000)).rejects.toBeInstanceOf(PendingOrderError);
    expect(order).toHaveBeenCalledTimes(1);
    // Échéance de l'action passée (plus la marge d'horloge), toujours inconnu : l'ordre n'a pas été reçu et ne le sera
    // plus (Hyperliquid refuse une action reçue après son échéance) : la voie est libre (23/11/2026).
    const key = 'strate:hyperliquid:intents';
    const list = JSON.parse(localStorage.getItem(key)!) as { at: number; expiresAt: number }[];
    for (const i of list) {
      i.at -= 120_000;
      i.expiresAt -= 120_000;
    }
    localStorage.setItem(key, JSON.stringify(list));
    order.mockImplementation(async () => ({ response: { data: { statuses: [{ resting: { oid: 2 } }] } } }) as never);
    await expect(hl.limit('BTC', true, 0.001, 99_000)).resolves.toBe('Ordre placé dans le carnet');
    expect(order).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('un refus explicite d’Hyperliquid n’ouvre aucune recherche', async () => {
    const order = vi.fn(async () => {
      const e = new Error('Insufficient margin');
      e.name = 'ApiRequestError';
      throw e;
    });
    const orderStatus = vi.fn();
    await expect(account({ order }, { orderStatus }).limit('BTC', true, 0.001, 99_000)).rejects.toThrow('Insufficient margin');
    expect(orderStatus).not.toHaveBeenCalled();
  });

  it('lit les états d’un ordre retrouvé', () => {
    expect(describeFound('filled')).toBe('Ordre exécuté');
    expect(describeFound('marginCanceled')).toMatch(/annulé/);
    expect(() => describeFound('perpMarginRejected')).toThrow(/refusé/);
    expect(() => describeFound('rejected')).toThrow(/refusé/);
  });
});

describe('T3 · compte relu avant chaque ordre', () => {
  it('relit position et ordres même quand le prix est frais', async () => {
    const clearinghouseState = vi.fn(async () => ({
      marginSummary: { accountValue: '1000' },
      withdrawable: '500',
      assetPositions: [
        {
          position: {
            coin: 'BTC',
            szi: '0.5',
            entryPx: '90000',
            liquidationPx: null,
            unrealizedPnl: '0',
            returnOnEquity: '0',
            leverage: { type: 'cross', value: 5 },
            marginUsed: '100',
            positionValue: '45000',
          },
        },
      ],
    }));
    const allMids = vi.fn();
    const hl = account({}, { clearinghouseState, allMids });
    await hl.fresh();
    expect(clearinghouseState).toHaveBeenCalledTimes(1);
    expect(allMids).not.toHaveBeenCalled();
    expect(hl.state.position?.size).toBe(0.5);
  });
});

describe('T4 · remplacement du take profit', () => {
  const position = async () => ({
    marginSummary: { accountValue: '1000' },
    withdrawable: '500',
    assetPositions: [
      {
        position: {
          coin: 'BTC',
          szi: '0.1',
          entryPx: '90000',
          liquidationPx: null,
          unrealizedPnl: '0',
          returnOnEquity: '0',
          leverage: { type: 'cross', value: 5 },
          marginUsed: '100',
          positionValue: '9000',
        },
      },
    ],
  });
  const raw = (oid: number, sz: number, px: number, extra: Record<string, unknown>) => ({
    coin: 'BTC',
    side: 'A',
    limitPx: String(px),
    sz: String(sz),
    oid,
    triggerPx: String(px),
    reduceOnly: true,
    isPositionTpsl: false,
    cloid: null,
    ...extra,
  });

  it('ne touche à rien si les TP partiels couvrent déjà la position', async () => {
    const cancel = vi.fn();
    const order = vi.fn();
    const orders = async () => [
      raw(1, 0.1, 95_000, { isTrigger: false, orderType: 'Limit', cloid: tpCloid('partial') }),
      raw(2, 0.1, 96_000, { isTrigger: true, orderType: 'Take Profit Market' }),
    ];
    const hl = account({ cancel, order }, { clearinghouseState: position, frontendOpenOrders: orders });
    await expect(hl.protect('BTC', 'tp', 97_000)).rejects.toThrow(/couvrent déjà/);
    expect(cancel).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();
  });

  it('pose le nouveau TP avant de retirer l’ancien TP déclenché', async () => {
    const calls: string[] = [];
    const order = vi.fn(async () => (calls.push('order'), { response: { data: { statuses: [{ resting: { oid: 9 } }] } } }));
    const cancel = vi.fn(async () => {
      calls.push('cancel');
      throw new Error('réseau');
    });
    const orders = async () => [raw(2, 0.1, 96_000, { isTrigger: true, orderType: 'Take Profit Market' })];
    const hl = account({ cancel, order }, { clearinghouseState: position, frontendOpenOrders: orders });
    const text = await hl.protect('BTC', 'tp', 97_000);
    expect(calls).toEqual(['order', 'cancel']);
    expect(text).toMatch(/TP limite de 0.1 BTC\. L’ancien TP déclenché n’a pas pu être retiré/);
  });

  it('dit quand le TP complet n’a pas pu être rétabli après un TP partiel refusé', async () => {
    const modify = vi.fn(async (p: unknown) => {
      if ((p as { order: { s: string } }).order.s === '0.1') throw new Error('réseau');
    });
    const order = vi.fn(async () => {
      const e = new Error('Too many orders');
      e.name = 'ApiRequestError';
      throw e;
    });
    const orders = async () => [raw(1, 0.1, 98_000, { isTrigger: false, orderType: 'Limit', cloid: tpCloid('full') })];
    const hl = account({ modify, order }, { clearinghouseState: position, frontendOpenOrders: orders });
    await expect(hl.partialTp('BTC', 97_000, 0.04)).rejects.toThrow(/TP complet n’a pas pu être rétabli/);
  });
});

describe('T5 · prix confirmé d’un ordre au marché (audit H-02)', () => {
  /** Compte dont le prix est périmé : `fresh()` relit un prix qui a sauté depuis la confirmation. */
  function jumped(mid: string, order: (...a: unknown[]) => unknown) {
    const hl = account({ order }, { allMids: async () => ({ BTC: mid }) });
    (hl as unknown as Record<string, unknown>).midAt = 0;
    return hl;
  }
  const FILLED = {
    status: 'ok',
    response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.001', avgPx: '100000', oid: 1 } }] } },
  };

  it('saut de prix entre la confirmation et fresh() : aucun envoi', async () => {
    const order = vi.fn(async () => FILLED);
    const hl = jumped('101000', order);
    await expect(hl.enter('BTC', true, 0.001, { expectedMid: 100_000 })).rejects.toBeInstanceOf(PriceMovedError);
    await expect(hl.enter('BTC', true, 0.001, { expectedMid: 100_000 })).rejects.toThrow(/a bougé de 1 % .*rien n’a été envoyé/);
    // Même garde sur l'ordre réduisant seulement au marché, et sur market().
    await expect(hl.enter('BTC', false, 0.001, { reduce: true, expectedMid: 100_000 })).rejects.toBeInstanceOf(PriceMovedError);
    await expect(hl.market('BTC', true, 0.001, false, 100_000)).rejects.toBeInstanceOf(PriceMovedError);
    expect(order).not.toHaveBeenCalled();
  });

  it('écart sous 0,5 % ou sans prix confirmé : l’ordre part', async () => {
    const order = vi.fn(async () => FILLED);
    await jumped('100400', order).enter('BTC', true, 0.001, { expectedMid: 100_000 });
    expect(order).toHaveBeenCalledTimes(1);
    // Appels sans prix confirmé (fermeture de position…) : comportement inchangé.
    await jumped('105000', order).market('BTC', false, 0.001, true);
    expect(order).toHaveBeenCalledTimes(2);
  });
});

describe('T6 · levier du ticket appliqué sous le verrou de l’ordre (audit M-08)', () => {
  const FILLED = {
    status: 'ok',
    response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.001', avgPx: '100000', oid: 1 } }] } },
  };
  const LEV = { leverage: 10, cross: false };

  /** Compte dont l'échange note l'ordre des appels : changement de levier, puis ordre. */
  function traced(info: Record<string, (...a: unknown[]) => unknown> = {}) {
    const calls: string[] = [];
    const updateLeverage = vi.fn(async (_p: unknown) => void calls.push('levier'));
    const order = vi.fn(async () => (calls.push('ordre'), FILLED));
    const hl = account({ order, updateLeverage }, info);
    hl.state.trade = { avail: [1000, 1000], maxSz: [1, 1], leverage: 3, cross: true };
    return { hl, calls, updateLeverage, order };
  }

  it('cas normal, au marché comme en limite : levier appliqué, puis ordre envoyé', async () => {
    const m = traced();
    await m.hl.enter('BTC', true, 0.001, { expectedMid: 100_000, leverage: LEV });
    expect(m.calls).toEqual(['levier', 'ordre']);
    expect(m.updateLeverage.mock.calls[0][0]).toEqual({ asset: 0, isCross: false, leverage: 10 });
    const l = traced();
    await l.hl.enter('BTC', true, 0.001, { price: 99_000, leverage: LEV });
    expect(l.calls).toEqual(['levier', 'ordre']);
  });

  it('ordre refusé par un contrôle préalable : levier inchangé chez Hyperliquid', async () => {
    // Prix bougé depuis la confirmation (PriceMovedError).
    const moved = traced({ allMids: async () => ({ BTC: '101000' }) });
    (moved.hl as unknown as Record<string, unknown>).midAt = 0;
    await expect(moved.hl.enter('BTC', true, 0.001, { expectedMid: 100_000, leverage: LEV })).rejects.toBeInstanceOf(PriceMovedError);
    expect(moved.calls).toEqual([]);
    // Relecture du compte impossible (fresh).
    const offline = traced({
      clearinghouseState: async () => {
        throw new Error('réseau');
      },
    });
    await expect(offline.hl.enter('BTC', true, 0.001, { expectedMid: 100_000, leverage: LEV })).rejects.toThrow(/rien n’a été envoyé/);
    expect(offline.calls).toEqual([]);
  });

  it('ordre en suspens non tranché (PendingOrderError) : levier inchangé', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    try {
      const lost = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const orderStatus = vi.fn(async () => ({ status: 'unknownOid' }));
      await expect(account({ order: lost }, { orderStatus }).limit('BTC', true, 0.001, 99_000)).rejects.toBeInstanceOf(PendingOrderError);
      const t = traced({ orderStatus });
      await expect(t.hl.enter('BTC', true, 0.001, { price: 99_000, leverage: LEV })).rejects.toBeInstanceOf(PendingOrderError);
      await expect(t.hl.enter('BTC', true, 0.001, { expectedMid: 100_000, leverage: LEV })).rejects.toBeInstanceOf(PendingOrderError);
      expect(t.calls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rien à changer : même levier, ordre réduisant seulement, ou position ouverte', async () => {
    const same = traced();
    same.hl.state.trade = { avail: [1000, 1000], maxSz: [1, 1], leverage: 10, cross: false };
    await same.hl.enter('BTC', true, 0.001, { price: 99_000, leverage: LEV });
    expect(same.calls).toEqual(['ordre']);
    const reduce = traced();
    await reduce.hl.enter('BTC', false, 0.001, { price: 101_000, reduce: true, leverage: LEV });
    expect(reduce.calls).toEqual(['ordre']);
    const open = traced({
      clearinghouseState: async () => ({
        marginSummary: { accountValue: '1000' },
        withdrawable: '500',
        assetPositions: [
          {
            position: {
              coin: 'BTC',
              szi: '0.01',
              entryPx: '90000',
              liquidationPx: null,
              unrealizedPnl: '0',
              returnOnEquity: '0',
              leverage: { type: 'cross', value: 3 },
              marginUsed: '100',
              positionValue: '900',
            },
          },
        ],
      }),
    });
    await open.hl.enter('BTC', true, 0.001, { expectedMid: 100_000, leverage: LEV });
    expect(open.calls).toEqual(['ordre']);
  });

  it('changement de levier refusé : l’ordre ne part pas', async () => {
    const t = traced();
    t.updateLeverage.mockImplementation(async () => {
      throw new Error('Cannot switch leverage type with open position');
    });
    await expect(t.hl.enter('BTC', true, 0.001, { price: 99_000, leverage: LEV })).rejects.toThrow(/Cannot switch/);
    expect(t.order).not.toHaveBeenCalled();
  });
});

describe('T7 · compte suivi changé pendant la signature MetaMask (audit M-09)', () => {
  const OK = { status: 'ok', response: { type: 'default' } };
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });

  /** MetaMask et réseau simulés ; `hook.during` est appelé quand une signature part chez Hyperliquid. */
  function setup() {
    setVaultKeyStore(null);
    vi.stubGlobal('indexedDB', undefined);
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      ethereum: {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') return [ADDRESS];
          if (method === 'wallet_getPermissions' || method === 'wallet_requestPermissions') return [];
          if (method === 'eth_chainId') return '0xa4b1';
          if (method === 'eth_signTypedData_v4') return `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
          throw new Error(method);
        },
      },
    });
    const hook = { during: () => {} };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { type?: string };
        if (String(url).endsWith('/exchange')) {
          hook.during();
          return json(OK);
        }
        if (body.type === 'extraAgents') return json([]);
        throw new Error('réseau coupé (essai)');
      }),
    );
    const hl = new Hyperliquid(() => {});
    // Autre onglet, « Oublier » ou autre compte saisi pendant que MetaMask attend.
    const switchAccount = () => void (hl as unknown as { acctGen: number }).acctGen++;
    const saved = () => (hl as unknown as { saved: Record<string, unknown> }).saved;
    return { hl, storage, hook, switchAccount, saved };
  }

  afterEach(() => {
    setVaultKeyStore(null);
    vi.unstubAllGlobals();
  });

  it('enableTrading : rien n’est enregistré, et l’erreur le dit', async () => {
    const { hl, storage, hook, switchAccount, saved } = setup();
    hook.during = switchAccount;
    await expect(hl.enableTrading()).rejects.toThrow(/autorisé pour l’ancien compte .* rien n’a été enregistré ici/);
    expect(saved().agentKey).toBeUndefined();
    expect(saved().agentAddress).toBeUndefined();
    expect(storage.getItem('strate:hyperliquid') ?? '').not.toMatch(/agent/);
    expect(hl.state.trading).toBe(false);
  });

  it('enableTrading sans changement de compte : l’agent est enregistré (témoin)', async () => {
    const { hl, saved } = setup();
    const r = await hl.enableTrading();
    expect(r.agent).toMatch(/Agent autorisé/);
    expect(saved().agentAddress).toMatch(/^0x/);
  });

  it('revokeAgent : la clé d’ici n’est pas effacée', async () => {
    const { hl, hook, switchAccount, saved } = setup();
    await hl.enableTrading();
    const agent = saved().agentAddress;
    hook.during = switchAccount;
    await expect(hl.revokeAgent()).rejects.toThrow(/compte suivi a changé pendant la signature : rien n’a été effacé ici/);
    expect(saved().agentAddress).toBe(agent);
  });
});
