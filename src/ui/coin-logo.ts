// Logo d'un actif, partout où il est nommé (liste des actifs, bouton de l'en-tête, colonne des favoris, panneau des
// positions). Source : les icônes publiques d'Hyperliquid (`https://app.hyperliquid.xyz/coins/<COIN>.svg`, seule
// origine d'image tierce permise par la CSP, voir security-headers.ts). Sous l'image, une pastille ronde de couleur
// avec l'initiale : elle reste seule visible tant que l'image n'est pas chargée, et pour de bon si elle échoue
// (Hyperliquid renvoie une page HTML, pas une erreur, pour un actif sans icône : l'image ne se décode pas).
import { html, type SafeHtml } from '../safe-html';

/** Origine des icônes d'actifs (reprise telle quelle dans img-src de la CSP). */
export const LOGO_ORIGIN = 'https://app.hyperliquid.xyz';

/**
 * Nom de l'icône d'un actif : les contrats par millier (« kPEPE », « kBONK ») n'ont pas d'icône à leur nom, celle
 * de l'actif de base (« PEPE ») est la bonne. Vérifié le 21/11/2026 sur BTC, HYPE, kPEPE, kBONK, kSHIB.
 */
export function logoName(coin: string): string {
  return coin.replace(/^k(?=[A-Z0-9])/, '');
}

/** Adresse de l'icône d'un actif (nom encodé : un nom piégé ne sort pas de l'attribut ni du chemin). */
export function logoUrl(coin: string): string {
  return `${LOGO_ORIGIN}/coins/${encodeURIComponent(logoName(coin))}.svg`;
}

/** Teinte stable dérivée du nom (FNV-1a), pour la pastille de repli : un actif garde toujours sa couleur. */
export function coinHue(coin: string): number {
  let h = 0x811c9dc5;
  for (const ch of logoName(coin)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/** Icônes déjà chargées (affichées d'emblée sans pastille) ou en échec (plus redemandées pendant la session). */
const loaded = new Set<string>();
const failed = new Set<string>();

/**
 * Logo d'un actif en HTML : pastille de couleur avec l'initiale, et l'icône d'Hyperliquid par-dessus. Taille fixe
 * (`size` px) pour qu'aucun chargement ne décale la mise en page. Décoratif : le nom est toujours écrit à côté.
 */
export function coinLogoHtml(coin: string, size = 22): SafeHtml {
  const name = logoName(coin);
  const initial = name.charAt(0).toUpperCase() || '?';
  const url = logoUrl(coin);
  const img = failed.has(url)
    ? null
    : html`<img src="${url}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false" />`;
  return html`<span class="coin-logo${loaded.has(url) ? ' ok' : ''}" style="--logo-s:${size}px;--logo-h:${coinHue(coin)}" aria-hidden="true"><b>${initial}</b>${img}</span>`;
}

/**
 * Suivi des icônes : une image chargée masque la pastille (les icônes ont souvent un fond transparent), une image
 * en échec est retirée et n'est plus redemandée. Écouteurs posés une fois sur le document, en capture (ni « load »
 * ni « error » ne remontent) : aucun attribut `onerror`, que la CSP refuserait de toute façon.
 */
export function setupCoinLogos(): void {
  const icon = (e: Event) => {
    const img = e.target;
    return img instanceof HTMLImageElement && img.parentElement?.classList.contains('coin-logo') ? img : null;
  };
  document.addEventListener(
    'load',
    e => {
      const img = icon(e);
      if (!img) return;
      loaded.add(img.getAttribute('src') ?? '');
      img.parentElement!.classList.add('ok');
    },
    true,
  );
  document.addEventListener(
    'error',
    e => {
      const img = icon(e);
      if (!img) return;
      failed.add(img.getAttribute('src') ?? '');
      img.remove();
    },
    true,
  );
}
