import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTrigger, MIN_NOTIONAL, tpSplit, type HlOrder, type HlPosition } from './hyperliquid';
import * as f from './format';
import { coinQty as btc, signedUsdc as signedUsd, usdc as usd } from './format';
import { asset } from './asset';
import * as calc from './trade-calc';
import { orderTitle, tpShare } from './trade-switch';

/**
 * Audit sécurité du 22/11/2026 : SEC-24 (chaque confirmation d'ordre nomme l'actif), SEC-28 (nom de l'actif échappé
 * dans le HTML de la carte), Q-18 (part d'un TP partiel calculée une seule fois). Les confirmations du TP partiel et
 * du TP / SL, sorties de `trade-ui.ts`, sont comparées à leur logique d'origine, recopiée ci-dessous telle quelle.
 */

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
const position = (o: Partial<HlPosition> = {}): HlPosition => ({
  size: 0.02,
  entry: 100_000,
  liquidation: 80_000,
  pnl: 12,
  roe: 0.01,
  leverage: 5,
  cross: true,
  margin: 400,
  value: 2000,
  ...o,
});
const ticket = (o: Partial<calc.Ticket> = {}): calc.Ticket => ({ ...calc.DEFAULT_TICKET, usdc: 1000, ...o });
const state = (o: Partial<calc.EntryInput['state']> = {}): calc.EntryInput['state'] => ({
  mid: 100_000,
  position: null,
  trade: null,
  withdrawable: 2000,
  accountValue: 2000,
  orders: [],
  ...o,
});
const split = (orders: HlOrder[], pos: HlPosition) => tpSplit(orders, Math.abs(pos.size), 5);

/** Vérifie que la confirmation nomme l'actif dans son titre et sur sa première ligne. */
function namesAsset(c: calc.Refusal | calc.Confirmation, coin: string): calc.Confirmation {
  if (calc.refused(c)) throw new Error(`refusé : ${c.problem}`);
  expect(c.title).toContain(coin);
  expect(c.rows[0]).toEqual(['Actif', coin]);
  return c;
}

