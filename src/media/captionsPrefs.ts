import { CAPTION_MODELS, DEFAULT_CAPTION_MODEL } from "./captionsModel";

/**
 * The two choices a caption run needs beyond the clips themselves: which model
 * and which spoken language. Both are persisted per machine rather than per
 * project - they describe the hardware and the footage habits of whoever sits
 * here, not the edit, and a project opened on another computer has no business
 * asking it for a model it cannot run.
 */

const MODEL_KEY = "selfcut.captions.model";
const LANGUAGE_KEY = "selfcut.captions.language";
const ENHANCE_KEY = "selfcut.captions.enhance";

/**
 * Sentinel for "let Whisper work it out from the audio".
 *
 * This is the default, and it matters that it is: the language used to be
 * forced to the interface language, so a French UI transcribing English audio
 * asked Whisper for French words that were never spoken - which it duly
 * invented. Detection is right far more often than the UI language is.
 */
export const AUTO_LANGUAGE = "auto";

/**
 * Spoken languages offered explicitly. Whisper knows around a hundred; this is
 * the short list that covers the overwhelming majority of footage, with
 * detection handling the rest. Codes are what Whisper expects (ISO 639-1).
 */
export const CAPTION_LANGUAGES = [
  "en",
  "fr",
  "es",
  "pt",
  "de",
  "it",
  "nl",
  "pl",
  "ru",
  "uk",
  "tr",
  "ar",
  "hi",
  "ja",
  "ko",
  "zh",
  "id",
  "vi",
  "sv",
  "da",
];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * These preferences are edited from two places at once - the captions card in
 * the subtitles pane and the Preferences dialog - so a write has to reach the
 * other one. localStorage fires no event in the tab that wrote it, hence the
 * hand-rolled notification (`useCaptionPrefs` turns it into a React hook).
 */
const listeners = new Set<() => void>();

export function subscribeCaptionPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / no storage - the choice just will not persist */
  }
  for (const fn of [...listeners]) fn();
}

/** The stored model id, or null when this machine has never picked one. */
export function storedCaptionModel(): string | null {
  const id = read(MODEL_KEY);
  // A model removed from the catalogue between versions must not strand the
  // preference on an id nothing resolves any more.
  return id && CAPTION_MODELS.some((m) => m.id === id) ? id : null;
}

export function setStoredCaptionModel(id: string): void {
  write(MODEL_KEY, id);
}

export function storedCaptionLanguage(): string {
  const lang = read(LANGUAGE_KEY);
  return lang && (lang === AUTO_LANGUAGE || CAPTION_LANGUAGES.includes(lang))
    ? lang
    : AUTO_LANGUAGE;
}

export function setStoredCaptionLanguage(lang: string): void {
  write(LANGUAGE_KEY, lang);
}

/**
 * Whether to run the clip's sound through the speech chain before Whisper sees
 * it. On by default: the footage this is aimed at is a stream recording, where
 * the voice shares the track with music, alerts and game audio.
 */
export function storedCaptionEnhance(): boolean {
  return read(ENHANCE_KEY) !== "off";
}

export function setStoredCaptionEnhance(on: boolean): void {
  write(ENHANCE_KEY, on ? "on" : "off");
}

/** What to send the worker: a code, or nothing at all for auto-detection. */
export function whisperLanguage(lang: string): string | undefined {
  return lang === AUTO_LANGUAGE ? undefined : lang;
}

/**
 * A language's name in the interface language ('es' → "espagnol" in French),
 * falling back to the raw code where Intl.DisplayNames is unavailable. Naming
 * languages from the browser beats a hand-kept table in five locale files.
 */
export function languageName(code: string, uiLanguage: string): string {
  try {
    return (
      new Intl.DisplayNames([uiLanguage], { type: "language" }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

/** The default model, used until the machine's own capabilities are known. */
export { DEFAULT_CAPTION_MODEL };
