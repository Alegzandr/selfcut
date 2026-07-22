import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { ChevronDown, Expand } from 'lucide-react';
import { useStore } from '../store/store';
import { MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM, isViewReset } from './view';
import { Tooltip } from '../ui/Tooltip';
import { MenuList, type MenuEntry } from '../ui/menu/MenuList';
import { MenuPanel, useDismissOnOutside } from '../ui/menu/MenuPanel';

/**
 * Stops for the monitor's camera. 100% is the frame fitted to the panel - not
 * the frame at its pixel size - because that is what "zoom 1" means for this
 * view, and what the user sees when the editor opens.
 */
const PERCENT_STOPS = [25, 50, 100, 200, 400, 800].filter(
  (p) => p / 100 >= MIN_PREVIEW_ZOOM && p / 100 <= MAX_PREVIEW_ZOOM,
);

/**
 * The preview's zoom readout, at the right end of the transport: it states the
 * camera scale and opens the fixed stops plus fit-to-window. The magnifier tool,
 * pinch and Ctrl+wheel all keep working - this is the one place that names a
 * number, for when "a bit more" is not what the user wants.
 */
export function PreviewZoomMenu() {
  const { t } = useTranslation();
  const view = useStore((s) => s.previewView);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, () => setOpen(false), rootRef);

  const current = Math.round(view.zoom * 100);

  /**
   * Zoom about the centre of the viewport. Pinning the centre point reduces to
   * scaling the pan by the same factor, so this needs no measurement of the DOM.
   */
  const setZoom = (zoom: number) => {
    const k = zoom / view.zoom;
    useStore.getState().setPreviewView({ zoom, x: view.x * k, y: view.y * k });
  };

  const entries: MenuEntry[] = [
    {
      id: 'previewZoom.fit',
      // Named for what it does *here* rather than reusing the toolbar's "reset
      // the view": in a list of scales, the odd one out is the one that picks
      // the scale for you.
      labelKey: 'preview.zoom.fit',
      icon: Expand,
      disabled: isViewReset(view),
      onClick: () => useStore.getState().resetPreviewView(),
    },
    '---',
    ...PERCENT_STOPS.map((p) => ({
      id: `previewZoom.${p}`,
      labelKey: 'preview.zoom.level' as const,
      label: `${p}%`,
      // A stop lights up while the scale rounds to it, so wheel-zooming near a
      // stop still shows which rung it landed on.
      checked: current === p,
      onClick: () => setZoom(p / 100),
    })),
  ];

  return (
    <div ref={rootRef} className="relative flex-none">
      <Tooltip label={t('preview.zoom.level')} disabled={open}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('preview.zoom.level')}
          className={`flex items-center gap-0.5 rounded-lg px-1 py-1 font-mono text-2xs tabular-nums hover:bg-zinc-800/70 active:bg-zinc-800 ${
            open ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          {/* Reserved width so the cluster does not shuffle between 25% and
              800%, centred so the slack splits evenly on both sides. */}
          <span className="min-w-[34px] text-center">{current}%</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </Tooltip>

      <AnimatePresence>
        {/* Above the trigger and anchored right: the transport sits at the
            bottom of the monitor, at the right edge of the window. */}
        {open && (
          <MenuPanel from="bottom" className="bottom-full right-0 mb-1 min-w-40">
            <MenuList items={entries} onRun={() => setOpen(false)} />
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}
