import { LANGS, ORIGIN } from './langs';
import { faqEntries, type LandingStrings } from './strings';

/**
 * The two structured-data blocks every landing page carries: what the app is,
 * and the FAQ it displays. Serialized into <script type="application/ld+json">
 * by the layout.
 */

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
