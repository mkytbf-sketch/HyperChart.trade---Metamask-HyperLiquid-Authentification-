import { afterEach, describe, expect, it, vi } from 'vitest';
import { BTC_SPEC, setAsset, type AssetSpec } from './asset';
import { CoinChangedError, Hyperliquid } from './hyperliquid';
import { createConfirm, TradeGate, tradeLines } from './trade-switch';
import { memoryStorage } from './test-support/fake-socket';

// Lot 2 du changement d'actif à chaud (docs/CHANGEMENT-ACTIF-A-CHAUD.md, § 3) : garanties du trading pendant et
// après une bascule. Aucune ne doit dépendre de l'interface : elles sont tenues par le compte (`Hyperliquid`) et
// par les pièces de trade-switch.ts.

const ADDRESS = '0x1111111111111111111111111111111111111111';
const BTC_ASSET = { coin: 'BTC', index: 0, szDecimals: 5, maxLeverage: 40 };
const ETH: AssetSpec = { ...BTC_SPEC, coin: 'ETH', base: 'ETH', name: 'Ether', digits: 2, szDecimals: 4, px: 0.01, qty: 30 };
const UNIVERSE = [
  { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
  { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
];

const ok = (statuses: unknown[]) => ({ status: 'ok', response: { type: 'order', data: { statuses } } });

const position = (coin: string, szi: string, entryPx: string) => ({
  position: {
    coin,
    szi,
    entryPx,
    liquidationPx: null,
    unrealizedPnl: '0',
    returnOnEquity: '0',
    leverage: { type: 'cross', value: 5 },
    marginUsed: '100',
    positionValue: '1000',
  },
});

const rawOrder = (coin: string, oid: number, limitPx: string) => ({
  coin,
  side: 'A' as const,
  limitPx,
  sz: '0.1',
  oid,
  isTrigger: false,
  triggerPx: '0',
  orderType: 'Limit',
  reduceOnly: false,
  isPositionTpsl: false,
});

/** Compte prêt à trader sur le BTC, avec un échange et des lectures simulés (comme trade-safety.test.ts). */
function account(
  ex: Partial<Record<'order' | 'cancel' | 'modify' | 'updateLeverage', (...a: unknown[]) => unknown>>,
  info: Record<string, (...a: unknown[]) => unknown> = {},
) {
  const hl = new Hyperliquid(() => {});
  const h = hl as unknown as Record<string, unknown>;
  h.exchange = ex;
  h.asset = BTC_ASSET;
  h.info = {
    clearinghouseState: async () => ({ marginSummary: { accountValue: '1000' }, withdrawable: '1000', assetPositions: [] }),
    frontendOpenOrders: async () => [],
    allMids: async () => ({ BTC: '100000', ETH: '3000' }),
    meta: async () => ({ universe: UNIVERSE }),
    userFills: async () => [],
    ...info,
  };
  h.lookupDelayMs = 0;
  hl.state.address = ADDRESS;
  hl.state.mid = 100_000;
  h.midAt = Date.now();
  return hl;
}

afterEach(() => {
  setAsset(BTC_SPEC);
  vi.unstubAllGlobals();
});

describe('garde : un ordre ne part que sur l’actif affiché', () => {
  it('refuse un ordre visant un autre actif que celui affiché, avant tout envoi', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const order = vi.fn(async () => ok([{ resting: { oid: 1 } }]));
    const hl = account({ order });
    await expect(hl.limit('ETH', true, 0.1, 3000)).rejects.toBeInstanceOf(CoinChangedError);
    await expect(hl.cancel('ETH', { oid: 1 } as never)).rejects.toBeInstanceOf(CoinChangedError);
    expect(order).not.toHaveBeenCalled();
    // Même actif que le compte, mais l'actif affiché a changé (bascule en cours) : refusé aussi.
    setAsset(ETH);
    await expect(hl.limit('BTC', true, 0.001, 99_000)).rejects.toBeInstanceOf(CoinChangedError);
    expect(order).not.toHaveBeenCalled();
  });

  it('refuse l’envoi si l’actif change pendant la relecture du compte (dernier contrôle avant envoi)', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const order = vi.fn(async () => ok([{ filled: { totalSz: '0.001', avgPx: '100000' } }]));
    let release!: () => void;
    const clearinghouseState = vi.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve({ marginSummary: { accountValue: '1000' }, withdrawable: '1000', assetPositions: [] });
        }),
    );
    const hl = account({ order }, { clearinghouseState });
    const sent = hl.market('BTC', true, 0.001);
    await vi.waitFor(() => expect(clearinghouseState).toHaveBeenCalled());
    // Pendant la relecture : l'interface passe à l'ETH.
    setAsset(ETH);
    release();
    await expect(sent).rejects.toBeInstanceOf(CoinChangedError);
    expect(order).not.toHaveBeenCalled();
  });

  it('après setCoin, l’ordre de l’ancien actif est refusé ; celui du nouvel actif part avec son contrat', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const order = vi.fn(async (_p: unknown) => ok([{ resting: { oid: 2 } }]));
    const hl = account({ order });
    setAsset(ETH);
    await hl.setCoin('ETH');
    await expect(hl.limit('BTC', true, 0.001, 99_000)).rejects.toBeInstanceOf(CoinChangedError);
    expect(order).not.toHaveBeenCalled();
    await hl.limit('ETH', true, 0.1, 3000);
    expect(order).toHaveBeenCalledTimes(1);
    const sentOrder = (order.mock.calls[0][0] as { orders: { a: number; s: string }[] }).orders[0];
    expect(sentOrder.a).toBe(1); // rang de l'ETH dans la liste d'Hyperliquid
    expect(sentOrder.s).toBe('0.1');
    expect(hl.state.maxLeverage).toBe(25);
  });
});

