# HyperChart — code de la connexion MetaMask, publié pour audit

_English summary below._

Ce dépôt contient **uniquement** le code de [HyperChart](https://hyperchart.trade) qui touche à ton portefeuille :
connexion MetaMask, signatures demandées, portefeuille « agent » de trading Hyperliquid, garde de sa clé, frais
d’interface et révocation. Le reste de l’application (graphiques, données de marché, compte utilisateur) n’y figure pas.

Les fichiers sont des **copies conformes** de ceux de l’application, à la date du 2026-11-24 (commit privé `11e56bbfed0bc2b300135c7d8a50fc616896bace`).
L’export refuse de produire ce dépôt si un fichier diffère de ce commit. `MANIFEST.json` donne l’empreinte SHA-256 de
chacun et signale les seules exceptions :

| Fichier                                    | Nature                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/asset.ts`                             | **Substitut** : le vrai module charge la liste des marchés et n’a aucun lien avec le portefeuille.                                                                    |
| `src/coin-picker.ts`, `src/ui/settings.ts` | **Substituts** : liste des actifs et réglages de l’interface ; seul ce que lit le panneau des positions (`rowPrice`, recopiée telle quelle ; deux champs de réglage). |
| `src/chart.ts`                             | **Extrait** : le seul type `TradeLine` (lignes des ordres), recopié de `src/chart/shared.ts`.                                                                         |
| `src/wallet.test.ts`                       | **Extrait** des tests de l’application : les blocs consacrés à MetaMask, recopiés tels quels.                                                                         |

Ce qui est à vérifier en priorité, en plus de `src/hyperliquid.ts` :

- `src/trade-calc.ts` construit le texte de **chaque fenêtre de confirmation** (titre, ligne « Actif », sens, taille,
  prix, avertissements) à partir des valeurs de l’ordre envoyé : _actif affiché = actif envoyé_
  (`src/trade-confirm-asset.test.ts`).
- `src/trade-switch.ts` : changement d’actif pendant une confirmation ou un envoi (gel, confirmation annulée).
- `src/ui/positions-panel.ts` (`renderPositions`) : chaque bouton Fermer / Point mort / Annuler porte l’actif de sa
  ligne (`src/trade-switch.test.ts`).
- `src/safe-html.ts` : seule écriture de HTML de l’application (voir « Trusted Types » ci-dessous).

## Ce que fait MetaMask dans HyperChart

| Étape                            | Appel au portefeuille                                                                             | Fenêtre MetaMask  | Ce que ça permet                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| Connecter                        | `eth_requestAccounts`, `wallet_getPermissions` (et `wallet_requestPermissions` pour un 2ᵉ compte) | Choix du compte   | Lire ton adresse publique. Aucune signature, aucune transaction.                                          |
| Activer le trading               | `eth_signTypedData_v4` — type `HyperliquidTransaction:ApproveAgent`                               | Signature EIP-712 | Autoriser **pendant 7 jours** une clé « agent » créée dans ton navigateur à passer et annuler des ordres. |
| Frais d’interface (si configuré) | `eth_signTypedData_v4` — type `HyperliquidTransaction:ApproveBuilderFee`                          | Signature EIP-712 | Autoriser Hyperliquid à prélever le frais d’interface affiché, au plus au taux signé.                     |
| Oublier / révoquer               | `eth_signTypedData_v4` — `ApproveAgent` d’un agent jetable                                        | Signature EIP-712 | Remplacer l’agent par un agent dont la clé est jetée : l’ancienne clé ne signe plus rien.                 |
| —                                | `eth_chainId`                                                                                     | aucune            | Lire le réseau pour construire la signature.                                                              |

**Jamais demandé** : `eth_sendTransaction`, `personal_sign`, transfert, retrait, approbation de jeton, changement de
réseau. Un agent Hyperliquid ne peut **ni retirer ni transférer** de fonds (règle du protocole, pas de HyperChart).

À vérifier dans le code : `metamaskSigner`, `permittedAccounts`, `pickAccounts`, `connect`, `connectedOwner`,
`enableTrading`, `approveBuilder`, `revokeAgent`, `revokeNamedAgent` (tous dans `src/hyperliquid.ts`).

## La clé de l’agent

- Créée dans le navigateur (`generatePrivateKey` de viem) au moment d’activer le trading ; **jamais envoyée** au
  serveur de HyperChart ni ailleurs. Seules les signatures d’ordres partent, vers `api.hyperliquid.xyz`.
- Gardée dans le `localStorage`, **chiffrée** en AES-GCM 256 bits (`src/agent-vault.ts`). La clé de chiffrement est une
  clé WebCrypto **non exportable** conservée dans IndexedDB ; le texte chiffré est lié à son emplacement (donnée
  authentifiée). Sans WebCrypto ou IndexedDB (certains modes privés), la clé reste en clair et l’interface le dit.
- Validité de **7 jours** inscrite chez Hyperliquid dans le nom de l’agent (`valid_until`) : passé ce délai, elle ne
  signe plus rien, même volée.
- « Oublier » révoque l’agent chez Hyperliquid avant d’effacer la clé locale.

### Limites connues (modèle de menace)

- Le chiffrement protège une copie isolée du stockage local, d’une sauvegarde ou une extension qui lit le stockage ;
  pas la copie du profil complet du navigateur.
- Il **ne protège pas** contre un script qui s’exécuterait dans la page (XSS, dépendance compromise). Un tel script
  agit avec les droits de l’application : il peut **trader directement depuis la page** avec l’agent déverrouillé
  (ordres défavorables, donc perte du solde), et il peut **faire sortir la clé** malgré `connect-src` fermé, par
  exemple en l’encodant dans des champs publics des requêtes envoyées à Hyperliquid (identifiant client `cloid` d’un
  ordre, nom d’agent…), lisibles ensuite par n’importe qui. `connect-src` ne limite que les destinations directes.
- Les défenses portent donc sur l’**injection** elle-même :
  - CSP sans script tiers ni inline (`script-src 'self'`, `object-src 'none'`, `base-uri 'self'`) ;
  - **Trusted Types bloquant** (`require-trusted-types-for 'script'; trusted-types hyperchart`) : le navigateur refuse
    toute écriture de HTML (`innerHTML`, `insertAdjacentHTML`…) ou d’adresse de script qui ne passe pas par la seule
    politique de l’application, `hyperchart` (`src/safe-html.ts`). Elle n’accepte que des fragments fabriqués par le
    gabarit `html`…``, qui échappe chaque valeur interpolée ; aucune politique `default`. Un navigateur qui n’applique pas Trusted Types
    garde le même code échappé, sans le blocage par le navigateur ;
  - durée limitée de l’agent (7 jours), révocation par « Oublier ».
- Qui détient la clé de l’agent ne peut pas retirer de fonds, mais peut **trader** pour le compte, donc lui faire
  perdre son solde par des ordres défavorables.
- Le frais d’interface et le code de parrainage sont fixés au build (`src/partner.ts`, `contexte/.env.example`) ; le
  taux maximal est celui que tu signes dans MetaMask.

## Vérifier soi-même

Node 24 ou plus :

```sh
npm ci
npm run verify   # empreintes de MANIFEST.json
npm run check    # compilation TypeScript stricte
npm test         # tests (aucun appel réseau, aucune vraie clé)
```

Les commentaires renvoient parfois à des documents internes (`docs/…`, audits datés) qui ne sont pas publiés ici ;
le code et ses commentaires se suffisent pour l’audit.

`src/trade-ui.ts` (l’interface qui déclenche chaque signature) est publié pour la lecture et lu par un test, mais exclu
de la compilation (`tsconfig.json`) : il dépend du reste de l’application. `contexte/` contient la politique de sécurité
du contenu (`security-headers.ts`) et les variables du frais d’interface, également non compilées.

## Vérifier que le site en ligne sert ce code

Le build de l’application est reproductible : deux builds du même commit, avec les mêmes versions de Node et de npm,
le même `package-lock.json` et les mêmes variables `VITE_*`, donnent des fichiers identiques octet pour octet (aucune
date de build, aucun chemin de la machine). Chaque déploiement publie son manifeste d’empreintes :
`https://app.hyperchart.trade/build-manifest.json` (commit, versions de Node et npm, empreinte du lockfile, variables
`VITE_*`, SHA-256 de chaque fichier publié). Le code de l’application entière n’étant pas public, la reconstruction
elle-même est faite par qui a accès au dépôt privé (auditeur mandaté) ; la comparaison des fichiers servis, elle, est
à la portée de tous.

