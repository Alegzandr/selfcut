import { LANGS, ORIGIN } from './langs';
import { faqEntries, type LandingStrings } from './strings';

/**
 * The structured-data blocks every landing page carries: who the site is, what
 * the app is, and the FAQ it displays. Serialized into
 * <script type="application/ld+json"> by the layout.
 */

/**
 * Names the site itself. Without it, search engines fall back to the bare
 * domain and label the result "alegzandr.com" instead of "SelfCut".
 */
export function webSite(strings: LandingStrings): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'SelfCut',
    url: `${ORIGIN}/`,
    inLanguage: LANGS.map((lang) => lang.code),
    description: strings['meta.description'],
    publisher: {
      '@type': 'Organization',
      name: 'SelfCut',
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/icon-512.png`,
    },
  };
}

export function softwareApplication(strings: LandingStrings): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SelfCut',
    url: `${ORIGIN}/app/`,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    browserRequirements: strings['schema.browserReq'],
    inLanguage: LANGS.map((lang) => lang.code),
    description: strings['schema.description'],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  };
}

export function faqPage(strings: LandingStrings): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqEntries(strings).map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answer },
    })),
  };
}
