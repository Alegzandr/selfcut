import type { LangCode } from './langs';

import de from '../i18n/locales/de.json';
import en from '../i18n/locales/en.json';
import es from '../i18n/locales/es.json';
import fr from '../i18n/locales/fr.json';
import ja from '../i18n/locales/ja.json';
import ko from '../i18n/locales/ko.json';
import ptBR from '../i18n/locales/pt-BR.json';
import zhCN from '../i18n/locales/zh-CN.json';

/**
 * The *editor's* dictionaries, read by the landing.
 *
 * The hero draws a replica of the editor, and the replica's chrome is labelled
 * with the strings the editor labels itself with: the menu titles, the export
 * presets, the inspector rows. Two upsides over retyping them into the landing
 * dictionary: the replica is translated into all eight languages for free, and
 * a label that changes in the app changes here too instead of quietly turning
 * the landing into a picture of a version that no longer ships.
 *
 * Deliberately the JSON, not `src/i18n/index.ts`: importing that module boots
 * i18next as a side effect, which is not something a build-time page render
 * should do (same reasoning as `langs.ts`).
 */
export type AppStrings = typeof en;

const APP_STRINGS = {
  en,
  fr,
  es,
  de,
  'pt-BR': ptBR,
  ja,
  'zh-CN': zhCN,
  ko,
} satisfies Record<LangCode, AppStrings>;

export const appStringsFor = (code: LangCode): AppStrings => APP_STRINGS[code];
