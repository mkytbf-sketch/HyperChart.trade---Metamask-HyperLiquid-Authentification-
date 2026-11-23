// Clés du stockage local lues ou écrites par plusieurs modules. Elles sont écrites une seule fois ici : une faute de
// frappe dans l'une des copies faisait lire une clé vide, sans erreur (réglages, compte ou session perdus en silence).
// Ces valeurs sont déjà chez les utilisateurs : les changer revient à oublier leurs données.

/** Réglages de l'application (unité de temps, thème, indicateurs…), synchronisés avec le compte. */
export const SETTINGS_KEY = 'strate.settings.v2';

/**
 * Comptes Hyperliquid (adresse suivie, clé de l'agent), un par emplacement ; la première clé est celle de l'ancien
 * compte unique, reprise telle quelle.
 */
export const HL_SLOT_KEYS: readonly string[] = ['strate:hyperliquid', 'strate:hyperliquid:2'];

/** Préférences de la vue Compte (adresse analysée, période, courbe, actif…). */
export const ACCOUNT_PREFS_KEY = 'strate:account-prefs';

/** État de la synchronisation avec le compte (adresse e-mail, version, changements pas encore envoyés). */
export const SYNC_STATE_KEY = 'strate:sync';

/**
 * Adresses reprises de l'ancienne vue Explorateur (retirée le 22/11/2026) : la vue Compte les propose toujours dans
 * sa liste des comptes suivis. Tableau JSON d'adresses (0x et 40 caractères hexadécimaux).
 */
export const ACCOUNT_FOLLOWED_KEY = 'strate:account-followed';

/**
 * Notes de l'actif (zone de notes par-dessus le graphique) : clé de base, suffixée par l'actif comme les tracés
 * (`strate.notes.v1@ETH` ; celle du BTC sans suffixe). Elles suivent le compte, comme les tracés (sync.ts).
 */
export const NOTES_BASE = 'strate.notes.v1';

/** Fenêtre des notes : position, taille et état ouvert ou fermé, propres à cet appareil (non synchronisés). */
export const NOTES_PANEL_KEY = 'strate:notes-panel';
