import { describe, expect, it } from 'vitest';
import { checkTrigger, exitPnl, MARKET_SLIPPAGE, MIN_NOTIONAL, type HlOrder } from './hyperliquid';
import { buyingPower, planTicket, positionAfter, usdcForRisk } from './ticket';
import * as f from './format';
import { asset } from './asset';
import * as calc from './trade-calc';

/**
 * Caractérisation de la saisie du ticket de trading (Q-02 de l'audit du 20/11/2026). La logique ci-dessous est
 * recopiée telle quelle de la fermeture `setupTrading` de `trade-ui.ts` AVANT extraction : elle fixe le
 * comportement d'origine, que le module extrait doit reproduire au caractère près.
 */

const usd = (v: number) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })} USDC`;
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
const btc = (v: number) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: asset.szDecimals })} ${asset.coin}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface T {
  usdc: number;
  leverage: number;
  cross: boolean;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  unit: 'usdc' | 'btc';
  tpsl: boolean;
  reduce: boolean;
  riskPct: number;
  limitPx?: number | null;
  qty?: number | null;
  tp?: number | null;
  sl?: number | null;
}
interface S {
  mid: number | null;
  position: { size: number; entry: number; leverage: number; cross: boolean; pnl: number } | null;
  trade: { avail: [number, number]; maxSz: [number, number]; leverage: number; cross: boolean } | null;
  withdrawable: number | null;
  accountValue: number | null;
}

const ref = {
  // l. 249-276
  entryPrice: (t: T, s: S, at?: number) => at ?? (t.type === 'limit' ? (t.limitPx ?? null) : s.mid),
  refPrice: (t: T, s: S) => ref.entryPrice(t, s) ?? s.mid ?? 0,
  effectiveLeverage: (t: T, s: S) => s.position?.leverage ?? t.leverage,
  maxUsd: (t: T, s: S, buy: boolean) => {
    const px = ref.refPrice(t, s);
    const pos = s.position;
    if (t.reduce) return pos && pos.size > 0 !== buy ? Math.abs(pos.size) * px : 0;
    const tr = s.trade;
    const lev = ref.effectiveLeverage(t, s);
    if (tr) return tr.leverage === lev && px ? tr.maxSz[buy ? 0 : 1] * px : tr.avail[buy ? 0 : 1] * lev;
    return buyingPower(s.withdrawable, lev);
  },
  availUsd: (s: S, buy: boolean) => s.trade?.avail[buy ? 0 : 1] ?? s.withdrawable,
  tpOf: (t: T) => (t.tpsl && !t.reduce ? (t.tp ?? null) : null),
  slOf: (t: T) => (t.tpsl && !t.reduce ? (t.sl ?? null) : null),
  equity: (s: S) => ((s.accountValue ?? 0) > 0 ? s.accountValue : s.trade ? Math.max(...s.trade.avail) : null),
  plan: (t: T, s: S, buy: boolean, entry: number, szDecimals: number) =>
    planTicket({
      buy,
      entry,
      usdc: t.usdc,
      tp: ref.tpOf(t),
      sl: ref.slOf(t),
      accountValue: ref.equity(s),
      szDecimals,
      minNotional: MIN_NOTIONAL,
    }),
  // l. 681-685
  sizeText: (t: T, s: S, szDecimals: number) => {
    if (t.unit === 'usdc') return String(Math.round(t.usdc));
    const px = ref.refPrice(t, s);
    return px ? String(Math.floor((t.usdc / px) * 10 ** szDecimals) / 10 ** szDecimals) : '';
  },
  // l. 950-953 : null = saisie ignorée (le ticket garde sa taille)
  sizeInput: (text: string, t: T, s: S): number | null => {
    const v = +text.replace(',', '.').replace(/\s/g, '');
    if (!(v > 0)) return null;
    return t.unit === 'btc' ? v * ref.refPrice(t, s) : v;
  },
  price: (v: string) => (+v > 0 ? +v : null),
  // l. 937-938
  riskPct: (v: string): number | null => (+v > 0 ? Math.min(100, +v) : null),
  leverage: (v: string, max: number) => Math.min(max, Math.max(1, Math.round(+v || 1))),
  // l. 747
  wheelLeverage: (lev: number, dir: number, max: number) => Math.min(max, Math.max(1, lev + dir)),
  // l. 904-913 : null = toast « Indique d'abord un stop loss »
  riskSize: (t: T, s: S, buy: boolean) => {
    const entry = ref.entryPrice(t, s);
    const sl = ref.slOf(t);
    const eq = ref.equity(s);
    if (!sl || !entry || !eq) return null;
    const usdc = usdcForRisk(t.riskPct, eq, entry, sl);
    const max = ref.maxUsd(t, s, buy);
    const size = Math.max(MIN_NOTIONAL, max > 0 ? Math.min(usdc, Math.floor(max)) : usdc);
    return {
      usdc: size,
      toast:
        max > 0 && usdc > max
          ? `La taille visée (${usd(usdc)}) dépasse le maximum disponible : ramenée à ${usd(size)}. Stop trop proche pour ce risque, ou levier trop bas.`
          : null,
    };
  },
  // l. 446-465
  close: (p: { size: number; pnl: number }, m: number, fraction: number) => {
    const size = Math.abs(p.size) * fraction;
    return {
      title: fraction >= 1 ? 'Fermer la position' : `Fermer ${Math.round(fraction * 100)} % de la position`,
      rows: [
        ['Position', `${p.size > 0 ? 'Long' : 'Short'} ${usd(Math.abs(p.size) * m)}`],
        ['Ferme', `${usd(size * m)} au marché (tolérance ${MARKET_SLIPPAGE * 100} %)`],
        ['PnL latent', `${signedUsd(p.pnl)} sur toute la position`],
      ],
    };
  },
  // l. 475-499 (sans les appels réseau)
  move: (o: HlOrder, price: number, p: { size: number; entry: number } | null, m: number | null) => {
    if ((o.kind === 'tp' || o.kind === 'sl') && p && m) {
      const wrong = checkTrigger(p.size > 0, o.kind, price, m);
      if (wrong) return { problem: wrong };
    }
    const crossing = o.kind === 'limit' && m !== null && (o.buy ? price >= m : price <= m);
    const r = (at = o.price) => exitPnl(p, o, at);
    return {
      title: `Déplacer : ${o.label}`,
      rows: [
        ['De', `${f.price(o.price)}${r() !== null ? ` (${signedUsd(r()!)})` : ''}`],
        ['À', `${f.price(price)}${r(price) !== null ? ` (${signedUsd(r(price)!)} hors frais)` : ''}`],
        ['Montant', o.position ? 'toute la position' : usd(o.size * price)],
      ],
      warn: crossing ? 'Attention : à ce prix, l’ordre s’exécutera tout de suite au marché.' : '',
      tone: o.kind === 'tp' ? 'up' : o.kind === 'sl' ? 'down' : o.buy ? 'up' : 'down',
    };
  },
  // l. 503-509
  lineId: (id: string) => {
    const [k, ...rest] = id.split(':');
    return { account: Number(k), key: rest.join(':') };
  },
};

const ticket = (o: Partial<T> = {}): T => ({
  usdc: 1000,
  leverage: 5,
  cross: true,
  side: 'buy',
  type: 'market',
  unit: 'usdc',
  tpsl: false,
  reduce: false,
  riskPct: 1,
  ...o,
});
const state = (o: Partial<S> = {}): S => ({ mid: 100_000, position: null, trade: null, withdrawable: 2000, accountValue: 2000, ...o });

describe('Caractérisation du ticket (logique d’origine de trade-ui.ts)', () => {
  it('lit la taille saisie : virgule, espaces, refus des valeurs nulles ou invalides', () => {
    const t = ticket();
    const s = state();
    expect(ref.sizeInput('1 000,5', t, s)).toBe(1000.5);
    expect(ref.sizeInput('0', t, s)).toBeNull();
    expect(ref.sizeInput('-5', t, s)).toBeNull();
    expect(ref.sizeInput('', t, s)).toBeNull();
    expect(ref.sizeInput('abc', t, s)).toBeNull();
    expect(ref.sizeInput('1,000.5', t, s)).toBeNull();
    // Défaut d'origine : « Infinity » passe le contrôle `v > 0`.
    expect(ref.sizeInput('Infinity', t, s)).toBe(Infinity);
    expect(ref.sizeInput('0,01', ticket({ unit: 'btc' }), s)).toBe(1000);
    // Prix inconnu : la taille en BTC devient 0 USDC, que le plan refuse ensuite (« Montant invalide »).
    expect(ref.sizeInput('0,01', ticket({ unit: 'btc' }), state({ mid: null }))).toBe(0);
  });

  it('perd un pas de taille à l’aller-retour BTC → USDC → BTC (défaut d’origine)', () => {
    const t = ticket({ unit: 'btc' });
    const s = state();
    t.usdc = ref.sizeInput('0,0003', t, s)!;
    // 0,0003 BTC saisis à 100 000 : l'ordre préparé n'en porte que 0,00029.
    // (troncature d'origine de `planTicket`, avant la marge `SIZE_NUDGE`)
    expect(Math.floor((t.usdc / 100_000) * 1e5) / 1e5).toBe(0.00029);
    expect(ref.sizeText(t, s, 5)).toBe('0.00029');
  });

  it('borne le levier et le risque comme à l’origine', () => {
    expect(ref.leverage('', 40)).toBe(1);
    expect(ref.leverage('0', 40)).toBe(1);
    expect(ref.leverage('-3', 40)).toBe(1);
    expect(ref.leverage('2.6', 40)).toBe(3);
    expect(ref.leverage('80', 40)).toBe(40);
    expect(ref.leverage('abc', 40)).toBe(1);
    expect(ref.wheelLeverage(40, 1, 40)).toBe(40);
    expect(ref.wheelLeverage(1, -1, 40)).toBe(1);
    expect(ref.riskPct('0')).toBeNull();
    expect(ref.riskPct('150')).toBe(100);
  });

  it('plafonne la taille au risque', () => {
    const s = state({ trade: { avail: [200, 200], maxSz: [0.01, 0.01], leverage: 5, cross: true } });
    // 1 % de 2 000 avec un stop à 1 % : 2 000 USDC visés, maximum 1 000 → ramené, avec un message.
    const r = ref.riskSize(ticket({ tpsl: true, sl: 99_000 }), s, true)!;
    expect(r.usdc).toBe(1000);
    expect(r.toast).toContain('ramenée à');
    expect(ref.riskSize(ticket({ tpsl: true }), s, true)).toBeNull();
    // Petit compte : la taille visée (5 USDC) est relevée au minimum d'Hyperliquid, sans message.
    expect(ref.riskSize(ticket({ tpsl: true, sl: 90_000 }), state({ accountValue: 50 }), true)).toEqual({
      usdc: MIN_NOTIONAL,
      toast: null,
    });
  });

  it('prépare la fermeture partielle', () => {
    const c = ref.close({ size: 0.02, pnl: -12.5 }, 100_000, 0.25);
    expect(c.title).toBe('Fermer 25 % de la position');
    expect(c.rows[1][1]).toBe(`${usd(500)} au marché (tolérance 1 %)`);
    expect(ref.close({ size: -0.02, pnl: 3 }, 100_000, 1).title).toBe('Fermer la position');
  });

  it('identifie la ligne glissée', () => {
    expect(ref.lineId('1:o:123')).toEqual({ account: 1, key: 'o:123' });
  });

  it('calcule la position fusionnée', () => {
    expect(positionAfter({ size: 0.01, entry: 100_000 }, true, 0.01, 110_000)).toEqual({ size: 0.02, entry: 105_000, coherent: true });
    expect(positionAfter({ size: 0.01, entry: 100_000 }, false, 0.03, 110_000).coherent).toBe(true);
    expect(positionAfter({ size: 0.01, entry: 100_000 }, false, 0.005, 110_000).coherent).toBe(false);
  });

  it('formate comme à l’origine', () => {
    expect(shortAddr('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(signedUsd(-0.5)).toBe('−0,5 USDC');
  });
});

// ───────────── Module extrait : mêmes sorties que la logique d'origine ─────────────

const order = (o: Partial<HlOrder> = {}): HlOrder => ({
  oid: 1,
  kind: 'limit',
  buy: true,
  price: 95_000,
  size: 0.01,
  reduceOnly: false,
  position: false,
  trigger: false,
  label: 'Achat limite',
  ...o,
});
const fullPos = (o: Partial<NonNullable<S['position']>> = {}) => ({
  size: 0.01,
  entry: 100_000,
  leverage: 5,
  cross: true,
  pnl: 0,
  liquidation: null,
  roe: 0,
  margin: 200,
  value: 1000,
  ...o,
});

/** Jeu de tickets et d'états variés : chaque combinaison est passée aux deux versions. */
const tickets: T[] = [
  ticket(),
  ticket({ type: 'limit', limitPx: 98_000 }),
  ticket({ type: 'limit', limitPx: null }),
  ticket({ unit: 'btc', usdc: 2500 }),
  ticket({ reduce: true }),
  ticket({ tpsl: true, tp: 103_000, sl: 99_000 }),
  ticket({ tpsl: true, tp: 97_000, sl: 101_000, side: 'sell' }),
  ticket({ tpsl: true, sl: 99_500, riskPct: 2, leverage: 10 }),
  ticket({ usdc: 5 }),
  ticket({ usdc: 50_000, leverage: 20 }),
];
const states: S[] = [
  state(),
  state({ mid: null }),
  state({ accountValue: 0, withdrawable: 0, trade: { avail: [150, 120], maxSz: [0.0075, 0.006], leverage: 5, cross: true } }),
  state({ trade: { avail: [150, 120], maxSz: [0.0075, 0.006], leverage: 10, cross: true } }),
  state({ position: fullPos() }),
  state({ position: fullPos({ size: -0.02, leverage: 3, cross: false }) }),
  state({ withdrawable: null, accountValue: null }),
];

describe('trade-calc reproduit la logique d’origine', () => {
  it('prix, maximum, marge, valeur du compte, plan et taille au risque, sur toutes les combinaisons', () => {
    for (const t of tickets)
      for (const s of states)
        for (const buy of [true, false]) {
          expect(calc.entryPrice(t, s.mid)).toBe(ref.entryPrice(t, s));
          expect(calc.entryPrice(t, s.mid, 91_000)).toBe(ref.entryPrice(t, s, 91_000));
          expect(calc.refPrice(t, s.mid)).toBe(ref.refPrice(t, s));
          expect(calc.maxUsd(t, s, buy)).toBe(ref.maxUsd(t, s, buy));
          expect(calc.availUsd(s, buy)).toBe(ref.availUsd(s, buy));
          expect(calc.equity(s)).toBe(ref.equity(s));
          expect(calc.effectiveLeverage(t, s.position)).toBe(ref.effectiveLeverage(t, s));
          const e = ref.entryPrice(t, s);
          if (e) expect(calc.plan(t, s, buy, e, 5)).toEqual(ref.plan(t, s, buy, e, 5));
          expect(calc.sizeText(t, s.mid, 5)).toBe(ref.sizeText(t, s, 5));
          const r = ref.riskSize(t, s, buy);
          const c = calc.riskSize(t, s, buy);
          if (r === null) expect(calc.refused(c)).toBe(true);
          else if (calc.refused(c)) throw new Error(c.problem);
          else {
            expect(c.usdc).toBe(r.usdc);
            // Seul ajout : le message quand la taille est relevée au minimum d'Hyperliquid.
            expect(c.warning).toBe(r.toast ?? (c.wanted > 0 && c.usdc > c.wanted ? c.warning : null));
            if (r.toast === null && c.warning !== null) expect(c.warning).toContain('sous le minimum');
          }
        }
  });

  it('saisie de la taille : identique hors infini et hors unité de l’actif', () => {
    for (const text of ['100', '1 000,5', '0', '-5', '', 'abc', '1,000.5', '12.5', '0,01', ' 7 ', '1e3'])
      expect(calc.parseSize(text)).toBe(ref.sizeInput(text, ticket(), state()));
  });

  it('levier, risque et prix saisis', () => {
    for (const v of ['', '0', '-3', '2.4', '2.6', '80', 'abc', '40', '1'])
      for (const max of [3, 40, 50]) expect(calc.leverageInput(v, max)).toBe(ref.leverage(v, max));
    for (const [lev, dir] of [
      [40, 1],
      [1, -1],
      [5, 3],
      [5, -10],
    ])
      expect(calc.leverageStep(lev, dir, 40)).toBe(ref.wheelLeverage(lev, dir, 40));
    for (const v of ['0', '-1', '', '0.5', '150', 'x']) {
      expect(calc.riskPctInput(v)).toBe(ref.riskPct(v));
      expect(calc.priceInput(v)).toBe(ref.price(v));
    }
  });

  it('fermeture partielle : mêmes titre et lignes pour les boutons 25 %, 50 %, 100 %', () => {
    for (const p of [
      { size: 0.02, pnl: -12.5 },
      { size: -0.5, pnl: 40 },
    ])
      for (const fr of [0.25, 0.5, 1]) {
        const c = calc.closeConfirmation(asset.coin, p, 100_000, fr);
        const r = ref.close(p, 100_000, fr);
        if (calc.refused(c)) throw new Error(c.problem);
        // Seul ajout depuis l'origine : l'actif, dans le titre et en première ligne (SEC-24).
        expect(c.title).toBe(`${r.title} ${asset.coin}`);
        expect(c.rows).toEqual([['Actif', asset.coin], ...r.rows]);
      }
  });

  it('déplacement d’un ordre glissé : mêmes refus, lignes, alerte et couleur', () => {
    const orders = [
      order(),
      order({ buy: false, label: 'Vente limite' }),
      order({ kind: 'tp', buy: false, trigger: false, label: 'TP limite', price: 105_000 }),
      order({ kind: 'sl', buy: false, trigger: true, position: true, label: 'Stop loss', price: 97_000 }),
      order({ kind: 'stop', buy: true, trigger: true, label: 'Stop', price: 102_000 }),
    ];
    for (const o of orders)
      for (const price of [90_000, 99_999, 100_000, 101_000, 110_000])
        for (const p of [null, { size: 0.01, entry: 98_000 }, { size: -0.01, entry: 98_000 }])
          for (const m of [null, 100_000]) {
            const c = calc.moveConfirmation(asset.coin, o, price, p, m);
            const r = ref.move(o, price, p, m);
            if ('problem' in r) expect(c).toEqual(r);
            else
              expect(c).toEqual({
                ...r,
                title: `${r.title} ${asset.coin}`,
                rows: [['Actif', asset.coin], ...r.rows],
                ok: 'Confirmer le déplacement',
              });
          }
    expect(calc.parseLineId('1:o:123')).toEqual(ref.lineId('1:o:123'));
    expect(calc.parseLineId('0:entry')).toEqual(ref.lineId('0:entry'));
  });

  it('formateurs déplacés dans format.ts : sorties identiques au caractère près', () => {
    for (const v of [0, -0, 0.004, 1.5, -99.999, 100, 1234.56, -98_765.4, 1e7]) {
      expect(f.usdc(v)).toBe(usd(v));
      expect(f.signedUsdc(v)).toBe(signedUsd(v));
    }
    for (const v of [0, 0.00001, 0.123456, 12.5, 1234.5]) expect(f.coinQty(v)).toBe(btc(v));
    expect(f.shortAddr('0xAbCdEf0123456789abcdef0123456789ABCDEF01')).toBe(shortAddr('0xAbCdEf0123456789abcdef0123456789ABCDEF01'));
    // Espace fine insécable des milliers, espace ordinaire avant l'unité ; signe moins typographique.
    expect(f.usdc(1234.56)).toBe('1 235 USDC');
    expect(f.signedUsdc(-0.5)).toBe('−0,5 USDC');
    // `format.pct` n'est PAS le `pctText` de la carte : signé, décimales fixes, espace insécable.
    expect(f.pct(0.0123)).not.toBe(calc.pctText(0.0123));
    expect(calc.pctText(0.0123)).toBe('1,23 %');
  });

  it('reprise du ticket enregistré : identique à l’origine', () => {
    expect(calc.restoreTicket(null)).toEqual(calc.DEFAULT_TICKET);
    expect(calc.restoreTicket('{oups')).toEqual(calc.DEFAULT_TICKET);
    expect(
      calc.restoreTicket(
        JSON.stringify({ usdc: -4, riskPct: 0, side: 'x', unit: 'btc', type: 'limit', tpsl: 1, reduce: true, limitPx: 5, sl: 4 }),
      ),
    ).toEqual({
      ...calc.DEFAULT_TICKET,
      unit: 'btc',
      type: 'limit',
      tpsl: true,
    });
    // Levier enregistré (clé commune à tous les actifs) : borné au maximum du contrat affiché, jamais repris tel quel.
    expect(calc.restoreTicket(JSON.stringify({ leverage: 50 })).leverage).toBe(50);
    expect(calc.restoreTicket(JSON.stringify({ leverage: 40 }), 10).leverage).toBe(10);
    expect(calc.restoreTicket(JSON.stringify({ leverage: 3 }), 10).leverage).toBe(3);
    expect(calc.restoreTicket(JSON.stringify({ leverage: 0 }), 10).leverage).toBe(1);
    expect(calc.restoreTicket(JSON.stringify({ leverage: -7 }), 10).leverage).toBe(1);
    expect(calc.restoreTicket(JSON.stringify({ leverage: 2.6 }), 10).leverage).toBe(3);
    expect(calc.restoreTicket(JSON.stringify({ leverage: 'x' }), 3).leverage).toBe(3);
    expect(calc.restoreTicket('{oups', 3).leverage).toBe(3);
    // Rebornage quand le maximum réel du contrat est lu (40 par défaut, puis 5 pour un actif plafonné plus bas).
    expect(calc.leverageBound(calc.leverageBound(50, 40), 5)).toBe(5);
    expect(calc.leverageBound(20, 0)).toBe(1);
  });
});

// ───────────── Cas limites ─────────────

const entryInput = (o: Partial<calc.EntryInput> = {}): calc.EntryInput => ({
  buy: true,
  ticket: ticket(),
  state: { ...state(), orders: [] },
  szDecimals: 5,
  tpFull: undefined,
  builderFee: null,
  coin: asset.coin,
  ...o,
});
const prepared = (o: Partial<calc.EntryInput> = {}) => {
  const r = calc.prepareEntry(entryInput(o));
  if (calc.refused(r)) throw new Error(`refusé : ${r.problem}`);
  return r;
};
const problem = (o: Partial<calc.EntryInput> = {}) => {
  const r = calc.prepareEntry(entryInput(o));
  return calc.refused(r) ? r.problem : null;
};

describe('Cas limites de la saisie', () => {
  it('taille nulle, négative, NaN, vide, infinie : saisie ignorée', () => {
    for (const text of ['0', '-1', '-0,5', 'NaN', '', '   ', ',', 'Infinity', '1e400', '-Infinity'])
      expect(calc.parseSize(text)).toBeNull();
  });

  it('virgule décimale française et espaces (y compris insécables)', () => {
    expect(calc.parseSize('0,015')).toBe(0.015);
    expect(calc.parseSize('1 250,75')).toBe(1250.75);
    expect(calc.parseSize('1 250')).toBe(1250);
    expect(calc.parseSize('1 250')).toBe(1250);
    // Format anglo-saxon à séparateur de milliers : refusé plutôt que lu de travers.
    expect(calc.parseSize('1,250.75')).toBeNull();
    expect(calc.parseSize('1.250,75')).toBeNull();
  });

  it('DÉFAUT CORRIGÉ : la quantité saisie dans l’unité de l’actif est celle de l’ordre (aller-retour exact)', () => {
    for (const [px, k] of [
      [100_000, 5],
      [97_123.4, 5],
      [3_456.7, 4],
      [0.1234, 0],
    ] as const) {
      for (let n = 1; n < 3000; n += 7) {
        const v = n / 10 ** k;
        const t: calc.Ticket = ticket({ unit: 'btc', type: 'limit', limitPx: px });
        calc.setSize(t, v, px);
        expect(calc.plan(t, state(), true, px, k).size).toBe(v);
        expect(calc.sizeText(t, null, k)).toBe(String(v));
      }
    }
    // Le cas relevé : 0,0003 BTC à 100 000 donnaient un ordre de 0,00029.
    const t: calc.Ticket = ticket({ unit: 'btc' });
    calc.setSize(t, 0.0003, 100_000);
    expect(calc.plan(t, state(), true, 100_000, 5).size).toBe(0.0003);
    expect(t.usdc).toBeCloseTo(30, 9);
  });

  it('quantité de l’actif fixée : même quantité envoyée si le prix bouge entre la saisie et « Confirmer »', () => {
    const t: calc.Ticket = ticket({ unit: 'btc' });
    calc.setSize(t, 0.01, 100_000);
    for (const mid of [101_000, 99_000, 150_000]) {
      const e = prepared({ ticket: t, state: { ...state({ mid }), orders: [] } });
      expect(e.plan.size).toBe(0.01);
      expect(e.rows[2][1]).toBe(`${usd(0.01 * mid)} (${btc(0.01)})`);
    }
    // Prix inconnu au moment de la saisie : la quantité est gardée, l'ordre part dès que le prix est connu.
    const u: calc.Ticket = ticket({ unit: 'btc', usdc: 777 });
    calc.setSize(u, 0.02, 0);
    expect(u.usdc).toBe(777);
    expect(calc.sizeText(u, null, 5)).toBe('0.02');
    expect(prepared({ ticket: u }).plan.size).toBe(0.02);
    // Le curseur ou la taille au risque fixent la quantité une fois, au prix du moment.
    const w: calc.Ticket = ticket({ unit: 'btc' });
    calc.setUsdc(w, 500, 100_000);
    expect(prepared({ ticket: w, state: { ...state({ mid: 125_000 }), orders: [] } }).plan.size).toBe(0.005);
    // En USDC, c'est le montant qui reste fixe.
    const x: calc.Ticket = ticket();
    calc.setSize(x, 1000, 100_000);
    expect(prepared({ ticket: x, state: { ...state({ mid: 125_000 }), orders: [] } }).plan.size).toBe(0.008);
  });

  it('bascule d’unité et reprise des tickets enregistrés', () => {
    const t: calc.Ticket = ticket({ usdc: 1234 });
    calc.switchUnit(t, 100_000);
    expect(t.unit).toBe('btc');
    expect(calc.sizeText(t, 100_000, 5)).toBe('0.01234');
    calc.switchUnit(t, 200_000);
    expect(t).toMatchObject({ unit: 'usdc', qty: null, usdc: 2468 });
    // Ancien ticket enregistré en unité de l'actif, sans quantité : la taille se déduit encore du montant.
    const old = calc.restoreTicket(JSON.stringify({ unit: 'btc', usdc: 501 }));
    expect(old.qty).toBeUndefined();
    expect(calc.plan(old, state(), true, 100_000, 5).size).toBe(0.00501);
    // Ticket récent : la quantité est reprise, seulement en unité de l'actif et si elle est valide.
    expect(calc.restoreTicket(JSON.stringify({ unit: 'btc', usdc: 501, qty: 0.0042 })).qty).toBe(0.0042);
    expect(calc.restoreTicket(JSON.stringify({ unit: 'usdc', usdc: 501, qty: 0.0042 })).qty).toBeUndefined();
    expect(calc.restoreTicket(JSON.stringify({ unit: 'btc', qty: -1 })).qty).toBeUndefined();
    expect(calc.restoreTicket(JSON.stringify({ unit: 'btc', qty: 'x' })).qty).toBeUndefined();
  });

  it('DÉFAUT CORRIGÉ (audit ARC-05) : la quantité d’un autre actif n’est jamais reprise', () => {
    const doge = JSON.stringify({ coin: 'DOGE', unit: 'btc', usdc: 250, qty: 100, leverage: 3 });
    // Même actif : quantité et unité reprises.
    expect(calc.restoreTicket(doge, Infinity, 'DOGE')).toMatchObject({ unit: 'btc', qty: 100, usdc: 250 });
    // Autre actif : 100 DOGE ne devient pas 100 BTC ; le ticket repart en USDC avec son montant et son levier.
    const btc = calc.restoreTicket(doge, Infinity, 'BTC');
    expect(btc.qty).toBeUndefined();
    expect(btc).toMatchObject({ unit: 'usdc', usdc: 250, leverage: 3 });
    // Ancien ticket sans actif : la quantité est ignorée dès que l’actif affiché est connu.
    const ancien = JSON.stringify({ unit: 'btc', usdc: 501, qty: 0.0042 });
    expect(calc.restoreTicket(ancien, Infinity, 'BTC').qty).toBeUndefined();
  });

  it('DÉFAUT CORRIGÉ (planTicket) : un montant en USDC qui tombe sur un pas exact donne ce pas', () => {
    // Avant : 501 USDC à 100 000 → floor(500,99999999999994) → 0,005.
    expect(Math.floor((501 / 100_000) * 1e5) / 1e5).toBe(0.005);
    for (const [px, k] of [
      [100_000, 5],
      [97_123.4, 5],
      [3_456.7, 4],
      [0.1234, 0],
    ] as const) {
      for (let n = 1; n < 3000; n += 7) {
        const v = n / 10 ** k;
        const usdcIn = v * px;
        const p = planTicket({ buy: true, entry: px, usdc: usdcIn, szDecimals: k, minNotional: 0 });
        expect(p.size).toBe(v);
        // Jamais plus que la saisie, à la marge relative près.
        expect(p.notional).toBeLessThanOrEqual(usdcIn * (1 + 1e-9));
        // Un montant juste sous le pas suivant reste tronqué au pas inférieur.
        expect(planTicket({ buy: true, entry: px, usdc: (v + 10 ** -k) * px * (1 - 1e-6), szDecimals: k, minNotional: 0 }).size).toBe(v);
      }
    }
    expect(planTicket({ buy: true, entry: 100_000, usdc: 501, szDecimals: 5, minNotional: 10 }).size).toBe(0.00501);
  });

  it('conversion USDC → unité → USDC : stable', () => {
    const t: calc.Ticket = ticket({ unit: 'btc', usdc: 1234 });
    const shown = calc.sizeText(t, 100_000, 5);
    expect(shown).toBe('0.01234');
    calc.setSize(t, calc.parseSize(shown)!, 100_000);
    expect(calc.orderUsdc(t, 100_000)).toBeCloseTo(1234, 6);
    expect(calc.sizeText(ticket({ usdc: 1234.6 }), 100_000, 5)).toBe('1235');
  });

  it('prix de référence absent : montant nul (refusé ensuite), champ vide', () => {
    expect(calc.refPrice(ticket(), null)).toBe(0);
    expect(calc.orderUsdc({ unit: 'btc', qty: 0.01, usdc: 500 }, 0)).toBe(0);
    expect(calc.sizeText(ticket({ unit: 'btc' }), null, 5)).toBe('');
    // Ordre limite sans prix limite : le prix Hyperliquid sert de référence pour la conversion.
    expect(calc.refPrice(ticket({ type: 'limit', limitPx: null }), 90_000)).toBe(90_000);
    expect(problem({ ticket: ticket({ usdc: 0 }) })).toBe('Montant invalide.');
  });

  it('prix absent au moment d’envoyer : refus explicite, au marché comme en limite', () => {
    expect(problem({ state: { ...state({ mid: null }), orders: [] } })).toBe('Le prix Hyperliquid n’est pas encore reçu.');
    expect(problem({ ticket: ticket({ type: 'limit', limitPx: null }) })).toMatch(/^Indique un prix limite/);
    // Clic droit : le prix visé suffit, même sans prix Hyperliquid.
    expect(prepared({ at: 95_000, state: { ...state({ mid: null }), orders: [] } }).rows[3][1]).toContain('prix actuel inconnu');
  });

  it('taille sous le minimum d’Hyperliquid (10 USDC) : refusée', () => {
    expect(problem({ ticket: ticket({ usdc: 9.99 }) })).toBe(`Hyperliquid refuse les ordres de moins de ${MIN_NOTIONAL} USDC.`);
    // 10 USDC exacts à 100 000 : 0,0001 BTC, accepté.
    expect(prepared({ ticket: ticket({ usdc: 10 }) }).plan.size).toBe(0.0001);
    // 10,5 USDC à 99 999 : la troncature au pas ramène l'ordre sous 10 USDC → refusé.
    expect(problem({ ticket: ticket({ usdc: 10.5 }), state: { ...state({ mid: 99_999 }), orders: [] } })).toMatch(/moins de 10/);
  });

  it('au-delà du maximum disponible : avertissement dans la confirmation, pas de refus', () => {
    const s = { ...state({ trade: { avail: [100, 100], maxSz: [0.005, 0.005], leverage: 5, cross: true } }), orders: [] };
    expect(calc.maxUsd(ticket(), s, true)).toBe(500);
    expect(prepared({ state: s, ticket: ticket({ usdc: 510 }) }).warn).toContain('montant supérieur au maximum disponible');
    expect(prepared({ state: s, ticket: ticket({ usdc: 500 }) }).warn).not.toContain('supérieur au maximum');
  });

  it('levier hors bornes : ramené entre 1 et le maximum du contrat', () => {
    expect(calc.leverageInput('0', 40)).toBe(1);
    expect(calc.leverageInput('-10', 40)).toBe(1);
    expect(calc.leverageInput('NaN', 40)).toBe(1);
    expect(calc.leverageInput('Infinity', 40)).toBe(40);
    expect(calc.leverageInput('41', 40)).toBe(40);
    expect(calc.leverageInput('3', 3)).toBe(3);
    expect(calc.leverageStep(3, 5, 3)).toBe(3);
  });

  it('taille au risque : plafond, minimum, stop absent', () => {
    const s = state({ trade: { avail: [200, 200], maxSz: [0.01, 0.01], leverage: 5, cross: true } });
    expect(calc.riskSize(ticket({ tpsl: true, sl: 99_000 }), s, true)).toEqual({
      usdc: 1000,
      wanted: 2000,
      warning:
        'La taille visée (2 000 USDC) dépasse le maximum disponible : ramenée à 1 000 USDC. Stop trop proche pour ce risque, ou levier trop bas.',
    });
    expect(calc.riskSize(ticket({ tpsl: true, sl: 98_000 }), state(), true)).toEqual({ usdc: 1000, wanted: 1000, warning: null });
    // Taille relevée au minimum de 10 USDC : le risque réel (doublé ici) est dit.
    expect(calc.riskSize(ticket({ tpsl: true, sl: 90_000 }), state({ accountValue: 50 }), true)).toEqual({
      usdc: 10,
      wanted: 5,
      warning:
        'La taille visée (5 USDC) est sous le minimum d’Hyperliquid : relevée à 10 USDC. Perte au stop ≈ 1 USDC, soit 2 % du compte au lieu de 1 %.',
    });
    expect(calc.refused(calc.riskSize(ticket({ tpsl: false, sl: 99_000 }), s, true))).toBe(true);
    expect(calc.refused(calc.riskSize(ticket({ tpsl: true, sl: 99_000, type: 'limit', limitPx: null }), s, true))).toBe(true);
    expect(calc.refused(calc.riskSize(ticket({ tpsl: true, sl: 99_000 }), state({ accountValue: null, trade: null }), true))).toBe(true);
  });

  it('actif de l’ordre : la taille suit les décimales du contrat, pas celles de l’affichage', () => {
    // Contrat à 0 décimale (type DOGE) : 1 000 USDC à 0,1234 → 8 103 unités entières.
    expect(calc.plan(ticket(), state(), true, 0.1234, 0).size).toBe(8103);
    expect(calc.sizeText(ticket({ unit: 'btc', usdc: 1000, type: 'limit', limitPx: 0.1234 }), null, 0)).toBe('8103');
    // L'affichage de la confirmation reprend l'actif de la page (BTC ici) : c'est le seul sur lequel
    // `Hyperliquid.ready()` laisse partir un ordre.
    expect(prepared().rows[2][1]).toBe(`${usd(1000)} (${btc(0.01)})`);
  });
});

describe('Cas limites de la confirmation d’entrée', () => {
  it('ordre simple au marché', () => {
    const e = prepared();
    expect(e.title).toBe(`Acheter ${asset.coin} au marché`);
    expect(e.label).toBe('Achat au marché');
    expect(e.limit).toBe(false);
    expect(e.rows.map(r => r[0])).toEqual(['Actif', 'Sens', 'Montant', 'Prix', 'Levier', 'Marge engagée']);
    expect(e.rows[0][1]).toBe(asset.coin);
    expect(e.rows[4][1]).toBe('5× croisé (appliqué avant l’ordre)');
    expect(e.rows[5][1]).toBe(`≈ ${usd(200)} sur ${usd(2000)} disponibles`);
    expect(e.warn).toBe('Sans stop loss. Ordre réel sur Hyperliquid, exécuté immédiatement.');
    expect(e.ok).toBe('Confirmer l’achat');
  });

  it('limite au-dessus du prix pour un achat : alerte d’exécution immédiate', () => {
    const e = prepared({ at: 101_000 });
    expect(e.title).toBe(`Achat limite ${asset.coin} à ${f.price(101_000)}`);
    expect(e.warn).toMatch(/^Attention : ce prix est au-dessus du prix actuel/);
    expect(prepared({ at: 99_000 }).warn).not.toContain('au-dessus du prix actuel');
  });

  it('minimum d’Hyperliquid au-delà du risque visé : avertissement chiffré dans la confirmation', () => {
    const small = { ...state({ accountValue: 50 }), orders: [] };
    const e = prepared({ ticket: ticket({ usdc: 10, tpsl: true, sl: 90_000 }), state: small });
    expect(e.warn).toBe(
      'Attention : le minimum d’Hyperliquid (10 USDC) dépasse la taille au risque visé : perte au stop 1 USDC, soit 2 % du compte au lieu de 1 %. Ordre réel sur Hyperliquid, exécuté immédiatement.',
    );
    // Risque visé atteignable (compte plus grand) : pas d'avertissement, même pour une grosse taille choisie à la main.
    expect(prepared({ ticket: ticket({ usdc: 1000, tpsl: true, sl: 90_000 }) }).warn).not.toContain('taille au risque');
    // Sans stop : rien à chiffrer.
    expect(prepared({ ticket: ticket({ usdc: 10 }), state: small }).warn).not.toContain('taille au risque');
  });

  it('frais d’interface autorisé : ligne ajoutée', () => {
    expect(prepared({ builderFee: 10 }).rows.at(-1)).toEqual(['Frais d’interface', `0,01 %, ≈ ${usd(0.1)} à l’exécution`]);
  });

  it('position fusionnée : long + achat avec TP / SL, résultat sur toute la position', () => {
    const e = prepared({
      ticket: ticket({ tpsl: true, sl: 95_000, tp: 120_000 }),
      state: {
        ...state({ position: fullPos({ size: 0.01, entry: 90_000 }) }),
        orders: [order({ kind: 'sl', price: 85_000, label: 'Stop loss', trigger: true, position: true })],
      },
      tpFull: order({ kind: 'tp', price: 115_000, label: 'TP limite', buy: false }),
    });
    expect(e.merged).toEqual({ size: 0.02, entry: 95_000, coherent: true });
    const rows = Object.fromEntries(e.rows);
    expect(rows['Position après l’ordre']).toBe(`Long ${btc(0.02)}, entrée moyenne ≈ ${f.price(95_000)}`);
    // Stop au prix moyen : résultat nul sur toute la position (et non le risque du seul ordre ajouté).
    expect(rows['Stop loss']).toBe(`${f.price(95_000)} sur TOUTE la position (${btc(0.02)}) : +0 USDC`);
    expect(rows['Remplace']).toBe(`le stop actuel à ${f.price(85_000)}`);
    expect(rows['Take profit']).toContain(`sur toute la position hors TP partiels : ${signedUsd(500)}`);
    expect(rows['Déplace']).toBe(`le TP limite actuel à ${f.price(115_000)}`);
    expect(e.warn).toContain('une position est déjà ouverte');
  });

  it('position fusionnée : long + vente plus petite, égale ou plus grande que la position', () => {
    const st = { ...state({ position: fullPos({ size: 0.02, entry: 90_000 }) }), orders: [] };
    const sell = (usdc: number): Partial<calc.EntryInput> => ({
      buy: false,
      ticket: ticket({ side: 'sell', usdc, tpsl: true, sl: 110_000 }),
      state: st,
    });
    // Réduction (0,01 sur 0,02) puis fermeture exacte (0,02) : TP / SL du ticket incohérents → refus.
    expect(problem(sell(1000))).toMatch(/^Cet ordre réduit la position ouverte/);
    expect(problem(sell(2000))).toMatch(/^Cet ordre réduit la position ouverte/);
    // Retournement (0,03 vendus sur un long de 0,02) : short de 0,01 né au prix de l'ordre, stop sur ce short.
    const e = prepared(sell(3000));
    expect(e.merged?.size).toBeCloseTo(-0.01, 12);
    expect(e.merged?.entry).toBe(100_000);
    expect(Object.fromEntries(e.rows)['Stop loss']).toBe(
      `${f.price(110_000)} sur TOUTE la position (${btc(0.01)}) : ${signedUsd(-100)} (5 % du compte)`,
    );
    // Sans TP / SL, en limite, ou « réduire seulement » : pas de fusion.
    expect(prepared({ ...sell(1000), ticket: ticket({ side: 'sell', usdc: 1000 }) }).merged).toBeNull();
    expect(prepared({ ...sell(1000), at: 89_000 }).merged).toBeNull();
    expect(
      prepared({ ...sell(1000), ticket: ticket({ side: 'sell', usdc: 1000, reduce: true, tpsl: true, sl: 110_000 }) }).merged,
    ).toBeNull();
  });

  it('réduire seulement : ni marge engagée, ni TP / SL, ni « sans stop loss »', () => {
    const e = prepared({
      buy: false,
      ticket: ticket({ reduce: true, tpsl: true, sl: 110_000 }),
      state: { ...state({ position: fullPos() }), orders: [] },
    });
    expect(e.rows[1][1]).toBe('Vente (short), réduisant seulement');
    expect(e.rows[5][1]).toBe('aucune (réduit la position)');
    expect(e.sl).toBeNull();
    expect(e.warn).toBe('Ordre réel sur Hyperliquid, exécuté immédiatement.');
  });

  it('TP / SL du mauvais côté de l’entrée : refusé', () => {
    expect(problem({ ticket: ticket({ tpsl: true, sl: 101_000 }) })).toMatch(/au-dessous de l’entrée/);
    expect(problem({ buy: false, ticket: ticket({ tpsl: true, tp: 101_000 }) })).toMatch(/au-dessous de l’entrée/);
  });
});

describe('Cas limites de la fermeture partielle et du glisser-déposer', () => {
  const p = { size: 0.02, pnl: 5 };
  it('0 % : refusé (Hyperliquid refuserait un ordre de taille 0)', () => {
    for (const fr of [0, -0.5, NaN])
      expect(calc.closeConfirmation(asset.coin, p, 100_000, fr)).toEqual({ problem: 'Part à fermer invalide.' });
  });
  it('100 % et plus : toute la position, comme `Hyperliquid.close` l’envoie', () => {
    const all = calc.closeConfirmation(asset.coin, p, 100_000, 1);
    expect(calc.closeConfirmation(asset.coin, p, 100_000, 1.5)).toEqual(all);
    if (calc.refused(all)) throw new Error(all.problem);
    expect(all.title).toBe(`Fermer la position ${asset.coin}`);
    expect(all.rows[2][1]).toBe(`${usd(2000)} au marché (tolérance 1 %)`);
  });
  it('ordre lâché à zéro ou sous zéro : refusé', () => {
    const no = { problem: 'Prix invalide : lâche l’ordre sur un prix positif.' };
    expect(calc.moveConfirmation(asset.coin, order(), 0, null, 100_000)).toEqual(no);
    expect(
      calc.moveConfirmation(asset.coin, order({ kind: 'sl', buy: false, trigger: true }), -5, { size: 0.01, entry: 98_000 }, 100_000),
    ).toEqual(no);
  });
  it('stop d’un long glissé au-dessus du prix : refusé par le contrôle de déclenchement', () => {
    expect(
      calc.refused(
        calc.moveConfirmation(
          asset.coin,
          order({ kind: 'sl', buy: false, trigger: true }),
          101_000,
          { size: 0.01, entry: 98_000 },
          100_000,
        ),
      ),
    ).toBe(true);
  });
});

// ───────────── Garde-fous contre les fautes de frappe (23/11/2026) ─────────────

describe('Garde-fous : prix limite éloigné et taille maximale par ordre', () => {
  it('écart au prix actuel, en pourcentage signé', () => {
    expect(calc.priceGap(110_000, 100_000)).toBeCloseTo(0.1);
    expect(calc.priceGap(90_000, 100_000)).toBeCloseTo(-0.1);
    expect(calc.priceGap(0, 100_000)).toBeNull();
    expect(calc.priceGap(100, null)).toBeNull();
    expect(calc.gapText(0.125)).toBe('+12,5 %');
    expect(calc.gapText(-0.35)).toBe('−35 %');
  });

  it('jusqu’à 10 % du prix actuel : confirmation ordinaire seulement', () => {
    expect(calc.farPriceConfirmation('BTC', true, 110_000, 100_000)).toBeNull();
    expect(calc.farPriceConfirmation('BTC', false, 90_000, 100_000)).toBeNull();
    expect(prepared({ at: 95_000 }).far).toBeNull();
    // Ordre au marché : aucun prix saisi, rien à vérifier.
    expect(prepared().far).toBeNull();
  });

  it('au-delà de 10 % : confirmation renforcée qui affiche l’écart', () => {
    // Zéro de trop sur un achat : 1 000 000 au lieu de 100 000, exécution immédiate jusqu'à ce prix.
    const typo = prepared({ at: 1_000_000 }).far!;
    expect(typo.title).toBe(`Prix ${asset.coin} très éloigné du marché : +900 %`);
    expect(typo.rows).toContainEqual(['Écart', '+900 % au-dessus du prix actuel']);
    expect(typo.warn).toMatch(/s’exécuterait tout de suite/);
    expect(typo.ok).toBe('Oui, ce prix est voulu');
    // Zéro de moins sur une vente : même chose, au-dessous.
    const low = prepared({ at: 10_000, buy: false }).far!;
    expect(low.rows).toContainEqual(['Écart', '−90 % au-dessous du prix actuel']);
    expect(low.warn).toMatch(/cette vente s’exécuterait tout de suite/);
    // Achat très au-dessous : rien ne s'exécute, mais l'écart est dit aussi.
    const deep = prepared({ at: 80_000 }).far!;
    expect(deep.title).toBe(`Prix ${asset.coin} très éloigné du marché : −20 %`);
    expect(deep.warn).toMatch(/restera probablement longtemps dans le carnet/);
    // Prix limite du ticket (pas du clic droit) : même contrôle.
    expect(prepared({ ticket: ticket({ type: 'limit', limitPx: 130_000 }) }).far).not.toBeNull();
  });

  it('taille maximale par ordre : saisie lue, plancher au minimum d’Hyperliquid', () => {
    expect(calc.maxOrderInput('')).toBeNull();
    expect(calc.maxOrderInput(null)).toBeNull();
    expect(calc.maxOrderInput('0')).toBeNull();
    expect(calc.maxOrderInput('-50')).toBeNull();
    expect(calc.maxOrderInput('abc')).toBeNull();
    expect(calc.maxOrderInput('1 500,4')).toBe(1500);
    expect(calc.maxOrderInput('3')).toBe(calc.MAX_ORDER_FLOOR);
  });

  it('au-delà de la taille maximale, l’ordre est refusé avec un message ; en deçà ou sans plafond, il passe', () => {
    expect(problem({ maxOrderUsd: 500 })).toBe(
      `Ordre refusé : ${usd(1000)} dépasse ta taille maximale par ordre (${usd(500)}). Réduis la taille, ou change ce plafond dans la carte (Garde-fous).`,
    );
    expect(problem({ maxOrderUsd: 1000 })).toBeNull();
    expect(problem({ maxOrderUsd: null })).toBeNull();
    expect(problem()).toBeNull();
    // Taille saisie en unités de l'actif : c'est la valeur de l'ordre qui compte.
    expect(problem({ ticket: ticket({ unit: 'btc', qty: 0.02 }), maxOrderUsd: 1500 })).toMatch(/^Ordre refusé : /);
    expect(calc.overMaxOrder(1000, null)).toBeNull();
  });
});
