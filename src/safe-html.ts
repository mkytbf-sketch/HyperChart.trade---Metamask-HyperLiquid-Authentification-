/**
 * Écriture de HTML sûre par construction, et politique Trusted Types de l'application (audit MetaMask/Hyperliquid
 * du 23/11/2026 : une XSS donnerait le contrôle du trading, Trusted Types passe donc en mode bloquant).
 *
 *  - `html`…`` est le seul moyen de fabriquer un fragment `SafeHtml` : le texte écrit dans le gabarit (par le
 *    développeur) est repris tel quel, chaque valeur interpolée est échappée (`esc`), sauf un `SafeHtml` déjà
 *    fabriqué de la même façon, qui s'imbrique tel quel. Les listes sont mises bout à bout (sans `.join('')`, qui
 *    rendrait une chaîne, donc échappée). `null`, `undefined` et `false` ne rendent rien (`${cond && html`…`}`).
 *  - `setHtml` / `insertHtml` sont les seules écritures de HTML de l'application : elles n'acceptent que `SafeHtml`
 *    (une chaîne brute est refusée au typage) et passent par la politique Trusted Types `hyperchart`.
 *  - Sans `window.trustedTypes` (Firefox ancien, tests jsdom), la valeur est écrite directement : même résultat.
 *
 * Limites, à garder en tête en écrivant un gabarit : l'échappement protège le contenu d'un élément et la valeur
 * d'un attribut ENTRE GUILLEMETS ; il ne rend pas sûre une adresse (`href="${x}"` accepterait `javascript:` : les
 * adresses interpolées sont construites par le code, jamais reprises telles quelles d'une donnée extérieure), ni un
 * attribut sans guillemets, ni un nom d'attribut ou de balise interpolé.
 *
 * Un garde-fou (`safe-html-guard.test.ts`) refuse tout `innerHTML`, `outerHTML` ou `insertAdjacentHTML` hors de ce
 * fichier.
 */

/** Échappe un texte destiné à du HTML (contenu d'un élément ou valeur d'attribut entre guillemets). */
export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let make: (html: string) => SafeHtml;

/**
 * Fragment de HTML sûr : fabriqué uniquement par `html`…`` (champ privé, constructeur privé : un objet imitant sa
 * forme n'est pas accepté au typage, et `instanceof` le refuse à l'exécution).
 */
export class SafeHtml {
  readonly #html: string;
  private constructor(value: string) {
    this.#html = value;
  }
  static {
    make = value => new SafeHtml(value);
  }
  /** Texte HTML du fragment (comparaisons, compatibilité avec les modules qui écrivent encore des chaînes). */
  toString(): string {
    return this.#html;
  }
}

/** Valeurs admises dans un gabarit `html` : texte et nombres échappés, fragments sûrs imbriqués, listes. */
export type HtmlValue = SafeHtml | string | number | bigint | null | undefined | false | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.toString();
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(render).join('');
  return esc(String(value));
}

/**
 * Gabarit étiqueté : `html`<b>${nom}</b>`` échappe `nom`. Refuse d'être appelé avec un tableau fabriqué à la main
 * (seul un vrai gabarit porte `raw`, figé), ce qui ferait passer un texte quelconque pour du code du développeur.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings)) {
    throw new TypeError('html : à appeler uniquement comme gabarit étiqueté (html`…`)');
  }
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]!) + strings[i + 1]!;
  return make(out);
}

/** Fragment vide (équivalent de html``). */
export const EMPTY_HTML = html``;

/** Assemble des fragments sûrs, séparés éventuellement par un fragment sûr. */
export function joinHtml(parts: readonly SafeHtml[], separator: SafeHtml = EMPTY_HTML): SafeHtml {
  return make(parts.map(p => p.toString()).join(separator.toString()));
}

/**
 * TEMPORAIRE : reprend tel quel du HTML produit en chaîne par un module pas encore converti (aujourd'hui
 * `tradeSvg` de trade-chart.ts, qui échappe lui-même ses textes). Le garde-fou safe-html-guard.test.ts n'admet
 * son appel que dans les fichiers de sa liste d'exceptions ; à supprimer quand ces modules rendront du `SafeHtml`.
 */
export function legacyHtml(source: string): SafeHtml {
  return make(source);
}

// ---------------------------------------------------------------------------------------------------------------
// Politique Trusted Types

/** Nom de la politique, repris dans l'en-tête `trusted-types` (security-headers.ts). */
export const TRUSTED_TYPES_POLICY = 'hyperchart';

/**
 * Scripts que la page peut charger par une adresse soumise à Trusted Types : seul le service worker des
 * notifications (`push.ts`). Toute autre adresse est refusée.
 */
export const SCRIPT_URLS: readonly string[] = ['/sw.js'];

interface TrustedPolicy {
  createHTML(input: string): unknown;
  createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createHTML: (s: string) => string; createScriptURL: (s: string) => string }): TrustedPolicy;
}

let policy: TrustedPolicy | null | undefined;

/**
 * Politique créée au premier usage. `createHTML` reprend la chaîne telle quelle : elle n'est appelée que par
 * `setHtml` / `insertHtml`, qui ne reçoivent que des `SafeHtml` (la politique elle-même n'est pas exportée).
 * Si la création échoue (politique déjà créée, nom refusé par l'en-tête), l'écriture échouera au navigateur, qui
 * refuse alors toute chaîne : on n'écrit jamais de HTML hors politique.
 */
function trustedPolicy(): TrustedPolicy | null {
  if (policy !== undefined) return policy;
  const tt = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (!tt?.createPolicy) return (policy = null);
  try {
    policy = tt.createPolicy(TRUSTED_TYPES_POLICY, {
      createHTML: s => s,
      createScriptURL: s => {
        if (!SCRIPT_URLS.includes(s)) throw new TypeError(`Adresse de script refusée : ${s}`);
        return s;
      },
    });
  } catch {
    policy = null;
  }
  return policy;
}

/** Valeur prête pour un puits HTML : TrustedHTML quand le navigateur connaît Trusted Types, chaîne sinon. */
function trustedHtml(fragment: SafeHtml): string {
  if (!(fragment instanceof SafeHtml)) throw new TypeError('setHtml : fragment SafeHtml attendu (html`…`)');
  const p = trustedPolicy();
  return (p ? p.createHTML(fragment.toString()) : fragment.toString()) as string;
}

/** Remplace le contenu d'un élément par un fragment sûr. Pour vider un élément : `el.replaceChildren()`. */
export function setHtml(el: Element, fragment: SafeHtml): void {
  el.innerHTML = trustedHtml(fragment);
}

/** Insère un fragment sûr à côté ou dans un élément (équivalent sûr de `insertAdjacentHTML`). */
export function insertHtml(el: Element, where: InsertPosition, fragment: SafeHtml): void {
  el.insertAdjacentHTML(where, trustedHtml(fragment));
}

/** Adresse d'un script autorisé (`SCRIPT_URLS`), pour `navigator.serviceWorker.register`. */
export function scriptUrl(url: string): string {
  if (!SCRIPT_URLS.includes(url)) throw new TypeError(`Adresse de script refusée : ${url}`);
  const p = trustedPolicy();
  return (p ? p.createScriptURL(url) : url) as string;
}

/** Pour les tests : oublie la politique créée (un nouvel environnement simulé peut en fournir une autre). */
export function resetPolicyForTests(): void {
  policy = undefined;
}
