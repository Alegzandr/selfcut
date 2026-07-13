import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { useStore, getSelectedClip } from '../store/store';
import { Clip, ClipTransform, DEFAULT_TRANSFORM } from '../types';
import { useIsCoarsePointer } from '../lib/device';

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { beginGesture, endGesture } = useStore.getState();
  return (
    <label className="flex items-center gap-3 text-xs text-zinc-400">
      <span className="w-16 flex-none">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        className="min-w-0 flex-1 accent-sky-500"
        onPointerDown={beginGesture}
        onPointerUp={endGesture}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-14 flex-none text-right font-mono tabular-nums text-zinc-300">
        {format(value)}
      </span>
    </label>
  );
}

function SpeedControl({ clip }: { clip: Clip }) {
  const { updateClipCommitted } = useStore.getState();
  const [text, setText] = useState(String(clip.speed));
  useEffect(() => setText(String(clip.speed)), [clip.id, clip.speed]);

  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (isFinite(v) && v >= 0.1 && v <= 8) updateClipCommitted(clip.id, { speed: v });
    else setText(String(clip.speed));
  };

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      <span className="w-16 flex-none">Speed</span>
      {[0.5, 1, 2].map((s) => (
        <button
          key={s}
          className={`rounded-md px-2 py-1 ${clip.speed === s ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
          onClick={() => updateClipCommitted(clip.id, { speed: s })}
        >
          {s}×
        </button>
      ))}
      <input
        type="number"
        inputMode="decimal"
        min={0.1}
        max={8}
        step={0.1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-zinc-200 outline-none focus:border-sky-500"
      />
      <span>×</span>
    </div>
  );
}

export function Inspector() {
  const clip = useStore(getSelectedClip);
  const asset = useStore((s) => (clip ? s.assets[clip.assetId] : undefined));
  const coarse = useIsCoarsePointer();
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  // Desktop: docked panel, always visible for the selection. Mobile: opens on demand
  // from the clip action bar ("Adjust"), CapCut-style.
  const show = clip && (!coarse || inspectorOpen);

  return (
    <AnimatePresence>
      {show && clip && (
        <motion.div
          key={clip.id}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[55dvh] space-y-3 overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black md:bottom-3 md:left-auto md:right-3 md:w-96 md:rounded-2xl md:border"
        >
          <InspectorBody clip={clip} isVideo={asset?.kind === 'video'} name={asset?.file.name ?? ''} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function InspectorBody({ clip, isVideo, name }: { clip: Clip; isVideo: boolean; name: string }) {
  const { updateClip, deleteClip, selectClip, updateClipCommitted, setInspectorOpen } = useStore.getState();
  const coarse = useIsCoarsePointer();
  const tf: ClipTransform = clip.transform ?? DEFAULT_TRANSFORM;
  const setTf = (patch: Partial<ClipTransform>) =>
    updateClip(clip.id, { transform: { ...tf, ...patch } });
  const setCrop = (patch: Partial<ClipTransform['crop']>) =>
    updateClip(clip.id, { transform: { ...tf, crop: { ...tf.crop, ...patch } } });

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const ms = (v: number) => `${(v / 1000).toFixed(1)}s`;

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{name}</h2>
        <button
          className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800"
          onClick={() => deleteClip(clip.id)}
          title="Delete clip"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800"
          onClick={() => (coarse ? setInspectorOpen(false) : selectClip(null))}
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <SliderRow
        label="Volume"
        value={clip.volume}
        min={0}
        max={2}
        step={0.01}
        format={pct}
        onChange={(v) => updateClip(clip.id, { volume: v })}
      />
      <SpeedControl clip={clip} />
      <SliderRow
        label="Fade in"
        value={clip.fadeInMs}
        min={0}
        max={5000}
        step={100}
        format={ms}
        onChange={(v) => updateClip(clip.id, { fadeInMs: v })}
      />
      <SliderRow
        label="Fade out"
        value={clip.fadeOutMs}
        min={0}
        max={5000}
        step={100}
        format={ms}
        onChange={(v) => updateClip(clip.id, { fadeOutMs: v })}
      />

      {isVideo && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Transform
            </h3>
            <button
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
              onClick={() => updateClipCommitted(clip.id, { transform: undefined })}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>
          {/* 16:9 vers 9:16 en "cover" demande 3,16x : le max doit laisser de la marge au-dela. */}
          <SliderRow label="Scale" value={tf.scale} min={0.1} max={4} step={0.01} format={pct} onChange={(v) => setTf({ scale: v })} />
          <SliderRow label="Position X" value={tf.x} min={0} max={1} step={0.01} format={pct} onChange={(v) => setTf({ x: v })} />
          <SliderRow label="Position Y" value={tf.y} min={0} max={1} step={0.01} format={pct} onChange={(v) => setTf({ y: v })} />
          <SliderRow label="Crop left" value={tf.crop.x} min={0} max={0.9} step={0.01} format={pct} onChange={(v) => setCrop({ x: v, w: Math.min(tf.crop.w, 1 - v) })} />
          <SliderRow label="Crop top" value={tf.crop.y} min={0} max={0.9} step={0.01} format={pct} onChange={(v) => setCrop({ y: v, h: Math.min(tf.crop.h, 1 - v) })} />
          <SliderRow label="Crop width" value={tf.crop.w} min={0.05} max={1} step={0.01} format={pct} onChange={(v) => setCrop({ w: Math.min(v, 1 - tf.crop.x) })} />
          <SliderRow label="Crop height" value={tf.crop.h} min={0.05} max={1} step={0.01} format={pct} onChange={(v) => setCrop({ h: Math.min(v, 1 - tf.crop.y) })} />
        </div>
      )}
    </>
  );
}
