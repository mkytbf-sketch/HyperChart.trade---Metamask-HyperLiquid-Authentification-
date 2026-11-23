import { describe, expect, it } from 'vitest';
import { parseOrders, tpCloid, tpSplit } from './hyperliquid';

const raw = (oid: number, sz: number, px: number, cloid?: string) => ({
  coin: 'BTC',
  side: 'A' as const,
  limitPx: String(px),
  sz: String(sz),
  oid,
  isTrigger: false,
  triggerPx: '0',
  orderType: 'Limit',
  reduceOnly: true,
  isPositionTpsl: false,
  cloid: cloid ?? null,
});

describe('TP complet et TP partiels', () => {
  it('reconnaît le rôle d’un TP par son identifiant client', () => {
    const full = tpCloid('full');
    const part = tpCloid('partial');
    expect(full).toMatch(/^0x[0-9a-f]{32}$/);
    const [a, b] = parseOrders([raw(1, 0.06, 70_000, full), raw(2, 0.04, 68_000, part)]);
    expect(a).toMatchObject({ kind: 'tp', tpRole: 'full', label: 'TP limite' });
    expect(b).toMatchObject({ kind: 'tp', tpRole: 'partial', label: 'TP partiel' });
  });

  it('donne au TP complet le reste de la position après les partiels', () => {
    const orders = parseOrders([
      raw(1, 0.06, 70_000, tpCloid('full')),
      raw(2, 0.025, 68_000, tpCloid('partial')),
      raw(3, 0.015, 69_000, tpCloid('partial')),
    ]);
    const s = tpSplit(orders, 0.1, 5);
    expect(s.full?.oid).toBe(1);
    expect(s.partials.map(o => o.oid)).toEqual([2, 3]);
    expect(s.partialSize).toBeCloseTo(0.04, 9);
    expect(s.fullSize).toBeCloseTo(0.06, 9);
  });

  it('reprend un ancien TP sans marque comme TP complet s’il couvre le reste', () => {
    const legacy = parseOrders([raw(1, 0.1, 70_000)]);
    expect(tpSplit(legacy, 0.1, 5).full?.oid).toBe(1);
    // Petit TP sans marque, loin de couvrir la position : c'est un partiel.
    const small = tpSplit(parseOrders([raw(1, 0.02, 70_000)]), 0.1, 5);
    expect(small.full).toBeUndefined();
    expect(small.fullSize).toBeCloseTo(0.08, 9);
  });

  it('ne laisse rien au TP complet quand les partiels couvrent tout', () => {
    const s = tpSplit(parseOrders([raw(1, 0.05, 68_000, tpCloid('partial')), raw(2, 0.05, 69_000, tpCloid('partial'))]), 0.1, 5);
    expect(s.fullSize).toBe(0);
  });
});
