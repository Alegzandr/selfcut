import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Circle, Pentagon, RectangleHorizontal } from 'lucide-react';
import type { ClipShape } from '../types';
import { useStore } from '../store/store';
import { Tooltip } from './Tooltip';

const SHAPES: readonly {
  kind: ClipShape['kind'];
  icon: ComponentType<{ className?: string }>;
  labelKey: ParseKeys;
}[] = [
  { kind: 'rect', icon: RectangleHorizontal, labelKey: 'preview.shape.rect' },
  { kind: 'ellipse', icon: Circle, labelKey: 'preview.shape.ellipse' },
  { kind: 'polygon', icon: Pentagon, labelKey: 'preview.shape.polygon' },
];

/**
 * The shape tool: one button that activates drawing, plus a flyout to pick the
 * primitive - the corner notch is the same affordance Adobe uses for a tool
 * group. The button's icon is whichever shape is armed, so the toolbar always
 * says what a drag would produce.
 *
 * It gets its own component rather than a `commands.ts` entry because it is the
 * only toolbar slot holding a sub-menu; a `Command` is a single action.
 */
export function ShapeToolButton() {
  const { t } = useTranslation();
  const previewTool = useStore((s) => s.previewTool);
  const shapeKind = useStore((s) => s.previewShapeKind);
  const { setPreviewTool, setPreviewShapeKind } = useStore.getState();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = previewTool === 'shape';
  const current = SHAPES.find((s) => s.kind === shapeKind) ?? SHAPES[0]!;
  const Icon = current.icon;

  // Dismiss like any other menu: a click elsewhere, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <Tooltip label={t('preview.tool.shape', { shape: t(current.labelKey) })} shortcut="R">
        <button
          className={`touch-hit relative rounded-md p-1.5 hover:bg-zinc-800/80 ${
            active ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-300'
          }`}
          aria-pressed={active}
          onClick={() => setPreviewTool('shape')}
          // Right-click and long-press both reveal the group, like Adobe.
          onContextMenu={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
        >
          <Icon className="h-4 w-4" />
        </button>
      </Tooltip>

      {/* The corner notch: the "this tool has variants" tell, and the button
          that opens them. A sibling of the tool button rather than a child:
          nested interactive elements are invalid, and screen readers reach only
          one of the two. It overlays the tool button's corner, so it keeps the
          Adobe look while owning its own focus and its own accessible name. */}
      <button
        aria-label={t('preview.shape.pick')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`absolute bottom-0 right-0 rounded-br-md p-0.5 ${
          active ? 'text-sky-300' : 'text-zinc-300'
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden
          className="block h-0 w-0 border-b-[5px] border-l-[5px] border-b-current border-l-transparent opacity-70"
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 min-w-40 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/50"
        >
          {SHAPES.map(({ kind, icon: ShapeIcon, labelKey }) => (
            <button
              key={kind}
              role="menuitemradio"
              aria-checked={kind === shapeKind}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-800 active:bg-zinc-700 ${
                kind === shapeKind ? 'text-sky-300' : 'text-zinc-300'
              }`}
              onClick={() => {
                setPreviewShapeKind(kind);
                setPreviewTool('shape');
                setOpen(false);
              }}
            >
              <ShapeIcon className="h-4 w-4 flex-none" />
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
