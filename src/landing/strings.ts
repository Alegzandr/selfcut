import type { LangCode } from './langs';

import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';
import zhCN from './locales/zh-CN.json';

/**
 * The landing copy, one dictionary per language.
 *
 * English is the pivot: its key set is the type every other locale is checked
 * against, so a translation that forgets a key fails `npm run typecheck`
 * instead of rendering an empty heading. Keys are flat and dotted, matching
 * the editor's own dictionaries.
 */
export type LandingStrings = typeof en;

export const STRINGS = {
  en,
  fr,
  es,
  de,
  'pt-BR': ptBR,
  ja,
  'zh-CN': zhCN,
  ko,
} satisfies Record<LangCode, LandingStrings>;

export const stringsFor = (code: LangCode): LandingStrings => STRINGS[code];

/**
 * The FAQ, in page order. Shared by the FAQ section and by the FAQPage
 * structured data, which has to list exactly what the page shows.
 */
export function faqEntries(strings: LandingStrings): { question: string; answer: string }[] {
  return [
    { question: strings['faq.q1'], answer: strings['faq.a1'] },
    { question: strings['faq.q2'], answer: strings['faq.a2'] },
    { question: strings['faq.q3'], answer: strings['faq.a3'] },
    { question: strings['faq.q4'], answer: strings['faq.a4'] },
    { question: strings['faq.q5'], answer: strings['faq.a5'] },
    { question: strings['faq.q6'], answer: strings['faq.a6'] },
  ];
}