1. **Reconstruire depuis le commit indiqué** (accès au dépôt privé ; Node et npm aux versions du manifeste) :

   ```sh
   git clone <dépôt privé> hyperchart && cd hyperchart
   git -c core.autocrlf=false checkout <commit du manifeste>
   git tag -v <tag de la version>          # tag signé, voir plus bas
   cd app && npm ci
   npm run build                           # écrit dist/ et dist/build-manifest.json
   ```

   `"arbreModifie": false` doit figurer dans le manifeste publié : sinon la version en ligne a été construite depuis des
   fichiers non commités et ne peut pas être reproduite.

2. **Comparer ses empreintes au manifeste publié** :

   ```sh
   node tools/empreintes-build.mjs --comparer https://app.hyperchart.trade/build-manifest.json dist
   ```

3. **Comparer aux fichiers réellement servis** (le script lit les pages et chaque fichier `assets/…` qu’elles
   référencent, et compare leurs octets au build local) :

   ```sh
   node tools/empreintes-build.mjs --comparer https://app.hyperchart.trade dist
   ```

   Sans le dépôt privé, les mêmes contrôles à la main contre le manifeste publié :

   ```sh
   curl -s https://app.hyperchart.trade/build-manifest.json -o manifest.json
   curl -s https://app.hyperchart.trade/index.html -o index.html && sha256sum index.html
   grep -o 'assets/[^"]*' index.html | sort -u | while read f; do
     curl -s "https://app.hyperchart.trade/$f" | sha256sum | sed "s|-|$f|"
   done                                    # chaque empreinte doit être celle de manifest.json
   ```

   Le code du portefeuille publié ici se retrouve, minifié mais non obscurci, dans ces fichiers `assets/*.js`.

