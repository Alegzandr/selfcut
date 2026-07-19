// Generates the static landing pages from landing/template.html and
// landing/locales/*.json: the French page at the repo root (canonical) and one
// subdirectory per other language (en/, es/, de/, pt-BR/). Vite then picks
// them up as MPA inputs. Run via `npm run landing` (also part of dev/build).
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://selfcut.alegzandr.com';

// `path` is relative to the site root; fr is the canonical root page.
// Display order matches the app's language menu (src/i18n/index.ts LOCALES).
const LANGS = [
  { code: 'en', name: 'English', ogLocale: 'en_US', path: 'en/' },
  { code: 'fr', name: 'Français', ogLocale: 'fr_FR', path: '' },
  { code: 'es', name: 'Español', ogLocale: 'es_ES', path: 'es/' },
  { code: 'de', name: 'Deutsch', ogLocale: 'de_DE', path: 'de/' },
  { code: 'pt-BR', name: 'Português (BR)', ogLocale: 'pt_BR', path: 'pt-BR/' },
];

// x-default points at the root page: it is the one that redirects a visitor to
// their language (see landing/lang.js), which is what the attribute is for.
// Crawlers skip that redirect, so they index the French content it also serves.
const X_DEFAULT = LANGS.find((l) => l.path === '');

const template = readFileSync(join(root, 'landing', 'template.html'), 'utf8');

// Shared by the <head> of every page and by every sitemap entry: hreflang wants
// the same complete set of alternates in both places, self-reference included.
const ALTERNATES = [
  ...LANGS.map((l) => ({ hreflang: l.code, href: `${ORIGIN}/${l.path}` })),
  { hreflang: 'x-default', href: `${ORIGIN}/${X_DEFAULT.path}` },
];

const alternates = ALTERNATES.map(
  (a) => `    <link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`,
).join('\n');

const sitemapAlternates = ALTERNATES.map(
  (a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`,
).join('\n');

/**
 * Last commit date (YYYY-MM-DD) of `file`, for the sitemap's <lastmod>.
 *
 * Deploys build from a fresh clone, where every mtime is the checkout time, so
 * mtime alone would stamp today's date on every page at every deploy. Google
 * ignores a lastmod that always says "now". The commit date instead only moves
 * when the page's sources actually change. mtime is the fallback for a file
 * that has no commit yet (a locale added but not yet committed) or a checkout
 * without git history.
 */
function lastCommitDate(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // No git binary or no repository: fall through to the mtime.
  }
  return statSync(file).mtime.toISOString().slice(0, 10);
}

const templatePath = join(root, 'landing', 'template.html');
const templateDate = lastCommitDate(templatePath);
const sitemapEntries = [];

for (const lang of LANGS) {
  const localePath = join(root, 'landing', 'locales', `${lang.code}.json`);
  const strings = JSON.parse(readFileSync(localePath, 'utf8'));
  const url = `${ORIGIN}/${lang.path}`;

  // A page changes when either its template or its own strings change.
  const localeDate = lastCommitDate(localePath);
  sitemapEntries.push({
    url,
    lastmod: localeDate > templateDate ? localeDate : templateDate,
  });

  const jsonldApp = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SelfCut',
    url: `${ORIGIN}/app/`,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    browserRequirements: strings['schema.browserReq'],
    inLanguage: LANGS.map((l) => l.code),
    description: strings['schema.description'],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  };

  const jsonldFaq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [1, 2, 3, 4, 5].map((n) => ({
      '@type': 'Question',
      name: strings[`faq.q${n}`],
      acceptedAnswer: { '@type': 'Answer', text: strings[`faq.a${n}`] },
    })),
  };

  const computed = {
    url,
    home: `/${lang.path}`,
    currentLang: lang.name,
    htmlAttrs:
      lang.path === '' ? `lang="${lang.code}" data-default` : `lang="${lang.code}"`,
    ogLocale: lang.ogLocale,
    ogAlternates: LANGS.filter((l) => l !== lang)
      .map((l) => `    <meta property="og:locale:alternate" content="${l.ogLocale}" />`)
      .join('\n'),
    alternates,
    jsonldApp: JSON.stringify(jsonldApp),
    jsonldFaq: JSON.stringify(jsonldFaq),
    langNav: LANGS.map((l) => {
      const current = l === lang ? ' aria-current="page"' : '';
      return `            <a href="/${l.path}" lang="${l.code}" hreflang="${l.code}" data-lang="${l.code}"${current}>${l.name}</a>`;
    }).join('\n'),
  };

  const html = template.replace(/\{\{([\w.@-]+)\}\}/g, (_, key) => {
    const value = computed[key] ?? strings[key];
    if (value === undefined) {
      throw new Error(`Missing key "${key}" for locale "${lang.code}"`);
    }
    return value;
  });

  const outDir = join(root, lang.path);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  console.log(`landing: ${lang.code} -> ${lang.path || '(root)'}index.html`);
}

// The sitemap lists only the landing pages. /app/ is an empty SPA shell with no
// crawlable content, so it would add a URL without adding anything to index.
// <changefreq> and <priority> are omitted on purpose: Google ignores both.
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ...sitemapEntries.map((entry) =>
    [
      '  <url>',
      `    <loc>${entry.url}</loc>`,
      `    <lastmod>${entry.lastmod}</lastmod>`,
      sitemapAlternates,
      '  </url>',
    ].join('\n'),
  ),
  '</urlset>',
  '',
].join('\n');

writeFileSync(join(root, 'public', 'sitemap.xml'), sitemap);
console.log(`landing: sitemap.xml -> ${sitemapEntries.length} URLs`);
