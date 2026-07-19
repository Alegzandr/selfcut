import { useRef, useState } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { ChevronDown, Rows3 } from 'lucide-react';
import { TRACK_HEIGHT_PX } from '../app/config';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';
import { MenuList, type MenuEntry } from './menu/MenuList';
import { MenuPanel, useDismissOnOutside } from './menu/MenuPanel';

/**
 * Vertical zoom of the timeline. Three named heights rather than a slider: the
 * useful range is small, and a lane height is something you pick once for a
 * session ("I have six tracks, shrink them") and then forget.
 */
const STOPS = [
  { px: 40, labelKey: 'timeline.trackHeight.compact' },
  { px: TRACK_HEIGHT_PX, labelKey: 'timeline.trackHeight.default' },
  { px: 104, labelKey: 'timeline.trackHeight.tall' },
] as const satisfies readonly { px: number; labelKey: ParseKeys }[];

/**
 * Track-height picker, next to the timeline's other view controls. A menu and
 * not a cycling button: three states are one too many to step through blindly,
 * and the open list says which one is active without a click.
 */
export function TrackHeightMenu() {
  const { t } = useTranslation();
  const trackHeightPx = useStore((s) => s.trackHeightPx);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, () => setOpen(false), rootRef);

  const entries: MenuEntry[] = STOPS.map((stop) => ({
    id: `trackHeight.${stop.px}`,
    labelKey: stop.labelKey,
    checked: trackHeightPx === stop.px,
    onClick: () => useStore.getState().setTrackHeightPx(stop.px),
  }));

  return (
    <div ref={rootRef} className="relative flex-none">
      <Tooltip label={t('timeline.trackHeight.label')} disabled={open}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('timeline.trackHeight.label')}
          className={`touch-hit flex items-center gap-0.5 rounded-lg py-2 pl-2 pr-1 active:bg-zinc-800 ${
            open ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          <Rows3 className="h-4 w-4" />
          <ChevronDown className="h-3 w-3" />
        </button>
      </Tooltip>

      <AnimatePresence>
        {/* Above the trigger, anchored left: the transport is the last row over
            the timeline, and this sits at the left edge of the window. */}
        {open && (
          <MenuPanel from="bottom" className="bottom-full left-0 mb-1 min-w-40">
            <MenuList items={entries} onRun={() => setOpen(false)} />
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}