### Commits et tags signés

Chaque version déployée porte un tag git **signé** (`v2026.11.23-1`, …) sur le commit indiqué dans son manifeste ;
`git tag -v` en vérifie la signature avec la clé publique de l’éditeur (publiée sur son compte GitHub). Un tag non
signé ou un commit différent de celui du manifeste est un écart à signaler.

## Signaler une faille

Voir [SECURITY.md](SECURITY.md).

---

## English summary

This repository publishes, for audit only, the parts of HyperChart that interact with your wallet. Files are verbatim
copies of the production source (see `MANIFEST.json` for SHA-256 hashes; `src/asset.ts` is a stub and
`src/wallet.test.ts` an excerpt).

- **Connect** only reads your public address (`eth_requestAccounts`). No signature, no transaction.
- **Enable trading** asks for one EIP-712 signature (`HyperliquidTransaction:ApproveAgent`) authorising, for 15 days,
  an agent key generated in your browser. Hyperliquid agents can place and cancel orders but **cannot withdraw or
  transfer funds**. An optional second signature (`ApproveBuilderFee`) authorises the displayed interface fee.
- The agent key never leaves the browser; it is stored AES-GCM-encrypted with a non-extractable WebCrypto key held
  in IndexedDB. This does not protect against script injection in the page (mitigated by a strict CSP and the
  15-day expiry).
- **Never requested**: `eth_sendTransaction`, `personal_sign`, transfers, withdrawals, token approvals.
- **Threat model**: a script running in the page (XSS, compromised dependency) could trade from the page with the
  unlocked agent and could exfiltrate the agent key through public request fields such as an order `cloid`, despite
  the closed `connect-src`. Defences target injection itself: strict CSP and **enforced Trusted Types**
  (`trusted-types hyperchart`; all HTML goes through the auto-escaping `html` template of `src/safe-html.ts`).
- **Verifiable build**: the build is reproducible; each deployment publishes `/build-manifest.json` (commit, Node/npm
  versions, lockfile hash, SHA-256 of every served file). Compare with `tools/empreintes-build.mjs --comparer` or
  `curl … | sha256sum`. Deployed versions carry a signed git tag.

Run `npm ci && npm run verify && npm run check && npm test`. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md). Code comments are in French.
