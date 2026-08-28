import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { useEnterMotion } from './motion';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { PLAYBACK_SKIP_BACK_MS, PLAYBACK_SKIP_FORWARD_MS } from '../app/config';
import { Kbd } from './Kbd';
import { Tooltip } from './Tooltip';

/**
 * Shortcut table. `GROUPS` lives outside the component, so it holds i18n *keys*
 * only - never translated text, which would freeze at the boot locale.
 *
 * The `keys` cell (left column) is a template of whitespace-separated atoms.
 * Letters and symbols (S, ?, ←, [) are locale-independent and stay literal;
 * named keys and mouse gestures are `{{token}}` placeholders resolved against
 * the `shortcuts.key.*` dictionary at render time. A French translator writes
 * "Maj" once and every "Shift + ..." row follows, rather than 43 hand-written
 * combinations.
 *
 * Groups are sized to be read, not to be exhaustive: nine short lists beat one
 * thirty-row "Edit" dump, and they let the panel balance across columns.
 */
type Group = {
  readonly title: ParseKeys;
  readonly rows: readonly (readonly [keys: string, desc: ParseKeys])[];
};

const GROUPS: readonly Group[] = [
  {
    title: 'shortcuts.group.playback',
    rows: [
      ['{{space}}', 'shortcuts.playback.playPause'],
      ['K', 'shortcuts.playback.pause'],
      ['L', 'shortcuts.playback.shuttle'],
      ['J', 'shortcuts.playback.reverse'],
    ],
  },
  {
    title: 'shortcuts.group.navigate',
    rows: [
      ['← / →', 'shortcuts.navigate.frame'],
      ['← / →', 'shortcuts.navigate.skip'],
      ['{{shift}} + ← / →', 'shortcuts.navigate.second'],
      ['{{ctrl}} + ← / →', 'shortcuts.navigate.cutPoint'],
      ['1 … 9', 'shortcuts.navigate.marker'],
      ['{{home}} / {{end}}', 'shortcuts.navigate.bounds'],
    ],
  },
  {
    title: 'shortcuts.group.region',
    rows: [
      ['{{dragTopBar}}', 'shortcuts.region.select'],
      ['{{clickTopBar}}', 'shortcuts.region.clear'],
      ['I / O', 'shortcuts.region.inOut'],
      ['Q', 'shortcuts.region.loop'],
      ['M', 'shortcuts.region.addMarker'],
      ['{{dragMarker}}', 'shortcuts.region.moveMarker'],
      ['{{doubleClickMarker}}', 'shortcuts.region.renameMarker'],
      ['{{rightClickMarker}}', 'shortcuts.region.deleteMarker'],
      ['{{doubleClickClip}}', 'shortcuts.region.fromClip'],
    ],
  },
  {
    title: 'shortcuts.group.zoom',
    rows: [
      ['↑ / ↓ {{or}} {{plus}} / {{minus}}', 'shortcuts.zoom.inOut'],
      ['{{shift}} + Z', 'shortcuts.zoom.fit'],
      ['{{ctrl}} + {{wheel}}', 'shortcuts.zoom.cursor'],
      ['{{wheel}}', 'shortcuts.zoom.pan'],
      ['{{alt}} + {{wheel}}', 'shortcuts.zoom.scrollTracks'],
    ],
  },
  {
    title: 'shortcuts.group.preview',
    rows: [
      ['V / H / Z', 'shortcuts.preview.tools'],
      ['R', 'shortcuts.preview.shape'],
      ['{{shift}} + {{drag}}', 'shortcuts.preview.shapeSquare'],
      ['{{drag}}', 'shortcuts.preview.pan'],
      ['{{click}}', 'shortcuts.preview.zoomStep'],
      ['{{alt}} + {{click}}', 'shortcuts.preview.zoomOut'],
      ['{{dragMagnifier}}', 'shortcuts.preview.zoomRect'],
      ['{{ctrl}} + {{wheel}}', 'shortcuts.preview.zoomCursor'],
      ['{{middleDrag}}', 'shortcuts.preview.middlePan'],
    ],
  },
  {
    title: 'shortcuts.group.selection',
    rows: [
      ['{{ctrl}} + {{click}}', 'shortcuts.edit.multiSelect'],
      ['{{shift}} + {{click}}', 'shortcuts.edit.rangeSelect'],
      ['{{dragBackground}}', 'shortcuts.edit.marquee'],
      ['{{ctrl}} + A', 'shortcuts.edit.selectAll'],
      ['{{esc}}', 'shortcuts.edit.deselect'],
    ],
  },
  {
    title: 'shortcuts.group.edit',
    rows: [
      ['S', 'shortcuts.edit.split'],
      ['P', 'shortcuts.edit.punchIn'],
      ['T', 'shortcuts.edit.textClip'],
      ['E', 'shortcuts.edit.expandTrack'],
      ['{{dragClipOverNeighbor}}', 'shortcuts.edit.crossfade'],
      ['{{dragCornerHandle}}', 'shortcuts.edit.fade'],
      ['{{ctrl}} + {{drag}}', 'shortcuts.edit.dragCopy'],
      ['{{del}} / {{backspace}}', 'shortcuts.edit.delete'],
      ['{{shift}} + {{del}}', 'shortcuts.edit.rippleDelete'],
      ['{{esc}}', 'shortcuts.edit.cancelDrag'],
    ],
  },
  {
    title: 'shortcuts.group.keyframes',
    rows: [
      ['{{alt}} + 1 … 5', 'shortcuts.keyframe.ease'],
      ['F9', 'shortcuts.keyframe.easyEase'],
      ['{{shift}} + F9 {{or}} {{ctrl}} + {{shift}} + F9', 'shortcuts.keyframe.easeInOut'],
      ['G', 'shortcuts.keyframe.curveEditor'],
      ['{{rightClickKeyframe}}', 'shortcuts.keyframe.menu'],
      ['{{del}} / {{backspace}}', 'shortcuts.keyframe.delete'],
    ],
  },
  {
    title: 'shortcuts.group.trim',
    rows: [
      [', / .', 'shortcuts.edit.nudge'],
      ['[ / ]', 'shortcuts.edit.trim'],
      ['{{alt}} + {{drag}}', 'shortcuts.edit.slip'],
      ['{{ctrl}} + {{dragTrimEdge}}', 'shortcuts.edit.rippleTrim'],
      ['{{alt}} + {{dragTrimEdge}}', 'shortcuts.edit.rollEdit'],
      ['N', 'shortcuts.edit.snap'],
      ['{{shift}} + {{drag}}', 'shortcuts.edit.invertSnap'],
    ],
  },
  {
    title: 'shortcuts.group.project',
    rows: [
      ['{{ctrl}} + C / X / V', 'shortcuts.edit.clipboard'],
      ['{{ctrl}} + D', 'shortcuts.edit.duplicate'],
      ['{{ctrl}} + Z / Y', 'shortcuts.edit.undoRedo'],
      ['{{ctrl}} + S', 'shortcuts.edit.saveProject'],
      ['{{ctrl}} + {{shift}} + S', 'shortcuts.edit.saveProjectAs'],
      ['{{ctrl}} + O', 'shortcuts.edit.openProject'],
      ['{{ctrl}} + E', 'shortcuts.edit.export'],
      ['?', 'shortcuts.edit.togglePanel'],
    ],
  },
];

