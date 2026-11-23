import { describe, expect, it, vi } from 'vitest';
import { Hyperliquid, parseOrders, protectCloid, protectionResizes, tpCloid } from './hyperliquid';

type Raw = Parameters<typeof parseOrders>[0][number];
const base = {
  coin: 'BTC',
  side: 'A' as const,
  triggerPx: '0',
  reduceOnly: true,
  isPositionTpsl: false,
  cloid: null,
} satisfies Partial<Raw>;
/** TP limite (réduisant seulement) d'un long. */
const tpLimit = (oid: number, sz: number, px: number, cloid: string | null = null): Raw => ({
  ...base,
  oid,
  sz: String(sz),
  limitPx: String(px),
  isTrigger: false,
  orderType: 'Limit',
  cloid,
});
/**
 * TP ou SL déclenché d'un long, de taille fixe (posé avec une entrée limite) ou rattaché à la position. Posé par
 * HyperChart par défaut (identifiant client propre) : seuls ceux-là sont recalés (23/11/2026).
 */
const trig = (oid: number, sz: number, px: number, kind: 'tp' | 'sl', o: Partial<Raw> = {}): Raw => ({
  ...base,
  oid,
  sz: String(sz),
  limitPx: String(px),
  isTrigger: true,
  triggerPx: String(px),
  orderType: kind === 'tp' ? 'Take Profit Limit' : 'Stop Market',
  cloid: protectCloid(kind),
  ...o,
});

describe('recalage des TP / SL sur la position', () => {
  it('agrandit le TP complet et le SL de taille fixe quand un long renforce la position', () => {
    // Position de 0,1 BTC portée à 0,3 BTC par un long exécuté.
    const orders = parseOrders([tpLimit(1, 0.1, 70_000, tpCloid('full')), trig(2, 0.1, 60_000, 'sl')]);
    const r = protectionResizes(orders, 0.3, 5);
    expect(r.map(x => [x.order.oid, x.size])).toEqual([
      [1, 0.3],
      [2, 0.3],
    ]);
  });

  it('garde la taille des TP partiels et donne le reste au TP complet', () => {
    const orders = parseOrders([tpLimit(1, 0.06, 70_000, tpCloid('full')), tpLimit(2, 0.04, 68_000, tpCloid('partial'))]);
    const r = protectionResizes(orders, 0.2, 5);
    expect(r).toHaveLength(1);
    expect(r[0].order.oid).toBe(1);
    expect(r[0].size).toBeCloseTo(0.16, 9);
  });

  it('ne touche pas un SL rattaché à la position (Hyperliquid le fait suivre)', () => {
    const orders = parseOrders([trig(1, 0.1, 60_000, 'sl', { isPositionTpsl: true })]);
    expect(protectionResizes(orders, 0.3, 5)).toEqual([]);
  });

  it('ne propose rien quand les tailles sont déjà justes', () => {
    const orders = parseOrders([tpLimit(1, 0.3, 70_000, tpCloid('full')), trig(2, 0.3, 60_000, 'sl')]);
    expect(protectionResizes(orders, 0.3, 5)).toEqual([]);
  });

  it('réduit le TP complet quand la position est allégée, sans rétrécir un SL', () => {
    const orders = parseOrders([tpLimit(1, 0.3, 70_000, tpCloid('full')), trig(2, 0.3, 60_000, 'sl')]);
    const r = protectionResizes(orders, 0.2, 5);
    expect(r.map(x => [x.order.oid, x.size])).toEqual([[1, 0.2]]);
  });

  it('suit un short : seuls les ordres d’achat ferment la position', () => {
    const buy = { side: 'B' as const };
    const orders = parseOrders([
      { ...tpLimit(1, 0.1, 55_000, tpCloid('full')), ...buy },
      trig(2, 0.1, 65_000, 'sl', buy),
      trig(3, 0.1, 50_000, 'sl'),
    ]);
    const r = protectionResizes(orders, -0.25, 5);
    expect(r.map(x => [x.order.oid, x.size])).toEqual([
      [1, 0.25],
      [2, 0.25],
    ]);
  });

  it('retient le type d’exécution d’un ordre déclenché', () => {
    const [tp, sl] = parseOrders([trig(1, 0.1, 70_000, 'tp'), trig(2, 0.1, 60_000, 'sl')]);
    expect(tp.market).toBe(false);
    expect(sl.market).toBe(true);
  });

  it('ne propose rien sans position, ni sous le montant minimal', () => {
    const orders = parseOrders([tpLimit(1, 0.1, 70_000, tpCloid('full'))]);
    expect(protectionResizes(orders, 0, 5)).toEqual([]);
    expect(protectionResizes(orders, 0.0001, 5)).toEqual([]);
  });
});

