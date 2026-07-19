import { useTranslation } from 'react-i18next';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { useStore } from '../../store/store';
import { Tooltip } from '../../ui/Tooltip';
import { ToggleButton } from '../../ui/ToggleButton';
import { ClipText, TextAlign, TextClip } from '../../types';
import { DEFAULT_TEXT_WIDTH_FRAC } from '../../model';
import { DEFAULT_FONT_ID, FONTS, fontStack, loadFonts } from '../../lib/fonts';
import { SliderRow } from '../SliderRow';
import { pct } from '../format';

const ALIGNMENTS: { value: TextAlign; icon: typeof AlignLeft }[] = [
  { value: 'left', icon: AlignLeft },
  { value: 'center', icon: AlignCenter },
  { value: 'right', icon: AlignRight },
];

export function TextSection({ clip }: { clip: TextClip }) {
  const { t } = useTranslation();
  const { updateClip, updateClipCommitted, beginGesture, endGesture } = useStore.getState();
  const text = clip.text;
  const setText = (patch: Partial<ClipText>) =>
    updateClip(clip.id, { text: { ...text, ...patch } });
  /** Discrete choices commit straight away - there is no drag to coalesce. */
  const commitText = (patch: Partial<ClipText>) =>
    updateClipCommitted(clip.id, { text: { ...text, ...patch } });
  const align = text.align ?? 'center';

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
        <span className="w-16 flex-none">{t('inspector.font')}</span>
        <select
          value={text.font ?? DEFAULT_FONT_ID}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          // Each option renders in its own face, which only works once the face
          // is registered - fetched when the user reaches for the list, not on
          // every text selection.
          onPointerDown={() => void loadFonts(FONTS.map((f) => f.id))}
          onChange={(e) => commitText({ font: e.target.value as ClipText['font'] })}
        >
          {FONTS.map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: fontStack(f.id) }}>
              {f.family}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.style')}</span>
        <Tooltip label={t('inspector.textColor')}>
          <input
            type="color"
            value={text.color}
            className="h-7 w-10 flex-none cursor-pointer rounded border border-zinc-700 bg-zinc-800"
            onFocus={beginGesture}
            onBlur={endGesture}
            onChange={(e) => setText({ color: e.target.value })}
          />
        </Tooltip>
        <Tooltip label={t('inspector.bold')}>
          <ToggleButton
            className="font-bold"
            active={!!text.bold}
            onClick={() => commitText({ bold: !text.bold })}
          >
            {/* The glyph itself is localised: "B" in English, "G" (gras) in French. */}
            {t('inspector.bold.short')}
          </ToggleButton>
        </Tooltip>
        <Tooltip label={t('inspector.outline.hint')}>
          <ToggleButton active={!!text.outline} onClick={() => commitText({ outline: !text.outline })}>
            {t('inspector.outline')}
          </ToggleButton>
        </Tooltip>
        <Tooltip label={t('inspector.box.hint')}>
          <ToggleButton
            active={!!text.background}
            onClick={() => commitText({ background: !text.background })}
          >
            {t('inspector.box')}
          </ToggleButton>
        </Tooltip>
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-16 flex-none">{t('inspector.align')}</span>
        {ALIGNMENTS.map(({ value, icon: Icon }) => (
          <Tooltip key={value} label={t(`inspector.align.${value}`)}>
            <ToggleButton active={align === value} onClick={() => commitText({ align: value })}>
              <Icon className="h-4 w-4" />
            </ToggleButton>
          </Tooltip>
        ))}
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
      <SliderRow
        label={t('inspector.textWidth')}
        hint={t('inspector.textWidth.hint')}
        value={text.widthFrac ?? DEFAULT_TEXT_WIDTH_FRAC}
        min={0.2}
        max={1}
        step={0.05}
        format={pct}
        onChange={(v) => setText({ widthFrac: v })}
      />
    </div>
  );
}
