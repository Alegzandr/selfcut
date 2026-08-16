import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';

import { ALTERNATES, LANGS, urlOf } from '../src/landing/langs';

/**
 * The sitemap lists only the landing pages. /app/ is an empty shell with no
 * crawlable content, so it would add a URL without adding anything to index.
 * <changefreq> and <priority> are omitted on purpose: Google ignores both.
 *
 * Written by hand rather than with @astrojs/sitemap because that integration's
 * i18n mode keys locales by path prefix, and the default language here is
 * served from the root with no prefix at all - its alternates would come out
 * wrong.
 */

/** The files that decide what a page looks like, whatever its language. */
const SHELL_PATHS = [
  'src/layouts/Landing.astro',
  'src/components/landing',
  'src/styles/landing.css',
];

/**
 * Last commit date (YYYY-MM-DD) of the newest of `files`, for <lastmod>.
 *
 * Deploys build from a fresh clone, where every mtime is the checkout time, so
 * mtime alone would stamp today's date on every page at every deploy. Google
 * ignores a lastmod that always says "now". The commit date instead only moves
 * when the page's sources actually change. mtime is the fallback for a file
 * that has no commit yet (a locale added but not yet committed) or a checkout
 * without git history.
 */
function lastCommitDate(root: string, files: string[]): string {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...files], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // No git binary or no repository: fall through to the mtimes.
  }
  const mtimes = files.map((file) =>
    fs.statSync(path.join(root, file)).mtime.toISOString().slice(0, 10),
  );
  return mtimes.sort().at(-1) ?? '';
}

export function sitemap(): AstroIntegration {
  return {
    name: 'selfcut:sitemap',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = process.cwd();
        const shellDate = lastCommitDate(root, SHELL_PATHS);

        const alternates = ALTERNATES.map(
          (alternate) =>
            `    <xhtml:link rel="alternate" hreflang="${alternate.hreflang}" href="${alternate.href}" />`,
        ).join('\n');

        const entries = LANGS.map((lang) => {
          // A page changes when either its shell or its own strings change.
          const localeDate = lastCommitDate(root, [`src/landing/locales/${lang.code}.json`]);
          return [
            '  <url>',
            `    <loc>${urlOf(lang)}</loc>`,
            `    <lastmod>${localeDate > shellDate ? localeDate : shellDate}</lastmod>`,
            alternates,
            '  </url>',
          ].join('\n');
        });

        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
          ...entries,
          '</urlset>',
          '',
        ].join('\n');

        await fs.promises.writeFile(path.join(fileURLToPath(dir), 'sitemap.xml'), xml);
        logger.info(`sitemap.xml -> ${entries.length} URLs`);
      },
    },
  };
}