describe('recalage automatique sur le compte', () => {
  const ASSET = { coin: 'BTC', index: 0, szDecimals: 5, maxLeverage: 40 };
  /** Compte prêt à trader : position de `szi` BTC et ordres ouverts simulés. */
  function account(szi: string, open: Raw[], modify: (...a: unknown[]) => unknown) {
    const hl = new Hyperliquid(() => {});
    const h = hl as unknown as Record<string, unknown>;
    h.exchange = { modify };
    h.asset = ASSET;
    const position = {
      coin: 'BTC',
      szi,
      entryPx: '65000',
      liquidationPx: null,
      unrealizedPnl: '0',
      returnOnEquity: '0',
      leverage: { type: 'cross', value: 5 },
      marginUsed: '100',
      positionValue: '1000',
    };
    h.info = {
      clearinghouseState: async () => ({ marginSummary: { accountValue: '10000' }, withdrawable: '1000', assetPositions: [{ position }] }),
      frontendOpenOrders: async () => open,
      allMids: async () => ({ BTC: '65000' }),
    };
    hl.state.address = '0x1111111111111111111111111111111111111111';
    hl.state.mid = 65_000;
    h.midAt = Date.now();
    return hl;
  }

  it('modifie le TP et le SL à la taille relue de la position, en gardant leurs prix', async () => {
    const modify = vi.fn(async (_p: unknown) => ({}));
    const hl = account('0.3', [tpLimit(1, 0.1, 70_000, tpCloid('full')), trig(2, 0.1, 60_000, 'sl')], modify);
    const said = vi.fn();
    hl.onProtectSync = said;
    await hl.syncProtections();
    const calls = modify.mock.calls.map(c => c[0] as { oid: number; order: { s: string; b: boolean; r: boolean; t: unknown; p: string } });
    expect(calls.map(c => [c.oid, c.order.s])).toEqual([
      [1, '0.3'],
      [2, '0.3'],
    ]);
    // Ordres de vente réduisant seulement ; le TP limite reste au même prix, le SL au même déclenchement.
    expect(calls.every(c => c.order.b === false && c.order.r === true)).toBe(true);
    expect(calls[0].order.p).toBe('70000');
    expect(calls[1].order.t).toEqual({ trigger: { isMarket: true, triggerPx: '60000', tpsl: 'sl' } });
    expect(said).toHaveBeenCalledWith(expect.stringMatching(/recalées sur la position de 0\.3/), true);
  });

  it('dit un refus et ne le retente pas en boucle', async () => {
    const modify = vi.fn(async () => {
      throw new Error('Order not found');
    });
    const hl = account('0.3', [trig(2, 0.1, 60_000, 'sl')], modify);
    const said = vi.fn();
    hl.onProtectSync = said;
    await hl.syncProtections();
    await hl.syncProtections();
    expect(modify).toHaveBeenCalledTimes(1);
    expect(said).toHaveBeenCalledWith(expect.stringMatching(/Recalage impossible : SL \(Order not found\)/), false);
  });

  it('ne fait rien sans trading activé', async () => {
    const modify = vi.fn();
    const hl = account('0.3', [trig(2, 0.1, 60_000, 'sl')], modify);
    (hl as unknown as Record<string, unknown>).exchange = null;
    await hl.syncProtections();
    expect(modify).not.toHaveBeenCalled();
  });
});
