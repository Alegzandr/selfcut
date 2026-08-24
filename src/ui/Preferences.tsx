import { useEffect, useState, type ReactNode } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { AnimatePresence, m } from "framer-motion";
import { Cross2Icon, MixerHorizontalIcon } from "@radix-ui/react-icons";
import i18n, { LOCALES, type Locale } from "../i18n";
import { useStore } from "../store/store";
import { Tooltip } from "./Tooltip";
import type { TimeFormat } from "../lib/time";
import { PREVIEW_BACKGROUNDS } from "../lib/palette";
import { CaptionModelDialog } from "./CaptionModelDialog";
import { captionModel } from "../media/captionsModel";
import {
  bestDefaultModel,
  captionCapabilities,
} from "../media/captionsCapabilities";
import {
  DEFAULT_CAPTION_MODEL,
  setStoredCaptionModel,
} from "../media/captionsPrefs";
import { useCaptionModelPref } from "../media/useCaptionPrefs";
import { useIsCoarsePointer } from "../lib/device";

const TIME_FORMATS: readonly { value: TimeFormat; labelKey: ParseKeys }[] = [
  { value: "timecode", labelKey: "preferences.timeFormat.timecode" },
  { value: "decimal", labelKey: "preferences.timeFormat.decimal" },
];

/** The one-click surrounds, darkest to lightest. Any other colour goes through the picker. */
const BACKGROUNDS: readonly { value: string; labelKey: ParseKeys }[] = [
  {
    value: PREVIEW_BACKGROUNDS.black,
    labelKey: "preferences.previewBackground.black",
  },
  {
    value: PREVIEW_BACKGROUNDS.charcoal,
    labelKey: "preferences.previewBackground.charcoal",
  },
  {
    value: PREVIEW_BACKGROUNDS.grey,
    labelKey: "preferences.previewBackground.grey",
  },
  {
    value: PREVIEW_BACKGROUNDS.neutral,
    labelKey: "preferences.previewBackground.neutral",
  },
  {
    value: PREVIEW_BACKGROUNDS.white,
    labelKey: "preferences.previewBackground.white",
  },
];

const SELECT_CLASS =
  "min-w-44 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500";

/** One labelled preference row: description on the left, control on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-xs text-zinc-300">{label}</span>
      {children}
    </div>
  );
}

/**
 * The transcription model, as a preference row.
 *
 * This is the only caption setting that belongs here: "which model does this
 * thing run" is the question people bring to Preferences, and the model manager
 * (a several-hundred-megabyte download with a delete button) is not something
 * to make anyone select a clip to reach. The language and the voice focus are
 * per-run choices, so they live on the captions card next to the button that
 * uses them - repeating them here only made the same setting look like two.
 */
function CaptionRows() {
  const { t } = useTranslation();
  const storedModel = useCaptionModelPref();
  const [probedModel, setProbedModel] = useState(DEFAULT_CAPTION_MODEL);
  const [modelsOpen, setModelsOpen] = useState(false);
  const model = storedModel ?? probedModel;

  useEffect(() => {
    if (storedModel) return;
    let live = true;
    void captionCapabilities().then((caps) => {
      if (live) setProbedModel(bestDefaultModel(caps));
    });
    return () => {
      live = false;
    };
  }, [storedModel]);

  return (
    <>
      <Row label={t("preferences.captions.model")}>
        <button
          type="button"
          onClick={() => setModelsOpen(true)}
          className="flex min-w-44 items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 hover:border-zinc-600"
        >
          {captionModel(model).name}
          <MixerHorizontalIcon className="h-3.5 w-3.5 text-zinc-400" />
        </button>
      </Row>

      <CaptionModelDialog
        open={modelsOpen}
        model={model}
        onPick={setStoredCaptionModel}
        onClose={() => setModelsOpen(false)}
      />
    </>
  );
}

/**
 * Preferences dialog, opened from the desktop menu bar. Holds the settings that
 * are meaningful for A/V editing and safe to expose without an "advanced" gate:
 * the interface language, how the transport spells time out, and the colour the
 * preview sits on.
 */
export function Preferences() {
  const { t } = useTranslation();
  const open = useStore((s) => s.preferencesOpen);
  const timeFormat = useStore((s) => s.timeFormat);
  const previewBackground = useStore((s) => s.previewBackground);
  const { setPreferencesOpen, setTimeFormat, setPreviewBackground } =
    useStore.getState();
  // Same rule the subtitles pane applies: Whisper is desktop-only here, so a
  // touch device is not offered settings for a feature it cannot run.
  const captionsAvailable = !useIsCoarsePointer();
  const currentLang = (i18n.resolvedLanguage ?? "en") as Locale;

  // Escape closes the dialog (the tooltip advertises it); capture phase so the
  // global editor hotkeys never see the keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPreferencesOpen(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPreferencesOpen(false)}
        >
          <m.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="dialog"
            aria-modal="true"
            aria-label={t("preferences.title")}
            className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">
                {t("preferences.title")}
              </h2>
              <Tooltip label={t("preferences.close")} shortcut="Esc">
                <button
                  className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
                  onClick={() => setPreferencesOpen(false)}
                >
                  <Cross2Icon className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            <div className="divide-y divide-zinc-800">
              <Row label={t("topbar.language")}>
                <select
                  className={SELECT_CLASS}
                  aria-label={t("a11y.preferences.language")}
                  value={currentLang}
                  onChange={(e) => void i18n.changeLanguage(e.target.value)}
                >
                  {(Object.keys(LOCALES) as Locale[]).map((code) => (
                    <option key={code} value={code}>
                      {LOCALES[code]}
                    </option>
                  ))}
                </select>
              </Row>

              <Row label={t("preferences.timeFormat")}>
                <select
                  className={SELECT_CLASS}
                  aria-label={t("a11y.preferences.timeFormat")}
                  value={timeFormat}
                  onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
                >
                  {TIME_FORMATS.map(({ value, labelKey }) => (
                    <option key={value} value={value}>
                      {t(labelKey)}
                    </option>
                  ))}
                </select>
              </Row>

              <Row label={t("preferences.previewBackground")}>
                <div className="flex min-w-44 items-center justify-end gap-1.5">
                  {BACKGROUNDS.map(({ value, labelKey }) => (
                    <Tooltip key={value} label={t(labelKey)}>
                      <button
                        aria-label={t(labelKey)}
                        aria-pressed={previewBackground === value}
                        onClick={() => setPreviewBackground(value)}
                        className={`h-6 w-6 rounded-md border ${
                          previewBackground === value
                            ? "border-sky-500 ring-1 ring-sky-500"
                            : "border-zinc-700 hover:border-zinc-500"
                        }`}
                        style={{ backgroundColor: value }}
                      />
                    </Tooltip>
                  ))}
                  {/* Anything the swatches do not cover - a match for the room, a
                      client's brand colour behind a mock-up. */}
                  <Tooltip label={t("preferences.previewBackground.custom")}>
                    <input
                      type="color"
                      aria-label={t("a11y.preferences.previewBackground")}
                      className="h-6 w-8 cursor-pointer rounded-md border border-zinc-700 bg-zinc-800"
                      value={previewBackground}
                      onChange={(e) => setPreviewBackground(e.target.value)}
                    />
                  </Tooltip>
                </div>
              </Row>

              {captionsAvailable && <CaptionRows />}
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
