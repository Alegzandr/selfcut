import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Tooltip } from '../../ui/Tooltip';
import { ToggleButton } from '../../ui/ToggleButton';
import { PERCENT_ENTRY, SliderRow, scaledEntry } from '../SliderRow';
import { Clip, ClipShape, ShapeClip } from '../../types';

const KINDS = ['rect', 'ellipse', 'polygon'] as const;
/** What a freshly drawn shape carries, and what a double-click returns to. */
const DEFAULT_STROKE_WIDTH = 0;
const DEFAULT_RADIUS = 0;
const DEFAULT_SIDES = 5;
/** Stroke width is a fraction of the output height; this caps it at 5%. */
const MAX_STROKE = 0.05;

export function ShapeSection({ clip }: { clip: ShapeClip }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted, beginGesture, endGesture } = useStore.getState();
  const shape = clip.shape;

  /**
   * Merged per clip, so changing the fill of a multi-selection does not also
   * turn every selected shape into this one's kind.
   */
  type ShapePatch = Partial<ClipShape> | ((s: ClipShape) => Partial<ClipShape>);
  const shapePatch = (patch: ShapePatch) => (c: Clip) =>
    c.kind === 'shape'
      ? { shape: { ...c.shape, ...(typeof patch === 'function' ? patch(c.shape) : patch) } }
      : {};
  /** Live edit (dragging a slider): one undo step, closed by endGesture. */
  const setShape = (patch: ShapePatch) => updateClip(clip.id, shapePatch(patch));
  /** One-shot edit (a button): its own undo step. */
  const commitShape = (patch: ShapePatch) => updateClipCommitted(clip.id, shapePatch(patch));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.shape.kind')}</span>
        {KINDS.map((kind) => (
          <ToggleButton key={kind} active={shape.kind === kind} onClick={() => commitShape({ kind })}>
            {t(`preview.shape.${kind}`)}
          </ToggleButton>
        ))}
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.fill')}</span>
        <Tooltip label={t('inspector.shape.fill')}>
          <input
            type="color"
            value={shape.fill}
            className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800"
            onFocus={beginGesture}
            onBlur={endGesture}
            onChange={(e) => setShape({ fill: e.target.value })}
          />
        </Tooltip>
        <Tooltip label={t('inspector.shape.stroke')}>
          <input
            type="color"
            // No stroke yet: offer the fill colour as the starting point rather
            // than a black swatch that reads as "already set to black".
            value={shape.stroke ?? shape.fill}
            className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800"
            onFocus={beginGesture}
            onBlur={endGesture}
            onChange={(e) =>
              setShape((s) => ({
                stroke: e.target.value,
                // Picking a stroke colour with no width would do nothing visible.
                strokeWidth: s.strokeWidth > 0 ? s.strokeWidth : 0.006,
              }))
            }
          />
        </Tooltip>
      </div>

      <SliderRow
        label={t('inspector.shape.strokeWidth')}
        value={shape.strokeWidth}
        min={0}
        max={MAX_STROKE}
        step={0.001}
        format={(v) => (v <= 0 ? t('inspector.shape.noStroke') : `${(v * 100).toFixed(1)} %`)}
        entry={PERCENT_ENTRY}
        defaultValue={DEFAULT_STROKE_WIDTH}
        onChange={(v) => setShape((s) => ({ strokeWidth: v, stroke: s.stroke ?? s.fill }))}
      />

      {/* The radius read-out is a share of the 0.5 maximum, not of the side:
          100 % is a fully rounded corner, which is half a side. */}
      {shape.kind === 'rect' && (
        <SliderRow
          label={t('inspector.shape.radius')}
          value={shape.radius}
          min={0}
          max={0.5}
          step={0.01}
          format={(v) => `${Math.round((v / 0.5) * 100)} %`}
          entry={scaledEntry(200)}
          defaultValue={DEFAULT_RADIUS}
          onChange={(v) => setShape({ radius: v })}
        />
      )}

      {shape.kind === 'polygon' && (
        <SliderRow
          label={t('inspector.shape.sides')}
          value={shape.sides}
          min={3}
          max={12}
          step={1}
          format={(v) => String(Math.round(v))}
          defaultValue={DEFAULT_SIDES}
          onChange={(v) => setShape({ sides: Math.round(v) })}
        />
      )}
    </div>
  );
}
