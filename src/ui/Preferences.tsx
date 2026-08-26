import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import {
  ArchiveIcon,
  ChatBubbleIcon,
  Cross2Icon,
  GearIcon,
  ImageIcon,
  MixerHorizontalIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import i18n, { LOCALES, type Locale } from '../i18n';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import type { TimeFormat } from '../lib/time';
import { PREVIEW_BACKGROUNDS } from '../lib/palette';
import { CaptionModelDialog } from './CaptionModelDialog';
import { ResetDataDialog } from './ResetDataDialog';
import { captionModel } from '../media/captionsModel';
import {
  bestDefaultModel,
  captionCapabilities,
} from '../media/captionsCapabilities';
import {
  DEFAULT_CAPTION_MODEL,
  setStoredCaptionModel,
} from '../media/captionsPrefs';
import { useCaptionModelPref } from '../media/useCaptionPrefs';
import { useCaptionsSupported } from '../media/useCaptionCapabilities';
import { formatBytes } from '../lib/bytes';

const TIME_FORMATS: readonly { value: TimeFormat; labelKey: ParseKeys }[] = [
  { value: 'timecode', labelKey: 'preferences.timeFormat.timecode' },
  { value: 'decimal', labelKey: 'preferences.timeFormat.decimal' },
];

/** The one-click surrounds, darkest to lightest. Any other colour goes through the picker. */
const BACKGROUNDS: readonly { value: string; labelKey: ParseKeys }[] = [
  {
    value: PREVIEW_BACKGROUNDS.black,
    labelKey: 'preferences.previewBackground.black',
  },
  {
    value: PREVIEW_BACKGROUNDS.charcoal,
    labelKey: 'preferences.previewBackground.charcoal',
  },
  {
    value: PREVIEW_BACKGROUNDS.grey,
    labelKey: 'preferences.previewBackground.grey',
  },
  {
    value: PREVIEW_BACKGROUNDS.neutral,
    labelKey: 'preferences.previewBackground.neutral',
  },
  {
    value: PREVIEW_BACKGROUNDS.white,
    labelKey: 'preferences.previewBackground.white',
  },
];

const SELECT_CLASS =
  'min-w-44 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-brand-500';

/**
 * The sections, in the order the rail lists them.
 *
 * Named after what the user is looking for, not after which module owns the
 * setting: someone hunting for the preview background is thinking "preview",
 * and would never guess it lives in the same file as the language picker.
 * General is first because it holds the settings people open this dialog for;
 * Data is last because everything in it is irreversible.
 */
type TabId = 'general' | 'preview' | 'captions' | 'data';

const TABS: readonly {
  id: TabId;
  labelKey: ParseKeys;
  Icon: (props: { className?: string }) => ReactNode;
}[] = [
  { id: 'general', labelKey: 'preferences.tab.general', Icon: GearIcon },
  { id: 'preview', labelKey: 'preferences.tab.preview', Icon: ImageIcon },
  { id: 'captions', labelKey: 'preferences.tab.captions', Icon: ChatBubbleIcon },
  { id: 'data', labelKey: 'preferences.tab.data', Icon: ArchiveIcon },
];

/** One labelled preference row: description on the left, control on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-xs text-zinc-300">{label}</span>
      {children}
    </div>
  );
}

/** Rows in a section, hairline-separated the way the single list used to be. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-zinc-800">{children}</div>;
}

function GeneralTab() {
  const { t } = useTranslation();
  const timeFormat = useStore((s) => s.timeFormat);
  const { setTimeFormat } = useStore.getState();
  const currentLang = (i18n.resolvedLanguage ?? 'en') as Locale;

  return (
    <Rows>
      <Row label={t('topbar.language')}>
        <select
          className={SELECT_CLASS}
          aria-label={t('a11y.preferences.language')}
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

      <Row label={t('preferences.timeFormat')}>
        <select
          className={SELECT_CLASS}
          aria-label={t('a11y.preferences.timeFormat')}
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
    </Rows>
  );
}

function PreviewTab() {
  const { t } = useTranslation();
  const previewBackground = useStore((s) => s.previewBackground);
  const { setPreviewBackground } = useStore.getState();

  return (
    <Rows>
      <Row label={t('preferences.previewBackground')}>
        <div className="flex min-w-44 items-center justify-end gap-1.5">
          {BACKGROUNDS.map(({ value, labelKey }) => (
            <Tooltip key={value} label={t(labelKey)}>
              <button
                aria-label={t(labelKey)}
                aria-pressed={previewBackground === value}
                onClick={() => setPreviewBackground(value)}
                className={`h-6 w-6 rounded-md border ${
                  previewBackground === value
                    ? 'border-blue-500 ring-1 ring-blue-500'
                    : 'border-zinc-700 hover:border-zinc-500'
                }`}
                style={{ backgroundColor: value }}
              />
            </Tooltip>
          ))}
          {/* Anything the swatches do not cover - a match for the room, a
              client's brand colour behind a mock-up. */}
          <Tooltip label={t('preferences.previewBackground.custom')}>
            <input
              type="color"
              aria-label={t('a11y.preferences.previewBackground')}
              className="h-6 w-8 cursor-pointer rounded-md border border-zinc-700 bg-zinc-800"
              value={previewBackground}
              onChange={(e) => setPreviewBackground(e.target.value)}
            />
          </Tooltip>
        </div>
      </Row>
    </Rows>
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
function CaptionsTab() {
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
      <Rows>
        <Row label={t('preferences.captions.model')}>
          <button
            type="button"
            onClick={() => setModelsOpen(true)}
            className="flex min-w-44 items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 hover:border-zinc-600"
          >
            {captionModel(model).name}
            <MixerHorizontalIcon className="h-3.5 w-3.5 text-zinc-400" />
          </button>
        </Row>
      </Rows>
      <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
        {t('preferences.captions.hint')}
      </p>

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
 * What Selfcut has stored, and the way out of it.
 *
 * Everything the editor keeps lives in this browser and nowhere else, which is
 * the promise the app makes and also why this tab has to exist: there is no
 * account page to go and delete it from. The figure comes from the origin's own
 * storage estimate rather than from adding up what the app thinks it wrote, so
 * an orphaned cache or a leftover export scratch file is counted too - it is the
 * number the browser would enforce a quota against.
 */
function DataTab() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<number | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void navigator.storage
      ?.estimate?.()
      .then((e) => {
        if (live && typeof e.usage === 'number') setUsage(e.usage);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <p className="text-xs leading-relaxed text-zinc-400">
        {t('preferences.data.intro')}
      </p>

      {usage !== null && (
        <Rows>
          <Row label={t('preferences.data.usage')}>
            <span className="min-w-44 text-right text-xs tabular-nums text-zinc-200">
              {formatBytes(usage)}
            </span>
          </Row>
        </Rows>
      )}

      <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/5 p-3.5">
        <h3 className="text-xs font-semibold text-red-200">
          {t('preferences.data.reset.heading')}
        </h3>
        <p className="mt-1.5 text-2xs leading-relaxed text-zinc-400">
          {t('preferences.data.reset.lead')}
        </p>
        <button
          type="button"
          onClick={() => setResetOpen(true)}
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/20"
        >
          <TrashIcon className="h-3.5 w-3.5" />
          {t('preferences.data.reset.button')}
        </button>
      </div>

      <ResetDataDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </>
  );
}

/**
 * Preferences dialog, opened from the desktop menu bar.
 *
 * Tabbed rather than one list: the settings here span the interface, the
 * preview, transcription and stored data, and a single scrolling column made
 * unrelated things read as steps in a sequence. The rail also gives the
 * destructive section a place to sit where nobody lands on it by accident.
 */
export function Preferences() {
  const { t } = useTranslation();
  const open = useStore((s) => s.preferencesOpen);
  const { setPreferencesOpen } = useStore.getState();
  // Same rule the subtitles pane applies: the tab exists where the machine can
  // run transcription, phone included, and nowhere else - settings for a feature
  // this device cannot reach are just a dead end with a title.
  const captionsAvailable = useCaptionsSupported();
  const tabs = TABS.filter((x) => x.id !== 'captions' || captionsAvailable);
  // Kept across open/close: the section someone was last in is nearly always
  // the one they come back to.
  const [tab, setTab] = useState<TabId>('general');
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  // Escape closes the dialog (the tooltip advertises it); capture phase so the
  // global editor hotkeys never see the keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPreferencesOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Arrow keys walk the rail, as a tablist is expected to: the tabs are a
  // single stop in the tab order, and Up/Down move within it.
  function onRailKey(e: KeyboardEvent) {
    const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const i = tabs.findIndex((x) => x.id === tab);
    const next = tabs[(i + delta + tabs.length) % tabs.length]!;
    setTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  }

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
            aria-label={t('preferences.title')}
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-none items-center justify-between border-b border-zinc-800 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-zinc-100">
                {t('preferences.title')}
              </h2>
              <Tooltip label={t('preferences.close')} shortcut="Esc">
                <button
                  className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
                  onClick={() => setPreferencesOpen(false)}
                >
                  <Cross2Icon className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              {/* A strip above the panel on a narrow window, a rail beside it on
                  a wide one: four labels do not fit next to the panel on a
                  phone, and a full-width rail wastes the height on a desktop. */}
              <div
                role="tablist"
                aria-orientation="vertical"
                aria-label={t('preferences.title')}
                onKeyDown={onRailKey}
                className="flex flex-none gap-1 overflow-x-auto border-b border-zinc-800 p-2 sm:w-44 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3"
              >
                {tabs.map(({ id, labelKey, Icon }) => (
                  <button
                    key={id}
                    ref={(el) => {
                      if (el) tabRefs.current.set(id, el);
                      else tabRefs.current.delete(id);
                    }}
                    role="tab"
                    id={`prefs-tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`prefs-panel-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    className={`flex flex-none items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      tab === id
                        ? 'bg-zinc-800 font-medium text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 flex-none" />
                    {t(labelKey)}
                  </button>
                ))}
              </div>

              <div
                role="tabpanel"
                id={`prefs-panel-${tab}`}
                aria-labelledby={`prefs-tab-${tab}`}
                // The floor keeps the dialog from resizing as the sections are
                // walked; the scroll is for the day a section outgrows it.
                className="min-h-[15rem] flex-1 overflow-y-auto px-5 py-3"
              >
                {tab === 'general' && <GeneralTab />}
                {tab === 'preview' && <PreviewTab />}
                {tab === 'captions' && captionsAvailable && <CaptionsTab />}
                {tab === 'data' && <DataTab />}
              </div>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