describe('gel : confirmation ouverte annulée', () => {
  /** Fenêtre et boutons factices (EventTarget) : `showModal` ouvre, `close` ferme et émet « close » plus tard. */
  function parts() {
    const dialog = Object.assign(new EventTarget(), {
      open: false,
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        queueMicrotask(() => dialog.dispatchEvent(new Event('close')));
      },
    });
    const okBtn = new EventTarget();
    const cancel = Object.assign(new EventTarget(), { focus() {} });
    return { dialog, ok: okBtn, cancel };
  }

  it('freeze (cancelOpen) résout la confirmation ouverte à « annulé » et ferme la fenêtre', async () => {
    const p = parts();
    const confirm = createConfirm(p as never);
    const asked = confirm.ask();
    expect(p.dialog.open).toBe(true);
    confirm.cancelOpen();
    await expect(asked).resolves.toBe(false);
    expect(p.dialog.open).toBe(false);
    // Un clic tardif sur « Confirmer » ne change rien.
    p.ok.dispatchEvent(new Event('click'));
    await expect(asked).resolves.toBe(false);
  });

  it('sans gel, « Confirmer » confirme (comportement inchangé)', async () => {
    const p = parts();
    const confirm = createConfirm(p as never);
    const asked = confirm.ask();
    p.ok.dispatchEvent(new Event('click'));
    await expect(asked).resolves.toBe(true);
    confirm.cancelOpen(); // plus rien d'ouvert : sans effet
  });
});

