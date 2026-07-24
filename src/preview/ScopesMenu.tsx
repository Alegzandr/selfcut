import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Check } from 'lucide-react';
import { useStore } from '../store/store';
import { useIsCoarsePointer } from '../lib/device';
import { SCOPE_MODES, type ScopeMode } from './scopes';

const OPTIONS: readonly ScopeMode[] = ['off', ...SCOPE_MODES];

/**
 * Video-scopes picker, pinned to the monitor's bottom-left corner (the quality
 * rung owns the bottom-right). Opens the waveform, RGB parade, histogram or
 * vectorscope over the frame — a colourist's instruments, a fine-pointer habit,
 * so it is desktop only like the monitor toolbar.
 */
export function ScopesMenu() {
  const { t } = useTranslation();
  const mode = useStore((s) => s.scopesMode);
  const coarse = useIsCoarsePointer();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (coarse) return null;

  return (
    <div ref={rootRef} className="absolute bottom-2 left-2 z-20">
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-1.5 w-36 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900/95 py-1 shadow-xl shadow-black/50 backdrop-blur"
        >
          {OPTIONS.map((opt) => (
            <button
              key={opt}
              role="menuitemradio"
              aria-checked={mode === opt}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                mode === opt ? 'text-sky-300' : 'text-zinc-300 hover:bg-zinc-800'
              }`}
              onClick={() => {
                useStore.getState().setScopesMode(opt);
                setOpen(false);
              }}
            >
              <Check className={`h-3.5 w-3.5 flex-none ${mode === opt ? '' : 'invisible'}`} />
              <span className="flex-1">{t(`preview.scopes.${opt}`)}</span>
            </button>
          ))}
        </div>
      )}

      <button
        aria-label={t('preview.scopes.title')}
        title={`${t('preview.scopes.title')} · ${t('preview.scopes.hint')}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`touch-hit flex items-center gap-1.5 rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2 py-1 text-2xs font-medium backdrop-blur transition-colors hover:bg-zinc-800/80 ${
          mode !== 'off' ? 'text-sky-300' : 'text-zinc-300'
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        <Activity className="h-3.5 w-3.5" />
        {mode !== 'off' && <span>{t(`preview.scopes.${mode}`)}</span>}
      </button>
    </div>
  );
}