describe('SEC-24 · chaque confirmation d’ordre nomme l’actif', () => {
  // Un actif autre que celui de la page : le nom vient bien de l'ordre, pas d'un affichage global.
  for (const coin of [asset.coin, 'ETH', 'kPEPE']) {
    it(`entrées au marché et limite, ticket ou clic droit (${coin})`, () => {
      const base = { coin, ticket: ticket(), state: state(), szDecimals: 5, tpFull: undefined, builderFee: null };
      expect(namesAsset(calc.prepareEntry({ ...base, buy: true }), coin).title).toBe(`Acheter ${coin} au marché`);
      expect(namesAsset(calc.prepareEntry({ ...base, buy: false }), coin).title).toBe(`Vendre ${coin} au marché`);
      expect(namesAsset(calc.prepareEntry({ ...base, buy: true, at: 99_000 }), coin).title).toBe(
        `Achat limite ${coin} à ${f.price(99_000)}`,
      );
      namesAsset(calc.prepareEntry({ ...base, buy: false, ticket: ticket({ type: 'limit', limitPx: 101_000 }) }), coin);
      // Confirmation renforcée d'un prix limite éloigné (23/11/2026) : elle nomme l'actif aussi.
      const far = calc.prepareEntry({ ...base, buy: true, at: 1_000_000 });
      namesAsset((far as calc.EntryOrder).far!, coin);
      // Entrée avec TP / SL fusionnée à une position ouverte.
      const st = state({ position: position() });
      namesAsset(calc.prepareEntry({ ...base, state: st, buy: true, ticket: ticket({ tpsl: true, sl: 90_000, tp: 120_000 }) }), coin);
    });

    it(`fermeture totale et partielle (${coin})`, () => {
      const p = position();
      expect(namesAsset(calc.closeConfirmation(coin, p, 100_000, 1), coin).title).toBe(`Fermer la position ${coin}`);
      expect(namesAsset(calc.closeConfirmation(coin, p, 100_000, 0.25), coin).title).toBe(`Fermer 25 % de la position ${coin}`);
      namesAsset(calc.closeConfirmation(coin, p, 100_000, 0.5), coin);
    });

    it(`déplacement et annulation d’un ordre (${coin})`, () => {
      const p = position();
      for (const o of [
        order(),
        order({ kind: 'tp', buy: false, label: 'TP limite', price: 110_000, tpRole: 'full' }),
        order({ kind: 'sl', buy: false, trigger: true, position: true, label: 'Stop loss', price: 90_000 }),
      ]) {
        expect(namesAsset(calc.moveConfirmation(coin, o, o.price + 1000, p, 100_000), coin).title).toBe(`Déplacer : ${o.label} ${coin}`);
        expect(namesAsset(calc.cancelConfirmation(coin, o), coin).title).toBe(`Annuler : ${o.label} ${coin} à ${f.price(o.price)}`);
      }
    });

    it(`take profit, stop loss, stop au point mort, TP partiel (${coin})`, () => {
      const p = position();
      const base = { coin, position: p, mid: 105_000, split: split([], p), currentSl: undefined };
      expect(namesAsset(calc.protectConfirmation({ ...base, tpsl: 'tp', price: 110_000 }), coin).title).toBe(
        `Take profit ${coin} à ${f.price(110_000)}`,
      );
      expect(namesAsset(calc.protectConfirmation({ ...base, tpsl: 'sl', price: 95_000 }), coin).title).toBe(
        `Stop loss ${coin} à ${f.price(95_000)}`,
      );
      // Stop au point mort : stop loss au prix d'entrée.
      namesAsset(calc.protectConfirmation({ ...base, tpsl: 'sl', price: p.entry }), coin);
      const tp = calc.partialTpConfirmation({
        coin,
        price: 110_000,
        share: 0.25,
        position: p,
        mid: 105_000,
        szDecimals: 5,
        split: split([], p),
      });
      expect(namesAsset(tp, coin).title).toBe(`TP partiel 25 % ${coin} à ${f.price(110_000)}`);
    });
  }

  it('la fenêtre de trade-ui.ts n’est jamais ouverte sans contenu préparé par trade-calc.ts (sauf « Oublier »)', () => {
    const src = readFileSync(new URL('./trade-ui.ts', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/await confirm\(hl, ([^)\n]*)/g)].map(m => m[1]);
    // Entrée (et sa confirmation renforcée de prix éloigné, 23/11/2026), TP partiel, TP / SL, fermeture, annulation,
    // déplacement (et sa confirmation renforcée), avant l'activation et révocation (23/11/2026), puis les deux
    // fenêtres de « Oublier ».
    expect(calls).toEqual([
      'd',
      'd.far',
      'c',
      'c',
      'c',
      'calc.cancelConfirmation(coin, o, hl.state.position, activeSl(',
      'c',
      'far',
      'pre',
      'calc.revokeConfirmation(agent',
      '{',
      '{',
    ]);
    expect(src).toContain('const pre = calc.activationConfirmation(check);');
    expect(src).toContain("const far = o.kind === 'limit' ? calc.farPriceConfirmation(");
    for (const fn of [
      'prepareEntry',
      'partialTpConfirmation',
      'protectConfirmation',
      'closeConfirmation',
      'moveConfirmation',
      'farPriceConfirmation',
    ])
      expect(src).toContain(`calc.${fn}(`);
  });
});

// ───────────── Logique d'origine (trade-ui.ts avant extraction) ─────────────

type Ref = { problem: string } | { title: string; rows: [string, string][]; warn: string; tone: string; ok: string; size?: number };

function refPartialTp(p: HlPosition, m: number, price: number, share: number, szDecimals: number, orders: HlOrder[]): Ref {
  const long = p.size > 0;
  const wrong = checkTrigger(long, 'tp', price, m);
  if (wrong) return { problem: wrong };
  const k = 10 ** szDecimals;
  const pos = Math.abs(p.size);
  const { full, partialSize, partials } = tpSplit(orders, pos, szDecimals);
  const room = Math.floor((pos - partialSize) * k + 1e-6) / k;
  const size = Math.min(Math.floor(pos * share * k) / k, room);
  if (!(size > 0)) return { problem: 'Les TP partiels couvrent déjà toute la position : déplace ou annule l’un d’eux.' };
  if (size * price < MIN_NOTIONAL)
    return { problem: `Hyperliquid refuse les ordres de moins de ${MIN_NOTIONAL} USDC (${usd(size * price)} ici).` };
  const left = Math.floor((room - size) * k + 1e-6) / k;
  return {
    size,
    title: `TP partiel ${Math.round(share * 100)} % à ${f.price(price)}`,
    rows: [
      ['Position', `${long ? 'Long' : 'Short'} ${btc(pos)}, entrée ${f.price(p.entry)}`],
      [
        'Ordre',
        `limite à ${f.price(price)}, réduisant seulement, ${btc(size)} (${usd(size * price)})${size < pos * share - 1 / k ? ', limité à ce qui reste à couvrir' : ''}`,
      ],
      ['Résultat estimé', `${signedUsd((price - p.entry) * Math.sign(p.size) * size)} hors frais`],
      ...(partials.length ? [['TP partiels déjà posés', `${partials.length}, ${btc(partialSize)}`] as [string, string]] : []),
      ...(full
        ? [
            [
              'TP complet',
              left * full.price >= MIN_NOTIONAL
                ? `à ${f.price(full.price)}, ramené de ${btc(full.size)} à ${btc(left)}`
                : `à ${f.price(full.price)}, annulé : plus rien à couvrir`,
            ] as [string, string],
          ]
        : left > 0
          ? [['Reste sans TP', `${btc(left)} (pose un TP complet pour le couvrir)`] as [string, string]]
          : []),
    ],
    warn: 'Ordre réel sur Hyperliquid, ajouté aux autres TP. Partiels et TP complet ensemble ne dépassent jamais la position.',
    tone: 'up',
    ok: 'Confirmer',
  };
}

