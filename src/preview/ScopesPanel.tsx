import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useStore } from '../store/store';
import { useIsCoarsePointer } from '../lib/device';
import { subscribeScopeFrame, type ScopeFrame } from './scopeBus';
import {
  SCOPE_LEVELS,
  computeHistogram,
  computeVectorscope,
  computeWaveform,
  type ScopeChannel,
  type ScopeMode,
} from './scopes';

/**
 * Video scopes overlay — a colourist's instruments docked on the monitor. The
 * playback engine publishes a small RGBA snapshot of every composited frame (via
 * `scopeBus`, only while this is mounted); here we turn it into the waveform, RGB
 * parade, histogram or vectorscope so exposure and colour can be judged by the
 * signal instead of by an uncalibrated screen.
 *
 * Desktop only: reading scopes is a fine-pointer, second-screen habit, and the
 * touch layout has no room to float a panel over the frame.
 */

/** Trace brightness per pixel count. Tuned so a mid-density waveform reads well. */
const WAVE_GAIN = 26;
const VECTOR_SIZE = 256;
const VECTOR_GAIN = 55;

/** Graticule colour (the reference grid drawn over every scope). */
const GRID = 'rgba(160, 170, 190, 0.18)';

/** One waveform panel spec: which channel, and the RGB tint its trace paints in. */
interface WavePanel {
  ch: ScopeChannel;
  rgb: [number, number, number];
}

/**
 * Paint one or more column histograms side by side — a single luma trace for the
 * waveform, or R/G/B laid out left-to-right for the parade. Level 255 maps to the
 * top of each panel, 0 to the bottom, and the trace brightens where more pixels
 * of a column share a level.
 */
function paintWaveform(canvas: HTMLCanvasElement, frame: ScopeFrame, panels: WavePanel[]): void {
  const cols = frame.width;
  const levels = SCOPE_LEVELS;
  const iw = cols * panels.length;
  const ih = levels;
  if (canvas.width !== iw) canvas.width = iw;
  if (canvas.height !== ih) canvas.height = ih;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const img = ctx.createImageData(iw, ih);
  const buf = img.data;
  // Opaque near-black background so the trace glows the way a real scope does.
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 10;
    buf[i + 1] = 11;
    buf[i + 2] = 14;
    buf[i + 3] = 255;
  }

  panels.forEach((panel, p) => {
    const grid = computeWaveform(frame.data, cols, frame.height, panel.ch);
    const [pr, pg, pb] = panel.rgb;
    for (let x = 0; x < cols; x++) {
      const base = x * levels;
      const px = p * cols + x;
      for (let l = 0; l < levels; l++) {
        const count = grid[base + l]!;
        if (!count) continue;
        const intensity = Math.min(255, count * WAVE_GAIN);
        const di = ((levels - 1 - l) * iw + px) * 4;
        buf[di] = Math.min(255, buf[di]! + (intensity * pr) / 255);
        buf[di + 1] = Math.min(255, buf[di + 1]! + (intensity * pg) / 255);
        buf[di + 2] = Math.min(255, buf[di + 2]! + (intensity * pb) / 255);
      }
    }
  });
  ctx.putImageData(img, 0, 0);

  // Graticule: IRE-style horizontals at 0/25/50/75/100 %, plus a divider between
  // parade panels. Drawn in backing pixels, which equal the internal resolution.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let q = 0; q <= 4; q++) {
    const y = Math.round((q / 4) * (ih - 1)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(iw, y);
  }
  for (let p = 1; p < panels.length; p++) {
    const x = p * cols + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ih);
  }
  ctx.stroke();
}

/** RGB tonal distribution as three overlaid filled curves (additive overlap). */
function paintHistogram(canvas: HTMLCanvasElement, frame: ScopeFrame): void {
  const iw = 256;
  const ih = 128;
  if (canvas.width !== iw) canvas.width = iw;
  if (canvas.height !== ih) canvas.height = ih;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { r, g, b, peak } = computeHistogram(frame.data);
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, iw, ih);

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let q = 1; q < 4; q++) {
    const x = Math.round((q / 4) * iw) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ih);
  }
  ctx.stroke();

  const channels: [Uint32Array, string][] = [
    [r, 'rgba(255, 80, 80, 0.75)'],
    [g, 'rgba(70, 230, 110, 0.75)'],
    [b, 'rgba(90, 150, 255, 0.75)'],
  ];
  ctx.globalCompositeOperation = 'lighter';
  for (const [arr, color] of channels) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, ih);
    for (let i = 0; i < 256; i++) {
      const y = ih - (arr[i]! / peak) * (ih - 1);
      ctx.lineTo((i / 255) * iw, y);
    }
    ctx.lineTo(iw, ih);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Position hue → RGB for the vectorscope trace, so primaries land on their targets. */
