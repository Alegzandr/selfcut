import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus, Trash2, Type } from 'lucide-react';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { openSubtitlePicker } from '../ui/mediaPicker';
import { useImport } from '../ui/useImport';
import { clipEndMs, isTextClip } from '../model';
import { formatTime } from '../lib/time';
import type { TextClip } from '../types';

/**
 * Cue list: every text clip in the project, in timeline order, editable as
 * plain rows.
 *
 * A caption track is dozens of one-line clips, and retiming or fixing a typo by
 * hunting each one down on the timeline does not scale. This is the same data
 * seen as a document instead of as a strip - selecting a row selects the clip,
 * so the preview, the inspector and the timeline all follow along.
 *
 * Text clips of every origin show up here, not only imported ones: a title card
 * IS a cue as far as this list is concerned, and hiding it would make the list
 * lie about what the project renders.
 */
export function SubtitlesPanel() {
  const { t } = useTranslation();
  const project = useStore((s) => s.project);
  const selectedClipId = useStore((s) => s.selectedClipId);
  const importFiles = useImport();

  // Derived in a memo, not in the selector: a selector runs on every set(), and
  // the playback engine writes the current time 60 times a second.
  const cues = useMemo(
    () =>
      project.tracks
        .flatMap((track) => track.clips)
        .filter(isTextClip)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs),
    [project],
  );

  const importSubtitles = () => openSubtitlePicker((files) => void importFiles(files));

  if (cues.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <Type className="h-7 w-7 text-zinc-600" />
        <p className="text-xs leading-relaxed text-zinc-400">{t('subtitles.empty')}</p>
        <button
          className="flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
          onClick={importSubtitles}
        >
          <FilePlus className="h-3.5 w-3.5" />
          {t('subtitles.import')}
        </button>
        <p className="text-[11px] text-zinc-500">{t('subtitles.empty.formats')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-zinc-400">
          {t('subtitles.count', { count: cues.length })}
        </span>
        <Tooltip label={t('subtitles.import')}>
          <button
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={importSubtitles}
          >
            <FilePlus className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <ul className="space-y-1">
        {cues.map((clip) => (
          <CueRow key={clip.id} clip={clip} selected={clip.id === selectedClipId} />
        ))}
      </ul>
    </div>
  );
}

function CueRow({ clip, selected }: { clip: TextClip; selected: boolean }) {
  const { t } = useTranslation();
  const { updateClip, deleteClips, selectClip, seek, beginGesture, endGesture } =
    useStore.getState();

  /**
   * Selecting also parks the playhead on the cue: the point of clicking a row is
   * to look at that moment, and a selection with the preview still elsewhere
   * shows the wrong frame behind the text being edited.
   */
  const focusCue = () => {
    selectClip(clip.id);
    seek(clip.timelineStartMs);
  };

  return (
    <li
      className={`rounded-md border px-2 py-1.5 ${
        selected ? 'border-sky-500/70 bg-sky-500/10' : 'border-zinc-800 bg-zinc-900/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          className="font-mono text-[11px] tabular-nums text-zinc-400 hover:text-sky-400"
          title={t('subtitles.goto')}
          onClick={focusCue}
        >
          {/* Tenths, not whole seconds: cues are timed to fractions of one, and
              rounding would show a cue starting at 0.5 s as "0:00". */}
          {formatTime(clip.timelineStartMs)} · {formatTime(clipEndMs(clip))}
        </button>
        <span className="flex-1" />
        <Tooltip label={t('subtitles.delete')}>
          <button
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            onClick={() => deleteClips([clip.id], false)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      <textarea
        value={clip.text.content}
        rows={1}
        className="mt-1 w-full resize-y rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-zinc-100 outline-none hover:border-zinc-700 focus:border-sky-500 focus:bg-zinc-800"
        // The gesture snapshots the text as it was on entry, so a whole retype
        // undoes in one step instead of one entry per keystroke.
        onFocus={() => {
          focusCue();
          beginGesture();
        }}
        onChange={(e) => updateClip(clip.id, { text: { ...clip.text, content: e.target.value } })}
        onBlur={endGesture}
      />
    </li>
  );
}
