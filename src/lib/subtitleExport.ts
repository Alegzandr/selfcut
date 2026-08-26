import { clipEndMs, isTextClip } from '../model';
import type { Project, TextClip } from '../types';
import { downloadBlob } from './download';
import { PROJECT_FILE_EXT, SaveCanceledError } from './projectFile';
import {
  formatSubtitles,
  type SubtitleCue,
  type SubtitleFormat,
  type SubtitleVAlign,
} from './subtitles';
import { t } from '../i18n';

/**
 * Writing the project's caption track back out as a subtitle file.
 *
 * The timeline is the working copy: cues land on it as text clips, get retimed,
 * split and rewritten there, and everything an editor does to them lives in the
 * clips rather than in the file they came from. Export is the way back out -
 * for a player, a platform's caption upload, or another editor - so a track
 * imported, fixed and re-exported survives the round trip.
 *
 * Every text clip counts as a cue, exactly as the subtitles pane lists them: a
 * title card IS a cue as far as a caption file is concerned, and silently
 * dropping it would make the export disagree with what the panel shows.
 */

const MIME: Record<SubtitleFormat, string> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
};

/**
 * The band a clip's vertical position reads as. Mirrors the placement the
 * importer applies (see CAPTION_Y in the clips slice): thirds of the frame,
 * which is all a subtitle format can express anyway. The importer's exact
 * fractions vary with the project's aspect ratio, but every one of them lands
 * well inside its third, so the round trip holds whatever the frame.
 */
function vAlignOf(clip: TextClip): SubtitleVAlign {
  const y = clip.transform?.y ?? 0.82;
  return y < 0.34 ? 'top' : y < 0.67 ? 'middle' : 'bottom';
}

/** Every text clip in the project as a cue, in timeline order. */
export function cuesFromProject(project: Project): SubtitleCue[] {
  return project.tracks
    .flatMap((track) => track.clips)
    .filter(isTextClip)
    .filter((clip) => clip.text.content.trim() !== '')
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs)
    .map((clip) => {
      const vAlign = vAlignOf(clip);
      return {
        startMs: clip.timelineStartMs,
        endMs: clipEndMs(clip),
        text: clip.text.content.trim(),
        // Only state a placement that differs from the caption default, so an
        // untouched track exports without positioning noise.
        ...(clip.text.align && clip.text.align !== 'center' ? { align: clip.text.align } : {}),
        ...(vAlign === 'bottom' ? {} : { vAlign }),
      };
    });
}

/** Filename for an exported track: the project's name, or a generic fallback. */
export function subtitleFileName(projectName: string | undefined, format: SubtitleFormat): string {
  const base = (projectName ?? '').trim() || t('subtitles.export.untitled');
  // Drop the project extension the name may still carry, so a project opened
  // from a file does not export as "my film.selfcut.srt". Only that exact
  // suffix: an episode called "Ep. 2" must keep its number.
  const stem = base.toLowerCase().endsWith(PROJECT_FILE_EXT)
    ? base.slice(0, -PROJECT_FILE_EXT.length)
    : base;
  return `${stem}.${format}`;
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/**
 * Write cues to disk, letting the save dialog decide the format: both types are
 * offered, and the extension that comes back picks the serializer. Browsers
 * without the File System Access API get an SRT download - the format every
 * player and platform reads.
 *
 * The picker is called before anything is serialized because it needs transient
 * user activation, which does not survive an await. Callers must reach this
 * straight from the click handler.
 */
export async function saveSubtitleFile(
  cues: SubtitleCue[],
  suggestedName: string,
): Promise<SubtitleFormat> {
  const show = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;

  let handle: FileSystemFileHandle | null = null;
  if (show) {
    try {
      handle = await show({
        suggestedName,
        types: [
          { description: t('subtitles.fileType.srt'), accept: { [MIME.srt]: ['.srt'] } },
          { description: t('subtitles.fileType.vtt'), accept: { [MIME.vtt]: ['.vtt'] } },
        ],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw new SaveCanceledError();
      throw err;
    }
  }

  const format: SubtitleFormat = /\.vtt$/i.test(handle?.name ?? suggestedName) ? 'vtt' : 'srt';
  const blob = new Blob([formatSubtitles(cues, format)], { type: `${MIME[format]};charset=utf-8` });
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return format;
  }
  downloadBlob(blob, suggestedName.replace(/\.[^.]+$/, `.${format}`));
  return format;
}