describe('bascule pendant un envoi : elle attend la fin de l’envoi', () => {
  it('drain attend l’entrée au marché puis son SL et son TP, qui partent sur l’actif confirmé', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    let releaseEntry!: () => void;
    const calls: string[] = [];
    const order = vi.fn((p: unknown) => {
      const grouping = (p as { grouping: string }).grouping;
      calls.push(grouping);
      if (calls.length === 1)
        return new Promise(resolve => (releaseEntry = () => resolve(ok([{ filled: { totalSz: '0.001', avgPx: '100000' } }]))));
      return Promise.resolve(ok([grouping === 'positionTpsl' ? 'waitingForTrigger' : { resting: { oid: 9 } }]));
    });
    const hl = account({ order });
    const entry = hl.enter('BTC', true, 0.001, { tp: 105_000, sl: 95_000 });
    await vi.waitFor(() => expect(order).toHaveBeenCalledTimes(1));
    let drained = false;
    const drain = hl.drain().then(() => (drained = true));
    await new Promise(r => setTimeout(r, 20));
    expect(drained).toBe(false);
    // Gelé : une nouvelle action ne commence pas.
    await expect(hl.limit('BTC', true, 0.001, 99_000)).rejects.toBeInstanceOf(CoinChangedError);
    releaseEntry();
    await expect(entry).resolves.toMatch(/SL posé · TP limite posé/);
    await drain;
    expect(drained).toBe(true);
    // Entrée, SL et TP : trois envois, tous sur le contrat de l'actif confirmé (BTC, rang 0).
    expect(order).toHaveBeenCalledTimes(3);
    for (const [p] of order.mock.calls) expect((p as { orders: { a: number }[] }).orders.every(o => o.a === 0)).toBe(true);
    hl.unfreeze();
  });

  it('TradeGate : gel, puis attente des actions confirmées avant celle des comptes', async () => {
    const gate = new TradeGate();
    let finish!: () => void;
    const job = gate.track(new Promise<void>(r => (finish = r)));
    const order: string[] = [];
    const accounts = [{ drain: async () => void order.push('compte'), unfreeze: () => void order.push('dégel') }];
    const drained = gate.drain(accounts).then(() => order.push('fin'));
    expect(gate.frozen).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual([]);
    finish();
    await job;
    await drained;
    expect(order).toEqual(['compte', 'fin']);
    gate.resume(accounts);
    expect(gate.frozen).toBe(false);
    expect(order).toEqual(['compte', 'fin', 'dégel']);
  });
});

describe('bascule abandonnée ou retenue : jamais de gel pour de bon', () => {
  it('bascule abandonnée pendant l’attente des actions confirmées : les comptes ne restent pas gelés', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const order = vi.fn(async (_p: unknown) => ok([{ resting: { oid: 3 } }]));
    const hl = account({ order });
    const gate = new TradeGate();
    // Action confirmée encore en cours : l'attente de la bascule n'est pas instantanée.
    let finish!: () => void;
    void gate.track(new Promise<void>(r => (finish = r)));
    const drained = gate.drain([hl]);
    expect(gate.frozen).toBe(true);
    // Bascule abandonnée (actif inconnu, ou actif affiché rechoisi) avant la fin de l'action.
    gate.resume([hl]);
    finish();
    await drained;
    expect(gate.frozen).toBe(false);
    expect(hl.frozen).toBe(false);
    await hl.limit('BTC', true, 0.001, 99_000);
    expect(order).toHaveBeenCalledTimes(1);
  });

  it('une action du compte (fenêtre MetaMask ouverte) ne retient pas la bascule ; un ordre, si', async () => {
    const gate = new TradeGate();
    const accounts = [{ drain: async () => {}, unfreeze: () => {} }];
    void gate.track(new Promise<void>(() => {}), 'account');
    expect(gate.busy).toBe(false);
    const outcome = await Promise.race([gate.drain(accounts).then(() => 'fini'), new Promise(r => setTimeout(() => r('bloqué'), 50))]);
    expect(outcome).toBe('fini');
    gate.resume(accounts);
    // Contrôle : un envoi d'ordre, lui, est attendu.
    void gate.track(new Promise<void>(() => {}));
    const held = await Promise.race([gate.drain(accounts).then(() => 'fini'), new Promise(r => setTimeout(() => r('bloqué'), 50))]);
    expect(held).toBe('bloqué');
  });
});