/**
 * Tokens whose label is a sentence about the mouse rather than a key to press.
 * They render as plain text: a keycap around "Double-click a marker" would
 * promise a key that does not exist, and mono-spacing a sentence reads as code.
 */
const GESTURES: ReadonlySet<string> = new Set([
  'clickTopBar',
  'dragTopBar',
  'dragMarker',
  'doubleClickMarker',
  'rightClickMarker',
  'dragClipOverNeighbor',
  'dragCornerHandle',
  'dragBackground',
  'dragTrimEdge',
  'doubleClickClip',
  'dragMagnifier',
  'middleDrag',
  'rightClickKeyframe',
]);

/** Punctuation that joins keys instead of being one. `+` combines, `/` and `…` alternate. */
const JOINERS: ReadonlySet<string> = new Set(['+', '/', '…']);

/** Localised labels of the named keys and gestures used in the `keys` templates. */
function useKeyLabels(): Readonly<Record<string, string>> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      space: t('shortcuts.key.space'),
      shift: t('shortcuts.key.shift'),
      ctrl: t('shortcuts.key.ctrl'),
      alt: t('shortcuts.key.alt'),
      del: t('shortcuts.key.del'),
      backspace: t('shortcuts.key.backspace'),
      esc: t('shortcuts.key.esc'),
      home: t('shortcuts.key.home'),
      end: t('shortcuts.key.end'),
      plus: t('shortcuts.key.plus'),
      minus: t('shortcuts.key.minus'),
      wheel: t('shortcuts.key.wheel'),
      drag: t('shortcuts.key.drag'),
      click: t('shortcuts.key.click'),
      or: t('shortcuts.key.or'),
      dragTopBar: t('shortcuts.key.dragTopBar'),
      clickTopBar: t('shortcuts.key.clickTopBar'),
      dragMarker: t('shortcuts.key.dragMarker'),
      doubleClickMarker: t('shortcuts.key.doubleClickMarker'),
      rightClickMarker: t('shortcuts.key.rightClickMarker'),
      dragClipOverNeighbor: t('shortcuts.key.dragClipOverNeighbor'),
      dragCornerHandle: t('shortcuts.key.dragCornerHandle'),
      dragBackground: t('shortcuts.key.dragBackground'),
      dragTrimEdge: t('shortcuts.key.dragTrimEdge'),
      doubleClickClip: t('shortcuts.key.doubleClickClip'),
      dragMagnifier: t('shortcuts.key.dragMagnifier'),
      middleDrag: t('shortcuts.key.middleDrag'),
    }),
    [t],
  );
}

