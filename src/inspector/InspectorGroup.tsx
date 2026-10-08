import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon } from '@radix-ui/react-icons';

/**
 * One intent of the clip inspector: Sound, Timing, Framing, Colour, Areas.
 *
 * The inspector used to be a flat pile of a dozen technical sections, in the
 * order they were built. Grouped by what the user is trying to do, a group
 * they do not need folds away, and the ones they do read as a short list of
 * questions rather than a wall of sliders.
 *
 * Folding must never hide work. A collapsed group that holds settings shows a
 * dot, and a group whose content grows (a blurred area added from the Clip
 * menu, a mask switched on) opens itself: an action that lands somewhere
 * invisible is an action the user repeats.
 */

const STORAGE_KEY = 'selfcut.inspector.groups';

export type InspectorGroupId = 'sound' | 'timing' | 'framing' | 'color' | 'colorAdvanced' | 'areas';

function readStored(): Partial<Record<InspectorGroupId, boolean>> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<InspectorGroupId, boolean>>;
  } catch {
    return {};
  }
}

function writeStored(id: InspectorGroupId, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), [id]: open }));
  } catch {
    /* private mode / no storage - the fold just will not persist */
  }
}

/**
 * Whether a group is open. Per machine, not per clip: folding Colour is a
 * habit ("I never grade"), not a fact about one shot.
 *
 * `activity` counts what the group holds for this clip. When it rises, or
 * `reveal` turns true, the group opens and remembers being open.
 */
export function useGroupOpen(
  id: InspectorGroupId,
  defaultOpen: boolean,
  activity: number,
  reveal = false,
): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => readStored()[id] ?? (defaultOpen || activity > 0));
  const setOpen = (next: boolean) => {
    setOpenState(next);
    writeStored(id, next);
  };
  const lastActivity = useRef(activity);
  // Read through a ref, not watched: a user folding the group must not reopen it.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const grew = activity > lastActivity.current;
    lastActivity.current = activity;
    if ((grew || reveal) && !openRef.current) {
      setOpenState(true);
      writeStored(id, true);
    }
  }, [activity, reveal, id]);
  return [open, setOpen];
}

export function InspectorGroup({
  id,
  title,
  defaultOpen = true,
  activity = 0,
  reveal = false,
  nested = false,
  children,
}: {
  id: InspectorGroupId;
  title: string;
  defaultOpen?: boolean;
  /** How many settings the group holds for this clip; 0 = nothing set. */
  activity?: number;
  /** Force the group open, e.g. while one of its regions is selected. */
  reveal?: boolean;
  /** A sub-group (Colour > Advanced): lighter header, no top rule. */
  nested?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useGroupOpen(id, defaultOpen, activity, reveal);
  const bodyId = `inspector-group-${id}`;
  return (
    <section className={nested ? 'space-y-3' : 'space-y-3 border-t border-zinc-700/70 pt-3'} data-inspector-group={id}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className={`touch-hit flex w-full items-center gap-2 rounded-md text-left hover:text-zinc-100 pointer-coarse:min-h-11 ${
          nested ? 'text-xs font-medium text-zinc-400' : 'text-sm font-semibold text-zinc-200'
        }`}
      >
        <ChevronDownIcon
          aria-hidden
          className={`h-4 w-4 flex-none text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {!open && activity > 0 && (
          // Text, not an image role: a button's children are presentational,
          // so the dot alone would never reach a screen reader.
          <>
            <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-blue-400" />
            <span className="sr-only">{t('inspector.group.active')}</span>
          </>
        )}
      </button>
      {open && (
        <div id={bodyId} className="space-y-3">
          {children}
        </div>
      )}
    </section>
  );
}
