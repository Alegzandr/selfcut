import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/store';
import { Tooltip } from '../../ui/Tooltip';
import { ToggleButton } from '../../ui/ToggleButton';
import { SliderRow } from '../SliderRow';
import { ClipShape, ShapeClip } from '../../types';

const KINDS = ['rect', 'ellipse', 'polygon'] as const;
/** Stroke width is a fraction of the output height; this caps it at 5%. */
const MAX_STROKE = 0.05;

export function ShapeSection({ clip }: { clip: ShapeClip }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted, beginGesture, endGesture } = useStore.getState();
  const shape = clip.shape;

  /** Live edit (dragging a slider): one undo step, closed by endGesture. */
  const setShape = (patch: Partial<ClipShape>) =>
    updateClip(clip.id, { shape: { ...shape, ...patch } });
  /** One-shot edit (a button): its own undo step. */
  const commitShape = (patch: Partial<ClipShape>) =>
    updateClipCommitted(clip.id, { shape: { ...shape, ...patch } });

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
              setShape({
                stroke: e.target.value,
                // Picking a stroke colour with no width would do nothing visible.
                strokeWidth: shape.strokeWidth > 0 ? shape.strokeWidth : 0.006,
              })
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
        onChange={(v) => setShape({ strokeWidth: v, stroke: shape.stroke ?? shape.fill })}
      />

      {shape.kind === 'rect' && (
        <SliderRow
          label={t('inspector.shape.radius')}
          value={shape.radius}
          min={0}
          max={0.5}
          step={0.01}
          format={(v) => `${Math.round((v / 0.5) * 100)} %`}
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
          onChange={(v) => setShape({ sides: Math.round(v) })}
        />
      )}
    </div>
  );
}