/**
 * Turn one `keys` template into keycaps and the words between them.
 *
 * Splitting on whitespace is enough because every atom in the templates is
 * space-delimited - which is also why the `+` and `−` *keys* are spelled
 * `{{plus}}` / `{{minus}}`: a bare `+` always means "hold both".
 */
function renderKeys(template: string, labels: Readonly<Record<string, string>>): ReactNode[] {
  return template
    .split(/\s+/)
    .filter(Boolean)
    .map((atom, i) => {
      const token = atom.startsWith('{{') && atom.endsWith('}}') ? atom.slice(2, -2) : null;
      if (token && (GESTURES.has(token) || token === 'or')) {
        return (
          <span key={i} className="text-zinc-400">
            {labels[token]}
          </span>
        );
      }
      if (!token && JOINERS.has(atom)) {
        return (
          <span key={i} className="text-zinc-400">
            {atom}
          </span>
        );
      }
      return (
        <Kbd key={i} strong>
          {token ? (labels[token] ?? atom) : atom}
        </Kbd>
      );
    });
}

/**
 * The shortcut reference, toggled with `?`.
 *
 * Escape is deliberately *not* handled here: `useEditorHotkeys` owns this
 * panel's dismissal so that `?` and Escape both reach the same switch. Every
 * other key is swallowed there while the panel is open.
 */
export function ShortcutsHelp() {
  const { t } = useTranslation();
  const dialog = useEnterMotion({ y: 8, scale: 0.96 });
  const labels = useKeyLabels();
  const open = useStore((s) => s.shortcutsOpen);
  const { setShortcutsOpen } = useStore.getState();
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the panel and hand it back on close. Without this the
  // caret stays on whatever opened the dialog, so a screen reader keeps
  // reading the editor behind the overlay and Page Down scrolls the timeline
  // rather than the 62 rows the user just asked to see.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      // `isConnected`: a dialog opened from a menu outlives the item that
      // opened it, and focusing a detached node silently drops focus on body.
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  // Keep Tab inside the dialog. The panel itself is the only other stop, so
  // this is a two-element cycle, but it is written for whatever lands here next.
  function trapTab(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const stops = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = stops.at(0);
    const last = stops.at(-1);
    if (!first || !last) {
      // Nothing focusable left inside: keep the caret rather than let Tab
      // walk out into the editor sitting behind the overlay.
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    const leaving = e.shiftKey ? active === first || active === panel : active === last;
    if (!leaving) return;
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShortcutsOpen(false)}
        >
          <m.div
            ref={panelRef}
            {...dialog}
            // Explicit ease-out rather than the default spring: a reference
            // sheet should arrive and settle, not overshoot.
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            tabIndex={-1}
            className="flex max-h-[85dvh] w-full max-w-4xl flex-col xl:max-w-6xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black outline-none"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={trapTab}
          >
            {/* Outside the scroller: with nine groups to page through, the way
                out must not scroll away with them. */}
            <div className="flex flex-none items-center justify-between border-b border-zinc-800 px-5 py-3">
              <h2 id="shortcuts-title" className="text-sm font-semibold text-zinc-100">
                {t('shortcuts.title')}
              </h2>
              <Tooltip label={t('shortcuts.close')} shortcut="Esc">
                <button
                  className="touch-hit rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 active:bg-zinc-700/70"
                  onClick={() => setShortcutsOpen(false)}
                >
                  <Cross2Icon className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            {/* `pb-0`: the last group's own bottom margin is the padding. Doubling them
                put the sheet 4px over the fold and raised a scrollbar for nothing. */}
            <div className="overflow-y-auto px-5 pt-4 pb-0">
              {/* Multi-column rather than a grid: the browser balances the nine
                  groups by height, where a grid would leave a four-row group
                  padding out the space next to a ten-row one. */}
              <div className="gap-x-8 sm:columns-2 xl:columns-3">
                {GROUPS.map((g) => (
                  <section key={g.title} className="mb-4 break-inside-avoid">
                    <h3 className="mb-2 border-b border-zinc-800 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">
                      {t(g.title)}
                    </h3>
                    <dl className="space-y-1">
                      {g.rows.map(([keys, desc]) => (
                        <div
                          key={desc}
                          className="grid grid-cols-[10rem_minmax(0,1fr)] items-start gap-x-3 text-xs"
                        >
                          <dt className="flex flex-wrap items-center gap-1">
                            {renderKeys(keys, labels)}
                          </dt>
                          {/* The skip row is the one description carrying
                              numbers, and they are constants rather than
                              prose: interpolate them for every row, the rest
                              simply have no placeholder to fill. */}
                          <dd className="leading-5 text-zinc-300">
                            {t(desc, {
                              back: PLAYBACK_SKIP_BACK_MS / 1000,
                              fwd: PLAYBACK_SKIP_FORWARD_MS / 1000,
                            })}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
