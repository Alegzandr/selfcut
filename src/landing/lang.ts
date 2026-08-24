// Footer language selector + first-visit language redirect for the landing
// pages. Shares the `selfcut.lang` localStorage key with the editor, so
// picking a language here also switches the app, and vice versa. The key is
// spelled out rather than imported from `src/i18n`, which would boot i18next
// and its eight dictionaries into a page that has no use for them.

import { LANGS, type LangCode } from './langs';

const KEY = 'selfcut.lang';

const html = document.documentElement;

/** Map a BCP 47 tag to a supported locale, mirroring the app's detection. */
function resolve(tag: string | null | undefined): LangCode | null {
  if (!tag) return null;
  const exact = LANGS.find((lang) => lang.code === tag);
  if (exact) return exact.code;
  const base = tag.toLowerCase().split('-')[0];
  if (base === 'pt') return 'pt-BR';
  if (base === 'zh') return 'zh-CN';
  return LANGS.find((lang) => lang.code.toLowerCase() === base)?.code ?? null;
}

// Language dialog, opened from the footer button. Native <dialog> handles
// Escape, focus and the backdrop; clicking the backdrop closes it too.
const dialog = document.querySelector<HTMLDialogElement>('.lang-dialog');
document.querySelector('[data-lang-open]')?.addEventListener('click', () => dialog?.showModal());
document.querySelector('[data-lang-close]')?.addEventListener('click', () => dialog?.close());
dialog?.addEventListener('click', (event) => {
  // The body wrapper fills the dialog, so the dialog element itself is only
  // hit when the click lands on the backdrop.
  if (event.target === dialog) dialog.close();
});

// Remember explicit choices made in the dialog. The navigation to the picked
// language's page proceeds normally.
for (const link of document.querySelectorAll<HTMLAnchorElement>('.lang-dialog a[data-lang]')) {
  link.addEventListener('click', () => {
    const lang = link.dataset.lang;
    if (!lang) return;
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      // Storage unavailable (private mode): the navigation still works.
    }
  });
}

// Only the default (root) page redirects, so language pages reached through a
// link, a search result or the selector always stay put. Crawlers are left on
// the canonical root; hreflang tags route them to the right variant.
if (html.hasAttribute('data-default') && !/bot|crawl|spider/i.test(navigator.userAgent)) {
  let want: LangCode | null = null;
  try {
    want = resolve(localStorage.getItem(KEY));
  } catch {
    // Storage unavailable: fall back to the browser languages.
  }
  if (!want) {
    for (const tag of navigator.languages.length ? navigator.languages : [navigator.language]) {
      want = resolve(tag);
      if (want) break;
    }
  }
  if (want && want !== html.lang) {
    location.replace(`${import.meta.env.BASE_URL}${want}/`);
  }
}