function refProtect(p: HlPosition, m: number, tpsl: 'tp' | 'sl', price: number, orders: HlOrder[], szDecimals: number): Ref {
  const long = p.size > 0;
  const wrong = checkTrigger(long, tpsl, price, m);
  if (wrong) return { problem: wrong };
  const sp = tpSplit(orders, Math.abs(p.size), szDecimals);
  if (tpsl === 'tp' && !(sp.fullSize > 0))
    return { problem: 'Les TP partiels couvrent déjà toute la position : déplace ou annule l’un d’eux.' };
  const size = tpsl === 'tp' ? sp.fullSize : Math.abs(p.size);
  const result = (price - p.entry) * Math.sign(p.size) * size;
  const existing = tpsl === 'tp' ? sp.full : orders.find(o => o.kind === 'sl');
  const beyondLiq = tpsl === 'sl' && p.liquidation !== null && (long ? price <= p.liquidation : price >= p.liquidation);
  return {
    title: `${tpsl === 'tp' ? 'Take profit' : 'Stop loss'} à ${f.price(price)}`,
    rows: [
      ['Position', `${long ? 'Long' : 'Short'} ${btc(Math.abs(p.size))} (${usd(Math.abs(p.size) * p.entry)}), entrée ${f.price(p.entry)}`],
      tpsl === 'tp'
        ? [
            'Ordre',
            `limite à ${f.price(price)}, réduisant seulement, ${btc(size)} (${usd(size * price)})${sp.partialSize > 0 ? ` : le reste après ${btc(sp.partialSize)} de TP partiels` : ''} ; exécuté à ce prix ou mieux, sans glissement`,
          ]
        : ['Déclenchement', `${f.price(price)} (mark price Hyperliquid), puis clôture au marché`],
      ['Résultat estimé', `${signedUsd(result)} hors frais`],
      ...(existing ? [[tpsl === 'tp' ? 'Déplace' : 'Remplace', `${existing.label} à ${f.price(existing.price)}`] as [string, string]] : []),
    ],
    warn: beyondLiq
      ? 'Attention : ce stop est au-delà du prix de liquidation, la position serait liquidée avant.'
      : tpsl === 'tp'
        ? 'Ordre réel sur Hyperliquid. Les TP partiels ne sont pas touchés. Si tu renforces la position, déplace le TP pour qu’il reprenne le reste. Si le prix ne fait que toucher ce niveau, l’ordre peut n’être exécuté qu’en partie.'
        : // Formulation prudente du 23/11/2026 (le stop peut être exécuté ailleurs, en partie ou pas du tout).
          'Ordre réel sur Hyperliquid, réduisant seulement la position. Déclenché sur le mark price puis exécuté au marché : le prix obtenu peut différer du stop (glissement), et l’exécution peut être partielle, voire ne pas avoir lieu dans un marché très rapide.',
    tone: tpsl === 'tp' ? 'up' : 'down',
    ok: 'Confirmer',
  };
}

/** La version extraite : la même, plus l'actif dans le titre (« … BTC à … ») et en première ligne. */
const withAsset = (r: Ref, coin: string): Ref =>
  'problem' in r ? r : { ...r, title: r.title.replace(/ à /, ` ${coin} à `), rows: [['Actif', coin], ...r.rows] };

