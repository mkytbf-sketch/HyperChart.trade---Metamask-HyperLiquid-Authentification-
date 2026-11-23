import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_HTML, html, insertHtml, joinHtml, resetPolicyForTests, SafeHtml, scriptUrl, setHtml, TRUSTED_TYPES_POLICY } from './safe-html';

/** Élément simulé : seules les écritures de HTML comptent ici. */
const fakeEl = () => {
  const el = { innerHTML: '' as unknown, inserted: [] as [string, unknown][] } as unknown as Element & { inserted: [string, unknown][] };
  (el as unknown as { insertAdjacentHTML: (w: string, v: unknown) => void }).insertAdjacentHTML = (w, v) => void el.inserted.push([w, v]);
  return el;
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetPolicyForTests();
});

describe('gabarit html', () => {
  it('échappe chaque interpolation de texte, dans le contenu comme dans un attribut', () => {
    const nom = `<img src=x onerror='alert(1)'> & "co"`;
    expect(String(html`<b title="${nom}">${nom}</b>`)).toBe(
      '<b title="&lt;img src=x onerror=&#39;alert(1)&#39;&gt; &amp; &quot;co&quot;">&lt;img src=x onerror=&#39;alert(1)&#39;&gt; &amp; &quot;co&quot;</b>',
    );
    expect(String(html`<i>${42}</i><i>${10n}</i>`)).toBe('<i>42</i><i>10</i>');
  });

  it('imbrique tel quel un fragment déjà sûr, sans double échappement', () => {
    const inner = html`<em>${'a & b'}</em>`;
    expect(String(html`<p>${inner}</p>`)).toBe('<p><em>a &amp; b</em></p>');
    expect(String(html`<p>${html`<span>${inner}</span>`}</p>`)).toBe('<p><span><em>a &amp; b</em></span></p>');
  });

  it('met les listes bout à bout et ignore null, undefined et false', () => {
    const items = ['<x>', 'y'].map(t => html`<li>${t}</li>`);
    expect(String(html`<ul>${items}</ul>`)).toBe('<ul><li>&lt;x&gt;</li><li>y</li></ul>');
    expect(String(html`[${null}${undefined}${false}${''}]`)).toBe('[]');
    // Un .join('') rend une chaîne : elle est échappée, jamais reprise comme HTML.
    expect(String(html`${items.join('')}`)).toBe('&lt;li&gt;&amp;lt;x&amp;gt;&lt;/li&gt;&lt;li&gt;y&lt;/li&gt;');
  });

  it('joinHtml et EMPTY_HTML', () => {
    expect(String(joinHtml([html`<a>`, html`<b>`], html`, `))).toBe('<a>, <b>');
    expect(String(EMPTY_HTML)).toBe('');
  });

  it('refuse un faux gabarit (tableau fabriqué à la main) et un objet imitant SafeHtml', () => {
    const forged = ['<img src=x onerror=alert(1)>'] as unknown as TemplateStringsArray;
    expect(() => html(forged)).toThrow(TypeError);
    const fake = { toString: () => '<img src=x onerror=alert(1)>' } as unknown as SafeHtml;
    expect(String(html`${fake as unknown as string}`)).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(() => setHtml(fakeEl(), fake)).toThrow(TypeError);
  });

  it('refuse une chaîne brute au typage', () => {
    const el = fakeEl();
    // @ts-expect-error une chaîne n'est pas un SafeHtml
    expect(() => setHtml(el, '<b>brut</b>')).toThrow(TypeError);
    // @ts-expect-error idem pour insertHtml
    expect(() => insertHtml(el, 'beforeend', '<b>brut</b>')).toThrow(TypeError);
    // @ts-expect-error un objet de même forme n'est pas un SafeHtml (champ privé)
    const imitation: SafeHtml = { toString: () => '' };
    expect(imitation).toBeDefined();
  });
});

describe('écriture et politique Trusted Types', () => {
  it('sans trustedTypes (jsdom, Firefox ancien) : écrit la chaîne du fragment', () => {
    const el = fakeEl();
    setHtml(el, html`<b>${'<i>'}</b>`);
    expect(el.innerHTML).toBe('<b>&lt;i&gt;</b>');
    insertHtml(el, 'afterend', html`<hr>`);
    expect(el.inserted).toEqual([['afterend', '<hr>']]);
    expect(scriptUrl('/sw.js')).toBe('/sw.js');
  });

  it('avec trustedTypes : une seule politique, « hyperchart », par laquelle passe chaque écriture', () => {
    const created: string[] = [];
    let rules: { createHTML: (s: string) => string; createScriptURL: (s: string) => string } | undefined;
    vi.stubGlobal('trustedTypes', {
      createPolicy: (name: string, r: typeof rules) => {
        created.push(name);
        rules = r;
        return { createHTML: (s: string) => ({ trusted: r!.createHTML(s) }), createScriptURL: (s: string) => ({ url: r!.createScriptURL(s) }) };
      },
    });
    const el = fakeEl();
    setHtml(el, html`<b>${'x'}</b>`);
    setHtml(el, html`<i>y</i>`);
    expect(created).toEqual([TRUSTED_TYPES_POLICY]);
    expect(el.innerHTML).toEqual({ trusted: '<i>y</i>' });
    expect(scriptUrl('/sw.js')).toEqual({ url: '/sw.js' });
    expect(() => scriptUrl('https://evil.example/x.js')).toThrow(TypeError);
    expect(() => rules!.createScriptURL('/autre.js')).toThrow(TypeError);
  });
});
