import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Crop, LayoutPanelTop, RotateCcw, Trash2, X } from 'lucide-react';
import { useStore, getSelectedClip } from '../store/store';
import { Clip, ClipTransform, DEFAULT_TRANSFORM } from '../types';
import { useIsCoarsePointer } from '../lib/device';
import i18n from '../i18n';

// Slider read-outs are numbers, so they follow the locale, not the dictionary:
// "50 %" in French, "1,5 s" instead of "1.5s".
const pct = (v: number) =>
  new Intl.NumberFormat(i18n.language, { style: 'percent' }).format(v);
const seconds = (ms: number) =>
  new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms / 1000);

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
  const { t } = useTranslation();
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
      <span className="w-16 flex-none">{t('inspector.speed')}</span>
      {[0.5, 1, 1.5, 2].map((s) => (
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
  const { t } = useTranslation();
  const clip = useStore(getSelectedClip);
  const asset = useStore((s) => (clip ? s.assets[clip.assetId] : undefined));
  const coarse = useIsCoarsePointer();
  const inspectorOpen = useStore((s) => s.inspectorOpen);

  // Desktop: docked column next to the preview - it must never cover the
  // timeline, that is where the cutting happens. Mobile: bottom sheet opened
  // on demand from the clip action bar ("Adjust"), CapCut-style.
  if (!coarse) {
    if (!clip) return null;
    return (
      <div className="w-72 flex-none space-y-3 overflow-y-auto border-l border-zinc-800 bg-zinc-900/60 p-3">
        <InspectorBody
          clip={clip}
          isVideo={asset?.kind === 'video'}
          hasAudio={asset?.hasAudio ?? false}
          name={clip.text ? t('inspector.textClip') : clip.solid ? t(`inspector.solid.${clip.solid.kind}`) : asset?.file.name ?? ''}
        />
      </div>
    );
  }

  const show = clip && inspectorOpen;
  return (
    <AnimatePresence>
      {show && clip && (
        <motion.div
          key={clip.id}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[55dvh] space-y-3 overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black"
        >
          <InspectorBody
            clip={clip}
            isVideo={asset?.kind === 'video'}
            hasAudio={asset?.hasAudio ?? false}
            name={clip.text ? t('inspector.textClip') : clip.solid ? t(`inspector.solid.${clip.solid.kind}`) : asset?.file.name ?? ''}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TextSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClip, beginGesture, endGesture } = useStore.getState();
  const text = clip.text!;
  const setText = (patch: Partial<NonNullable<Clip['text']>>) =>
    updateClip(clip.id, { text: { ...text, ...patch } });

  return (
    <div className="space-y-3">
      <textarea
        value={text.content}
        rows={2}
        placeholder={t('inspector.textPlaceholder')}
        className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
        onFocus={beginGesture}
        onBlur={endGesture}
        onChange={(e) => setText({ content: e.target.value })}
      />
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.style')}</span>
        <input
          type="color"
          value={text.color}
          className="h-7 w-10 flex-none cursor-pointer rounded border border-zinc-700 bg-zinc-800"
          title={t('inspector.textColor')}
          onFocus={beginGesture}
          onBlur={endGesture}
          onChange={(e) => setText({ color: e.target.value })}
        />
        <button
          className={`rounded-md px-2 py-1 font-bold ${text.bold ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
          onClick={() => useStore.getState().updateClipCommitted(clip.id, { text: { ...text, bold: !text.bold } })}
          title={t('inspector.bold')}
        >
          {/* The glyph itself is localised: "B" in English, "G" (gras) in French. */}
          {t('inspector.bold.short')}
        </button>
        <button
          className={`rounded-md px-2 py-1 ${text.outline ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
          onClick={() => useStore.getState().updateClipCommitted(clip.id, { text: { ...text, outline: !text.outline } })}
          title={t('inspector.outline.hint')}
        >
          {t('inspector.outline')}
        </button>
        <button
          className={`rounded-md px-2 py-1 ${text.background ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
          onClick={() => useStore.getState().updateClipCommitted(clip.id, { text: { ...text, background: !text.background } })}
          title={t('inspector.box.hint')}
        >
          {t('inspector.box')}
        </button>
      </div>
      <SliderRow
        label={t('inspector.size')}
        value={text.sizeFrac}
        min={0.02}
        max={0.3}
        step={0.005}
        format={pct}
        onChange={(v) => setText({ sizeFrac: v })}
      />
    </div>
  );
}

function SolidSection({ clip }: { clip: Clip }) {
  const { t } = useTranslation();
  const { updateClip, beginGesture, endGesture } = useStore.getState();
  const solid = clip.solid!;
  const setSolid = (patch: Partial<NonNullable<Clip['solid']>>) =>
    updateClip(clip.id, { solid: { ...solid, ...patch } });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.fill')}</span>
        {(['color', 'gradient'] as const).map((kind) => (
          <button key={kind} className={`rounded-md px-2 py-1 ${solid.kind === kind ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`} onClick={() => useStore.getState().updateClipCommitted(clip.id, { solid: { ...solid, kind } })}>
            {t(`inspector.solid.${kind}`)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.colors')}</span>
        <input type="color" value={solid.color} className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800" title={t('inspector.solid.firstColor')} onFocus={beginGesture} onBlur={endGesture} onChange={(e) => setSolid({ color: e.target.value })} />
        {solid.kind === 'gradient' && <input type="color" value={solid.color2 ?? solid.color} className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800" title={t('inspector.solid.secondColor')} onFocus={beginGesture} onBlur={endGesture} onChange={(e) => setSolid({ color2: e.target.value })} />}
      </div>
      {solid.kind === 'gradient' && (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="w-16 flex-none">{t('inspector.direction')}</span>
          {[0, 45, 90, 135].map((angle) => <button key={angle} className={`rounded-md px-2 py-1 ${solid.angle === angle ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`} onClick={() => useStore.getState().updateClipCommitted(clip.id, { solid: { ...solid, angle } })}>{angle}°</button>)}
        </div>
      )}
    </div>
  );
}

function InspectorBody({
  clip,
  isVideo,
  hasAudio,
  name,
}: {
  clip: Clip;
  isVideo: boolean;
  hasAudio: boolean;
  name: string;
}) {
  const { t } = useTranslation();
  const { updateClip, deleteClip, selectClip, updateClipCommitted, setInspectorOpen, setCropEditing } =
    useStore.getState();
  const cropEditing = useStore((s) => s.cropEditing);
  const coarse = useIsCoarsePointer();
  const isText = clip.text != null;
  const isSolid = clip.solid != null;
  const tf: ClipTransform = clip.transform ?? DEFAULT_TRANSFORM;
  const setTf = (patch: Partial<ClipTransform>) =>
    updateClip(clip.id, { transform: { ...tf, ...patch } });
  const setCrop = (patch: Partial<ClipTransform['crop']>) =>
    updateClip(clip.id, { transform: { ...tf, crop: { ...tf.crop, ...patch } } });

  // Pan read-out: the letter is the localised initial of Center/Left/Right.
  const pan = (v: number) => {
    if (v === 0) return t('inspector.pan.center');
    const side = v < 0 ? t('inspector.pan.left') : t('inspector.pan.right');
    return `${side}${Math.round(Math.abs(v) * 100)}`;
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{name}</h2>
        <button
          className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800"
          onClick={() => deleteClip(clip.id)}
          title={t('inspector.deleteClip')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          className="rounded-lg p-1.5 text-zinc-400 active:bg-zinc-800"
          onClick={() => (coarse ? setInspectorOpen(false) : selectClip(null))}
          title={t('inspector.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isText && <TextSection clip={clip} />}
      {isSolid && <SolidSection clip={clip} />}

      {hasAudio && (
        <>
          <SliderRow
            label={t('inspector.volume')}
            value={clip.volume}
            min={0}
            max={2}
            step={0.01}
            format={pct}
            onChange={(v) => updateClip(clip.id, { volume: v })}
          />
          <SliderRow
            label={t('inspector.balance')}
            value={clip.pan ?? 0}
            min={-1}
            max={1}
            step={0.01}
            format={pan}
            onChange={(v) => updateClip(clip.id, { pan: v })}
          />
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <span className="w-16 flex-none">{t('inspector.channels')}</span>
            <button
              className={`rounded-md px-2 py-1 ${!clip.mono ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
              onClick={() => updateClipCommitted(clip.id, { mono: false })}
            >
              {t('inspector.stereo')}
            </button>
            <button
              className={`rounded-md px-2 py-1 ${clip.mono ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
              onClick={() => updateClipCommitted(clip.id, { mono: true })}
            >
              {t('inspector.mono')}
            </button>
          </div>
        </>
      )}
      {!isText && <SpeedControl clip={clip} />}
      <SliderRow
        label={t('inspector.fadeIn')}
        value={clip.fadeInMs}
        min={0}
        max={5000}
        step={100}
        format={seconds}
        onChange={(v) => updateClip(clip.id, { fadeInMs: v })}
      />
      <SliderRow
        label={t('inspector.fadeOut')}
        value={clip.fadeOutMs}
        min={0}
        max={5000}
        step={100}
        format={seconds}
        onChange={(v) => updateClip(clip.id, { fadeOutMs: v })}
      />

      {isVideo && (
        <SliderRow
          label="Zoom anim"
          value={clip.zoomEnd ?? 1}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => (v === 1 ? 'off' : `→${Math.round(v * 100)}%`)}
          onChange={(v) => updateClip(clip.id, { zoomEnd: v })}
        />
      )}

      {(isVideo || isText) && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t('inspector.transform')}
            </h3>
            <button
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800"
              onClick={() => updateClipCommitted(clip.id, { transform: undefined })}
            >
              <RotateCcw className="h-3 w-3" />
              {t('inspector.reset')}
            </button>
          </div>
          {isVideo && (
            <div className="flex items-center gap-2">
              <button
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium ${cropEditing ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'}`}
                onClick={() => setCropEditing(!cropEditing)}
                title="Adjust the crop by dragging a rectangle in the preview"
              >
                <Crop className="h-3.5 w-3.5" />
                {cropEditing ? 'Done cropping' : 'Edit crop'}
              </button>
              <button
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1.5 text-[11px] font-medium text-zinc-300 active:bg-zinc-700"
                onClick={() => useStore.getState().applyStreamLayout(clip.id)}
                title="Facecam band on top, gameplay below - then adjust both crops"
              >
                <LayoutPanelTop className="h-3.5 w-3.5" />
                Stream layout
              </button>
            </div>
          )}
          {/* 16:9 vers 9:16 en "cover" demande 3,16x : le max doit laisser de la marge au-dela. */}
          <SliderRow label={t('inspector.scale')} value={tf.scale} min={0.1} max={4} step={0.01} format={pct} onChange={(v) => setTf({ scale: v })} />
          <SliderRow label={t('inspector.positionX')} value={tf.x} min={0} max={1} step={0.01} format={pct} onChange={(v) => setTf({ x: v })} />
          <SliderRow label={t('inspector.positionY')} value={tf.y} min={0} max={1} step={0.01} format={pct} onChange={(v) => setTf({ y: v })} />
          {isVideo && (
            <>
              <SliderRow label={t('inspector.cropLeft')} value={tf.crop.x} min={0} max={0.9} step={0.01} format={pct} onChange={(v) => setCrop({ x: v, w: Math.min(tf.crop.w, 1 - v) })} />
              <SliderRow label={t('inspector.cropTop')} value={tf.crop.y} min={0} max={0.9} step={0.01} format={pct} onChange={(v) => setCrop({ y: v, h: Math.min(tf.crop.h, 1 - v) })} />
              <SliderRow label={t('inspector.cropWidth')} value={tf.crop.w} min={0.05} max={1} step={0.01} format={pct} onChange={(v) => setCrop({ w: Math.min(v, 1 - tf.crop.x) })} />
              <SliderRow label={t('inspector.cropHeight')} value={tf.crop.h} min={0.05} max={1} step={0.01} format={pct} onChange={(v) => setCrop({ h: Math.min(v, 1 - tf.crop.y) })} />
            </>
          )}
        </div>
      )}
    </>
  );
}
