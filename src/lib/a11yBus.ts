/**
 * Tiny pub/sub for screen-reader announcements, mirroring the meterBus
 * pattern: store code publishes an i18n key (plus interpolation params) when
 * something worth announcing happens - split, delete, undo, redo - and the
 * mounted `A11yAnnouncer` renders it into a polite `aria-live` region.
 *
 * Messages carry *keys*, not translated strings, so the translation happens
 * where React and the active language live, not inside the store.
 */

/** The finite set of announcements, all under `a11y.announce.*` in the locales. */
export type AnnouncementKey =
  | 'a11y.announce.play'
  | 'a11y.announce.pause'
  | 'a11y.announce.split'
  | 'a11y.announce.deleted'
  | 'a11y.announce.gapClosed'
  | 'a11y.announce.undo'
  | 'a11y.announce.redo';

export interface Announcement {
  key: AnnouncementKey;
  /** i18next interpolation params (`count` drives pluralization). */
  params?: { count?: number };
}

const listeners = new Set<(a: Announcement) => void>();

export function announce(key: AnnouncementKey, params?: Announcement['params']): void {
  for (const fn of listeners) fn({ key, params });
}

export function subscribeAnnouncements(fn: (a: Announcement) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
