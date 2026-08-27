import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { useEnterMotion } from './motion';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useEditorCommands } from './commands';
import { MenuList, type MenuEntry } from './menu/MenuList';
import { MENUS } from './menu/appMenus';
import { MasterVolume } from './MasterVolume';

/**
 * The application menus on touch, as a bottom sheet.
 *
 * Touch has no menu bar, and for a long time that meant the commands living
 * only in the menus - the project library, save as, subtitle export, snapping,
 * select all, about - were not reachable on a phone at all. A handful of them
 * had been promoted to tiles on the bottom bar one at a time, which is a rail
 * that grows without ever becoming complete.
 *
 * So the whole structure is rendered instead, from the same `MENUS` the desktop
 * bar reads: sections stacked in one scrolling column, each row the shared
 * `MenuItemRow`. Nothing to keep in sync, and a command added to a menu appears
 * on both surfaces by construction.
 *
 * The master volume rides at the top for the same reason: on desktop it sits in
 * the menu bar, so this sheet is the only place it can live on a phone.
 */
export function MobileMenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  const sheet = useEnterMotion({ y: '100%' });

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/60"
            onClick={onClose}
          />
          <m.div
            {...sheet}
            transition={{ type: 'spring', damping: 32, stiffness: 380 }}
            role="menu"
            aria-label={t('topbar.menu')}
            // Capped at 80dvh and scrolled inside: the full menu set is longer
            // than a phone screen, and a sheet that runs off the bottom hides
            // its own last section.
            className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-zinc-700 bg-zinc-900 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black"
          >
            <div className="flex flex-none items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <span className="text-xs font-semibold text-zinc-200">{t('topbar.menu')}</span>
              <div className="ml-auto flex items-center gap-1">
                <MasterVolume />
                <button
                  type="button"
                  className="touch-hit rounded-lg p-2 text-zinc-400 hover:bg-zinc-800/70 active:bg-zinc-800"
                  onClick={onClose}
                  aria-label={t('mobile.menu.close')}
                >
                  <Cross2Icon className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* This column scrolls in one direction only, and it takes both of
                these to hold that. `overflow-y-auto` alone computes overflow-x
                to `auto`, and the rows did overflow it: `touch-hit` hangs an
                invisible 8px hit-area expander off every row, which poked 2px
                past a 6px inline padding. Two pixels of scrollable width is all
                a touch browser needs to hand the whole menu a horizontal pan,
                and it rubber-bands the column sideways under the thumb. So the
                padding matches the expander exactly (nothing to scroll to), and
                overflow-x is pinned shut for whatever the next wide child is. */}
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-2">
              {MENUS.map((menu) => (
                <section key={menu.titleKey} className="pb-1">
                  <h2 className="px-2 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-zinc-500">
                    {t(menu.titleKey)}
                  </h2>
                  <MenuList
                    items={menu.items
                      .map((item): MenuEntry | null => (item === '---' ? '---' : commands[item] ?? null))
                      .filter((e): e is MenuEntry => e !== null)}
                    onRun={onClose}
                  />
                </section>
              ))}
            </div>
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}
