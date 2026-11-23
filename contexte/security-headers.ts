/**
 * En-têtes de sécurité de l'application en ligne, définis à un seul endroit :
 *  - la politique de sécurité du contenu (CSP) est posée deux fois, en balise meta dans index.html (elle suit la
 *    page chez n'importe quel hébergeur) et en en-tête HTTP (seul un en-tête peut interdire l'affichage dans un
 *    cadre, et il s'applique avant toute lecture de la page) ;
 *  - `dist/_headers` (Netlify, Cloudflare Pages) est écrit au build à partir d'ici (`vite.config.ts`) ;
 *  - `vercel.json` ne peut pas être généré : un test (`src/security-headers.test.ts`) vérifie qu'il dit la même chose.
 */

/** Domaines que l'application contacte (API REST et flux WebSocket des marchés). Tout autre est refusé. */
export const CONNECT = [
  'https://fapi.binance.com',
  'https://api.binance.com',
  'wss://fstream.binance.com',
  'wss://stream.binance.com',
  'wss://stream.binance.com:9443',
  'https://api.bybit.com',
  'wss://stream.bybit.com',
  'https://www.okx.com',
  'wss://ws.okx.com',
  'https://api.bitget.com',
  'wss://ws.bitget.com',
  'https://api.gateio.ws',
  'wss://fx-ws.gateio.ws',
  'https://api.hyperliquid.xyz',
  'wss://api.hyperliquid.xyz',
  'https://stats-data.hyperliquid.xyz',
  'https://api.kraken.com',
  'wss://ws.kraken.com',
  'https://api.exchange.coinbase.com',
  'wss://ws-feed.exchange.coinbase.com',
];

/**
 * Seule origine d'images tierce : les icônes publiques des actifs d'Hyperliquid (logos de la liste des actifs, des
 * favoris et des positions, `src/ui/coin-logo.ts`). Une image ne peut ni exécuter de code ni lire la page.
 */
export const IMG = ['https://app.hyperliquid.xyz'];

/**
 * Politique de sécurité du contenu. Aucun script tiers ni inline ne peut s'exécuter, et Trusted Types est bloquant :
 * aucune écriture de HTML ou d'adresse de script hors de la politique `hyperchart` (src/safe-html.ts), seule à
 * fabriquer du HTML, échappé par construction. connect-src fermé limite les destinations directes, mais il ne
 * suffirait pas si un script injecté s'exécutait malgré tout : il pourrait trader depuis la page avec l'agent
 * déverrouillé, ou faire sortir la clé dans des champs envoyés à Hyperliquid (cloid…), d'où l'importance de
 * Trusted Types. Les styles inline restent permis (positionnement calculé du graphique et des menus).
 * `header` : version envoyée en en-tête HTTP, avec les directives qu'une balise meta ne peut pas porter.
 * `extra` : adresses fixées au build, dont l'origine est ajoutée à connect-src quand elle est absolue : relais OKX
 * (`VITE_OKX_RELAY`) et serveur de données (`VITE_DATA_API`).
 */
/** Trusted Types exigé pour tous les puits de script (innerHTML, insertAdjacentHTML, adresses de script…). */
export const TRUSTED_TYPES_REQUIRE = "require-trusted-types-for 'script'";

/**
 * Seules politiques Trusted Types que la page peut créer : `hyperchart` (src/safe-html.ts, même nom que
 * `TRUSTED_TYPES_POLICY`). Aucune bibliothèque n'en crée (lightweight-charts n'écrit du HTML que pour son logo
 * d'attribution, désactivé par `attributionLogo: false` ; viem, @nktkas/hyperliquid et qrcode-generator n'écrivent
 * rien dans la page). Pas de politique `default` : elle laisserait passer n'importe quelle chaîne écrite ailleurs.
 */
export const TRUSTED_TYPES_POLICIES = ['hyperchart'] as const;

export type ExtraOrigins = string | readonly (string | undefined)[] | undefined;

export function contentPolicy(extra?: ExtraOrigins, header = false): string {
  const connect = ["'self'", ...CONNECT];
  for (const url of typeof extra === 'string' ? [extra] : (extra ?? [])) {
    if (!url || !/^https?:\/\//.test(url)) continue;
    const origin = new URL(url).origin;
    if (!connect.includes(origin)) connect.push(origin);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${IMG.join(' ')}`,
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    // Trusted Types bloquant (audit MetaMask/Hyperliquid du 23/11/2026) : aussi dans la balise meta, pour que la page
    // soit protégée chez un hébergeur qui n'enverrait pas l'en-tête (et dans `vite preview`).
    TRUSTED_TYPES_REQUIRE,
    `trusted-types ${TRUSTED_TYPES_POLICIES.join(' ')}`,
    ...(header ? ["frame-ancestors 'none'", 'upgrade-insecure-requests'] : []),
  ].join('; ');
}


/** En-têtes envoyés avec chaque réponse du site. */
export function securityHeaders(relay?: ExtraOrigins): [name: string, value: string][] {
  return [
    ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
    ['Content-Security-Policy', contentPolicy(relay, true)],
    ['X-Content-Type-Options', 'nosniff'],
    // Doublon de frame-ancestors pour les navigateurs anciens : l'interface de trading ne s'affiche dans aucun cadre.
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    // Trusted Types est désormais BLOQUANT, dans la CSP ci-dessus (audit du 23/11/2026, après le mode rapport posé le
    // même jour, E1 de docs/AUDIT-PASSAGE-A-L-ECHELLE-2026-11-23.md). Une écriture refusée déclenche toujours
    // `securitypolicyviolation`, remonté par `src/client-errors.ts`.
  ];
}

/** Cache des fichiers du build nommés par leur empreinte. */
export const ASSETS_CACHE = 'public, max-age=31536000, immutable';

/** Fichier `_headers` de Netlify et Cloudflare Pages. */
export function headersFile(relay?: ExtraOrigins): string {
  return [
    '# Netlify et Cloudflare Pages : en-têtes de sécurité et de cache.',
    '# Fichier écrit au build par vite.config.ts à partir de security-headers.ts : ne pas le modifier à la main.',
    '/*',
    ...securityHeaders(relay).map(([name, value]) => `  ${name}: ${value}`),
    '',
    '# Fichiers du build nommés par leur empreinte : cache permanent.',
    '/assets/*',
    `  Cache-Control: ${ASSETS_CACHE}`,
    '',
  ].join('\n');
}
