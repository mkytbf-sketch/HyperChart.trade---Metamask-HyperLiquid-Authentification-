/**
 * Bouton « Connecter MetaMask » et son aide, communs à la carte provisoire (main.ts, avant le chargement du module
 * de trading) et à la carte réelle (trade-ui.ts). L'infobulle (tooltip.ts) reprend le `title` au survol ; le « ? »
 * mène à la question de la FAQ du site, qui sert aussi sur mobile, où il n'y a pas de survol.
 */
import { html, type SafeHtml } from './safe-html';
import { SITE } from './theme';

const METAMASK_HELP =
  'Connecter MetaMask donne seulement ton adresse publique : aucune signature, aucune transaction, aucun accès à tes fonds. ' +
  'Activer le trading demande ensuite une signature, affichée dans MetaMask avant validation. Elle autorise pendant 7 jours un agent à passer des ordres, sans jamais pouvoir retirer ni transférer de fonds.';

/** Question de la FAQ, sur la version française du site (Q-13). */
export const METAMASK_FAQ = `${SITE}/#metamask`;

export function connectButton(disabled = false): SafeHtml {
  return html`<button type="button" class="primary" data-act="connect" title="${METAMASK_HELP}" ${disabled && html`disabled`}>Connecter MetaMask</button>
    <a class="hl-help" href="${METAMASK_FAQ}" target="_blank" rel="noopener" title="${METAMASK_HELP}" aria-label="Sécurité de la connexion MetaMask (questions fréquentes)">?</a>`;
}

/**
 * Avertissement de risque montré à la première activation du trading, à cocher une fois par appareil (23/11/2026,
 * partie Application de docs/AUDIT-PASSAGE-A-L-ECHELLE-2026-11-23.md : aucun avertissement à l'activation). Le choix
 * est retenu dans le stockage local (`RISK_ACK_KEY`) ; `trade-ui.ts` l'affiche et le retient.
 */
export const RISK_ACK_KEY = 'strate:hl-risk-ack';

export const RISK_WARNING = [
  'Le trading de contrats perpétuels comporte un risque élevé de perte : avec l’effet de levier, une variation de prix même faible peut entraîner la liquidation de ta position et la perte de toute la marge engagée.',
  'HyperChart est une interface : elle ne fournit aucun conseil en investissement et n’exécute rien sans ta confirmation. Chaque ordre est affiché avant envoi et part sous ta seule responsabilité.',
  'N’engage que des sommes que tu peux te permettre de perdre.',
];

/** Encart de l'avertissement, avec sa case à cocher : le bouton « Continuer » ne s'active qu'une fois la case cochée. */
export function riskNotice(checked = false): SafeHtml {
  return html`<div class="hl-partner hl-risk" role="group" aria-labelledby="hl-risk-title">
    <p id="hl-risk-title"><b>Avant d’activer le trading</b></p>
    ${RISK_WARNING.map(p => html`<p>${p}</p>`)}
    <label class="hl-risk-ack"><input type="checkbox" name="riskAck" ${checked && html`checked`} /> J’ai lu et compris ces risques</label>
    <div class="hl-acts small"><button type="button" class="primary" data-act="risk-accept" ${!checked && html`disabled`}>Continuer vers la signature</button><button type="button" data-act="risk-cancel">Annuler</button></div>
  </div>`;
}
