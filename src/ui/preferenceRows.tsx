import type { ReactNode } from 'react';

/**
 * The building blocks of a Preferences section, shared with the sections that
 * live in their own file (the storage location, for one).
 */

/** One labelled preference row: description on the left, control on the right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-xs text-zinc-300">{label}</span>
      {children}
    </div>
  );
}

/** Rows in a section, hairline-separated the way the single list used to be. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-hair">{children}</div>;
}

/** The secondary button of a row: a bordered pill next to the value it acts on. */
export const ROW_BUTTON_CLASS =
  'rounded-lg border border-hair-strong bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 hover:border-zinc-600 disabled:cursor-default disabled:opacity-50';