const orderSets: HlOrder[][] = [
  [],
  [order({ kind: 'tp', buy: false, label: 'TP limite', price: 120_000, size: 0.02, tpRole: 'full' })],
  [
    order({ oid: 2, kind: 'tp', buy: false, label: 'TP partiel', price: 110_000, size: 0.005, tpRole: 'partial' }),
    order({ oid: 3, kind: 'tp', buy: false, label: 'TP limite', price: 120_000, size: 0.015, tpRole: 'full' }),
    order({ oid: 4, kind: 'sl', buy: false, trigger: true, position: true, label: 'Stop loss', price: 90_000 }),
  ],
  [order({ oid: 5, kind: 'tp', buy: false, label: 'TP partiel', price: 110_000, size: 0.02, tpRole: 'partial' })],
];
const positions = [position(), position({ size: -0.02, liquidation: 120_000 }), position({ size: 0.0003 })];

describe('TP partiel et TP / SL extraits de trade-ui.ts : mêmes refus, lignes et alertes qu’à l’origine', () => {
  it('TP partiel', () => {
    for (const p of positions)
      for (const orders of orderSets)
        for (const price of [90_000, 104_000, 110_000, 130_000])
          for (const share of [0.25, 0.33, 0.5]) {
            const c = calc.partialTpConfirmation({
              coin: asset.coin,
              price,
              share,
              position: p,
              mid: 105_000,
              szDecimals: 5,
              split: tpSplit(orders, Math.abs(p.size), 5),
            });
            expect(c).toEqual(withAsset(refPartialTp(p, 105_000, price, share, 5, orders), asset.coin));
          }
  });

  it('take profit et stop loss (dont stop au point mort et stop au-delà de la liquidation)', () => {
    for (const p of positions)
      for (const orders of orderSets)
        for (const tpsl of ['tp', 'sl'] as const)
          for (const price of [70_000, 85_000, p.entry, 104_000, 110_000, 130_000]) {
            const c = calc.protectConfirmation({
              coin: asset.coin,
              tpsl,
              price,
              position: p,
              mid: 105_000,
              split: tpSplit(orders, Math.abs(p.size), 5),
              currentSl: orders.find(o => o.kind === 'sl'),
            });
            expect(c).toEqual(withAsset(refProtect(p, 105_000, tpsl, price, orders, 5), asset.coin));
          }
  });
});

describe('SEC-28 · nom de l’actif échappé dans le HTML de la carte de trading', () => {
  // Depuis le 23/11/2026 (Trusted Types bloquant), trade-ui.ts n'écrit plus de HTML qu'avec le gabarit `html`, qui
  // échappe chaque valeur insérée (nom de l'actif, quantités, messages) : il suffit de vérifier qu'aucun gabarit HTML
  // n'y échappe et qu'aucune écriture brute ne subsiste.
  it('tout le HTML de trade-ui.ts passe par le gabarit html (échappement automatique)', () => {
    const src = readFileSync(new URL('./trade-ui.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/(?<!html)`\s*</);
    expect(src).not.toMatch(/\.innerHTML\b|insertAdjacentHTML|outerHTML/);
    expect(src).toMatch(/from '\.\/safe-html'/);
  });
});

describe('Q-18 · part d’un TP partiel : une seule implémentation', () => {
  it('tpShare : part de la position fermée par un TP limite, vide sinon', () => {
    const s = { position: position({ size: -0.04 }) };
    expect(tpShare(s, order({ kind: 'tp', size: 0.01 }))).toBe(' 25 %');
    expect(tpShare(s, order({ kind: 'tp', size: 0.08 }))).toBe(' 100 %');
    expect(tpShare(s, order({ kind: 'tp', trigger: true }))).toBe('');
    expect(tpShare(s, order({ kind: 'sl' }))).toBe('');
    expect(tpShare({ position: null }, order({ kind: 'tp' }))).toBe('');
    // Ligne du graphique et liste de la carte reprennent la même part.
    const o = order({ kind: 'tp', buy: true, size: 0.01, label: 'TP partiel', price: 90_000 });
    expect(orderTitle(s, o)).toMatch(/^TP partiel 25 % /);
    const src = readFileSync(new URL('./trade-ui.ts', import.meta.url), 'utf8');
    expect(src).toContain('${tpShare(s, o)}');
    expect(src).not.toMatch(/Math\.min\(o\.size, Math\.abs\(p\.size\)\)/);
  });
});
