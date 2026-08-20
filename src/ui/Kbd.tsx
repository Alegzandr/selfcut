import type { ReactNode } from 'react';

/**
 * A single key legend, drawn as a keycap.
 *
 * One component rather than a class string copied around, because the app
 * spells accelerators in two places that must not drift: the tooltip, where a
 * key is a quiet afterthought next to the label, and the shortcuts panel, where
 * the key *is* the content. `strong` is that difference and nothing else - same
 * shape, same border, same mono face.
 */
export function Kbd({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <kbd
      className={
        'flex-none rounded border border-zinc-700 bg-zinc-800/80 font-mono leading-none tracking-tight ' +
        // `min-w-6` on the strong variant: without it a cap holding a comma or a
        // bracket shrinks to a sliver and reads as an empty box next to `Space`.
        (strong
          ? 'min-w-6 px-1.5 py-1 text-center text-2xs text-zinc-100'
          : 'px-1 py-px text-3xs text-zinc-400')
      }
    >
      {children}
    </kbd>
  );
}
