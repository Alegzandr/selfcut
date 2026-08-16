import { describe, expect, it } from 'vitest';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ptBR from './locales/pt-BR.json';

/**
 * English is the pivot locale and the typed key set. TypeScript catches a key
 * that does not exist; nothing catches a key that exists in English and is
 * MISSING from German - i18next silently falls back and the user gets an
 * English string in the middle of their interface.
 *
 * There used to be an `npm run i18n:check` for this. It was referenced in the
 * i18n module's own comment and did not exist, which is the exact failure mode
 * a check that runs by hand always ends at. This runs with the unit suite.
 */
const LOCALES: Record<string, Record<string, string>> = { fr, es, de, 'pt-BR': ptBR };
const enKeys = Object.keys(en as Record<string, string>);

describe('locale dictionaries', () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    describe(name, () => {
      it('translates every English key', () => {
        expect(enKeys.filter((k) => !(k in dict))).toEqual([]);
      });

      it('defines no key English does not have', () => {
        const extra = Object.keys(dict).filter((k) => !(k in (en as Record<string, string>)));
        expect(extra).toEqual([]);
      });

      it('carries the same interpolation placeholders as English', () => {
        // A dropped `{{name}}` renders as a sentence with a hole in it, and no
        // type or runtime check anywhere else would notice.
        const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
        const mismatched = enKeys.filter((k) => {
          const a = placeholders((en as Record<string, string>)[k]!);
          const b = placeholders(dict[k] ?? '');
          return a.join(',') !== b.join(',');
        });
        expect(mismatched).toEqual([]);
      });

      it('leaves no string empty', () => {
        expect(enKeys.filter((k) => dict[k]!.trim() === '')).toEqual([]);
      });
    });
  }

  it('uses no em dash anywhere, in any language', () => {
    // A house rule: em dashes are banned from user-facing copy.
    const offenders: string[] = [];
    for (const [name, dict] of Object.entries({ en, ...LOCALES })) {
      for (const [k, v] of Object.entries(dict as Record<string, string>)) {
        if (v.includes('—')) offenders.push(`${name}:${k}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
