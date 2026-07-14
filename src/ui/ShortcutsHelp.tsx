import { useMemo } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';

/**
 * Shortcut table. `GROUPS` lives outside the component, so it holds i18n *keys*
 * only - never translated text, which would freeze at the boot locale.
 *
 * The `keys` cell (left column) is a template: letters and symbols (S, ?, ←,
 * [ / ]) are locale-independent and stay literal, while the named keys and mouse
 * gestures are `{{token}}` placeholders resolved against the `shortcuts.key.*`
 * dictionary at render time. A French translator writes "Maj" once and every
 * "Shift + ..." row follows, rather than 43 hand-written combinations.
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
      ['←  / →', 'shortcuts.navigate.frame'],
      ['{{shift}} + ←  / →', 'shortcuts.navigate.second'],
      ['{{ctrl}} + ←  / →', 'shortcuts.navigate.cutPoint'],
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
    ],
  },
  {
    title: 'shortcuts.group.zoom',
    rows: [
      ['↑ / ↓  {{or}}  + / −', 'shortcuts.zoom.inOut'],
      ['{{shift}} + Z', 'shortcuts.zoom.fit'],
      ['{{ctrl}} + {{wheel}}', 'shortcuts.zoom.cursor'],
      ['{{wheel}}', 'shortcuts.zoom.pan'],
      ['{{alt}} + {{wheel}}', 'shortcuts.zoom.scrollTracks'],
    ],
  },
  {
    title: 'shortcuts.group.edit',
    rows: [
      ['S', 'shortcuts.edit.split'],
      ['P', 'shortcuts.edit.punchIn'],
      ['T', 'shortcuts.edit.textClip'],
      ['{{dragClipOverNeighbor}}', 'shortcuts.edit.crossfade'],
      ['{{dragCornerHandle}}', 'shortcuts.edit.fade'],
      ['{{ctrl}} + {{click}}', 'shortcuts.edit.multiSelect'],
      ['{{ctrl}} + A', 'shortcuts.edit.selectAll'],
      ['{{del}} / {{backspace}}', 'shortcuts.edit.delete'],
      ['{{shift}} + {{del}}', 'shortcuts.edit.rippleDelete'],
      [', / .', 'shortcuts.edit.nudge'],
      ['[ / ]', 'shortcuts.edit.trim'],
      ['N', 'shortcuts.edit.snap'],
      ['{{shift}} + {{drag}}', 'shortcuts.edit.invertSnap'],
      ['{{ctrl}} + C / X / V', 'shortcuts.edit.clipboard'],
      ['{{ctrl}} + D', 'shortcuts.edit.duplicate'],
      ['{{ctrl}} + Z / Y', 'shortcuts.edit.undoRedo'],
      ['{{ctrl}} + E', 'shortcuts.edit.export'],
      ['{{esc}}', 'shortcuts.edit.deselect'],
      ['?', 'shortcuts.edit.togglePanel'],
    ],
  },
];

const TOKEN = /\{\{(\w+)\}\}/g;

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
    }),
    [t],
  );
}

function formatKeys(template: string, labels: Readonly<Record<string, string>>): string {
  return template.replace(TOKEN, (whole, token: string) => labels[token] ?? whole);
}

export function ShortcutsHelp() {
  const { t } = useTranslation();
  const labels = useKeyLabels();
  const open = useStore((s) => s.shortcutsOpen);
  const { setShortcutsOpen } = useStore.getState();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShortcutsOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            className="max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">{t('shortcuts.title')}</h2>
              <Tooltip label={t('shortcuts.close')} shortcut="Esc">
                <button
                  className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800"
                  onClick={() => setShortcutsOpen(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {GROUPS.map((g) => (
                <div key={g.title}>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    {t(g.title)}
                  </h3>
                  <dl className="space-y-1">
                    {g.rows.map(([keys, desc]) => (
                      <div key={desc} className="flex items-baseline justify-between gap-3 text-xs">
                        <dt className="font-mono text-zinc-300">{formatKeys(keys, labels)}</dt>
                        <dd className="text-right text-zinc-500">{t(desc)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
