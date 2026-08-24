import { useSyncExternalStore } from 'react';
import {
  DEFAULT_CAPTION_MODEL,
  AUTO_LANGUAGE,
  storedCaptionEnhance,
  storedCaptionLanguage,
  storedCaptionModel,
  subscribeCaptionPrefs,
} from './captionsPrefs';

/**
 * The caption preferences as React state.
 *
 * They live in localStorage rather than in the editor store because they
 * describe the machine, not the project - but two surfaces edit them (the
 * captions card and the Preferences dialog), so both have to see the other's
 * writes. `useSyncExternalStore` over the prefs' own notification does that
 * without a second copy of the truth.
 *
 * Each hook returns a primitive, so no snapshot caching is needed.
 */

/** The stored model id, or null while this machine has never picked one. */
export function useCaptionModelPref(): string | null {
  return useSyncExternalStore(
    subscribeCaptionPrefs,
    storedCaptionModel,
    () => DEFAULT_CAPTION_MODEL,
  );
}

export function useCaptionLanguagePref(): string {
  return useSyncExternalStore(
    subscribeCaptionPrefs,
    storedCaptionLanguage,
    () => AUTO_LANGUAGE,
  );
}

export function useCaptionEnhancePref(): boolean {
  return useSyncExternalStore(
    subscribeCaptionPrefs,
    storedCaptionEnhance,
    () => true,
  );
}