function hueRgb(angle: number, sat: number): [number, number, number] {
  const h = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
  const k = (n: number) => {
    const t = (n + h * 6) % 6;
    return 1 - Math.max(0, Math.min(Math.min(t, 4 - t), 1));
  };
  const s = Math.min(1, sat);
  return [
    Math.round((1 - s * k(5)) * 255),
    Math.round((1 - s * k(3)) * 255),
    Math.round((1 - s * k(1)) * 255),
  ];
}

/** Chroma density plotted on the Cb/Cr plane, coloured by hue, with a graticule. */
function paintVectorscope(canvas: HTMLCanvasElement, frame: ScopeFrame): void {
  const size = VECTOR_SIZE;
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const grid = computeVectorscope(frame.data, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 10;
    buf[i + 1] = 11;
    buf[i + 2] = 14;
    buf[i + 3] = 255;
  }
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const count = grid[y * size + x]!;
      if (!count) continue;
      const dx = x - half;
      const dy = half - y;
      const radius = Math.min(1, Math.hypot(dx, dy) / half);
      const [hr, hg, hb] = hueRgb(Math.atan2(dy, dx), 0.4 + radius * 0.6);
      const intensity = Math.min(255, count * VECTOR_GAIN) / 255;
      const di = (y * size + x) * 4;
      buf[di] = Math.min(255, buf[di]! + hr * intensity);
      buf[di + 1] = Math.min(255, buf[di + 1]! + hg * intensity);
      buf[di + 2] = Math.min(255, buf[di + 2]! + hb * intensity);
    }
  }
  ctx.putImageData(img, 0, 0);

  // Graticule: outer circle + crosshair, the neutral reference of a vectorscope.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(half, half, half - 2, 0, Math.PI * 2);
  ctx.moveTo(0, half);
  ctx.lineTo(size, half);
  ctx.moveTo(half, 0);
  ctx.lineTo(half, size);
  ctx.stroke();
}

function paint(canvas: HTMLCanvasElement, frame: ScopeFrame, mode: ScopeMode): void {
  switch (mode) {
    case 'waveform':
      paintWaveform(canvas, frame, [{ ch: 'luma', rgb: [220, 226, 236] }]);
      break;
    case 'parade':
      paintWaveform(canvas, frame, [
        { ch: 'r', rgb: [255, 80, 80] },
        { ch: 'g', rgb: [70, 230, 110] },
        { ch: 'b', rgb: [90, 150, 255] },
      ]);
      break;
    case 'histogram':
      paintHistogram(canvas, frame);
      break;
    case 'vectorscope':
      paintVectorscope(canvas, frame);
      break;
    case 'off':
      break;
  }
}

export function Scopes() {
  const { t } = useTranslation();
  const mode = useStore((s) => s.scopesMode);
  const coarse = useIsCoarsePointer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastFrame = useRef<ScopeFrame | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (mode === 'off' || coarse) return;
    const render = () => {
      rafRef.current = 0;
      const frame = lastFrame.current;
      const canvas = canvasRef.current;
      if (frame && canvas) paint(canvas, frame, mode);
    };
    const unsub = subscribeScopeFrame((frame) => {
      lastFrame.current = frame;
      // Coalesce bursts (playback can publish at 60fps) into one paint per frame.
      if (!rafRef.current) rafRef.current = requestAnimationFrame(render);
    });
    // Switching modes pushes no new frame (the listener count is unchanged), so
    // redraw straight away from the frame already in hand.
    if (lastFrame.current) render();
    return () => {
      unsub();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [mode, coarse]);

  if (mode === 'off' || coarse) return null;

  return (
    <div className="absolute right-2 top-2 z-20 w-56 overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/80 shadow-xl shadow-black/50 backdrop-blur">
      <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1">
        <span className="text-2xs font-medium uppercase tracking-wide text-zinc-400">
          {t(`preview.scopes.${mode}`)}
        </span>
        <button
          aria-label={t('preview.scopes.off')}
          title={t('preview.scopes.off')}
          className="touch-hit rounded p-0.5 text-zinc-500 hover:bg-zinc-800/80 hover:text-zinc-200"
          onClick={() => useStore.getState().setScopesMode('off')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <canvas ref={canvasRef} className="block h-auto w-full" />
    </div>
  );
}