describe('contrat illisible après setCoin', () => {
  it('relu en arrière-plan à la première action refusée ; l’action suivante part sur le bon contrat', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order = vi.fn(async (_p: unknown) => ok([{ resting: { oid: 4 } }]));
    let down = true;
    const meta = vi.fn(async () => {
      if (down) throw new Error('réseau coupé');
      return { universe: UNIVERSE };
    });
    const hl = account({ order }, { meta });
    setAsset(ETH);
    await hl.setCoin('ETH');
    expect(hl.state.error).toMatch(/Lecture du contrat ETH impossible/);
    down = false;
    await expect(hl.limit('ETH', true, 0.1, 3000)).rejects.toThrow(/en cours de lecture/);
    expect(order).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hl.state.error).toBeNull());
    await hl.limit('ETH', true, 0.1, 3000);
    expect(order).toHaveBeenCalledTimes(1);
    expect((order.mock.calls[0][0] as { orders: { a: number }[] }).orders[0].a).toBe(1);
    // Une seule relecture à la fois, et plus aucune une fois le contrat chargé.
    expect(meta).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('après setCoin : rien de l’ancien actif', () => {
  it('prix, position, ordres et lignes de l’ancien actif ont disparu ; le recalage prévu est annulé', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const modify = vi.fn();
    const hl = account({ modify });
    const h = hl as unknown as Record<string, (...a: unknown[]) => void>;
    h.applyClearinghouse({
      marginSummary: { accountValue: '1000' },
      withdrawable: '1000',
      assetPositions: [position('BTC', '0.5', '90000'), position('ETH', '-2', '3100')],
    });
    h.applyOrders([rawOrder('BTC', 1, '95000'), rawOrder('ETH', 2, '2900')]);
    hl.state.trading = true;
    // Un recalage TP / SL était prévu pour la position BTC.
    (hl as unknown as { syncTimer: unknown }).syncTimer = setTimeout(() => void modify('recalage BTC'), 30);
    const before = tradeLines([hl], { up: 'u', down: 'd', blue: 'b' }, () => '');
    expect(before.map(l => l.price)).toEqual([90_000, 95_000]);
    expect(before.every(l => l.coin === 'BTC')).toBe(true);

    setAsset(ETH);
    const switching = hl.setCoin('ETH');
    // Tout de suite, avant même la lecture du contrat : plus de prix ni de ligne BTC.
    expect(hl.state.mid).toBeNull();
    expect(hl.state.position?.size).toBe(-2);
    expect(hl.state.orders.map(o => o.oid)).toEqual([2]);
    expect(hl.state.otherOrders.map(o => o.coin)).toEqual(['BTC']);
    const after = tradeLines([hl], { up: 'u', down: 'd', blue: 'b' }, () => '');
    expect(after.map(l => l.price)).toEqual([3100, 2900]);
    expect(after.every(l => l.coin === 'ETH')).toBe(true);
    await switching;
    await new Promise(r => setTimeout(r, 50));
    expect(modify).not.toHaveBeenCalled();
    expect(hl.state.positions.map(p => p.coin)).toEqual(['BTC', 'ETH']);
  });

  it('un prix de l’ancien actif arrivé pendant la relecture n’est pas retenu', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    let answer!: (v: unknown) => void;
    const allMids = vi.fn(() => new Promise(r => (answer = r)));
    const hl = account({}, { allMids });
    (hl as unknown as { midAt: number }).midAt = 0; // prix périmé : relu
    const fresh = hl.fresh();
    await vi.waitFor(() => expect(allMids).toHaveBeenCalled());
    setAsset(ETH);
    void hl.setCoin('ETH');
    answer({ BTC: '100000', ETH: '3000' });
    await expect(fresh).rejects.toThrow(/actif changé/);
    expect(hl.state.mid).toBeNull();
  });
});

describe('boutons du panneau des positions : actif porté par chaque bouton d’action', () => {
  it('fermeture, point mort et annulation portent data-coin de leur ligne', async () => {
    const { positionsHtml } = await import('./ui/positions-panel');
    const { parseOrders } = await import('./hyperliquid');
    const h = positionsHtml({
      account: 'C1',
      trading: true,
      busy: false,
      shownCoin: 'BTC',
      positions: [{ coin: 'BTC', size: 1, entry: 100, liquidation: null, pnl: 0, roe: 0, leverage: 5, cross: true, margin: 1, value: 100 }],
      orders: parseOrders([rawOrder('BTC', 7, '110')], 'BTC'),
      otherOrders: [],
      breakeven: true,
      accountValue: 1000,
      marginUsed: 1,
    });
    for (const attr of ['data-close="0.25"', 'data-close="1"', 'data-act="breakeven"'])
      expect(h.positions).toMatch(new RegExp(`${attr} data-coin="BTC"`));
    expect(h.orders).toContain('data-cancel="7" data-coin="BTC"');
  });
});
