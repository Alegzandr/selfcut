/**
 * Programmatic media picker: builds a hidden <input type="file">, clicks it and
 * forwards the chosen files. Lets any command (menu bar, mobile tool rail) open
 * the OS file dialog without owning a React ref to an <input> in the DOM.
 */
/**
 * Everything the import pipeline can handle. Containers follow what mediabunny
 * reads (ISOBMFF, QuickTime, Matroska/WebM, MPEG-TS, MP3, WAVE, Ogg, ADTS,
 * FLAC); stills and subtitles have their own paths. The wildcards keep files
 * with a correct MIME type but an unlisted extension selectable - the probe
 * validates for real, this list only drives the OS dialog filter.
 */
import { PROJECT_FILE_EXT } from '../lib/projectFile';
import { PRESET_FILE_EXT } from '../effects/presetFile';

/** Subtitle containers the parser reads. */
export const SUBTITLE_ACCEPT = '.srt,.vtt,.ass,.ssa';

const ACCEPT = [
  'video/*,audio/*,image/*',
  // Video containers.
  '.mp4,.m4v,.mov,.webm,.mkv,.ts,.mts,.m2ts,.3gp,.3g2',
  // Audio containers.
  '.mp3,.wav,.m4a,.aac,.adts,.ogg,.oga,.opus,.flac,.mka,.weba',
  // Still images.
  '.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.svg',
  // Subtitles.
  SUBTITLE_ACCEPT,
].join(',');

export function openMediaPicker(onFiles: (files: FileList) => void): void {
  pick(onFiles, false);
}

/**
 * Subtitles-only variant. The generic media picker already accepts them, but
 * "Import subtitles" has to be findable as its own action - a caption file is
 * not something users think to look for behind "Import media".
 */
export function openSubtitlePicker(onFiles: (files: FileList) => void): void {
  pick(onFiles, false, { accept: SUBTITLE_ACCEPT });
}

/** Project-file variant: a single `.selfcut` document, not media. */
export function openProjectPicker(onFile: (file: File) => void): void {
  pick(
    (files) => {
      const file = files[0];
      if (file) onFile(file);
    },
    false,
    { accept: PROJECT_FILE_EXT, multiple: false },
  );
}

/**
 * Effects-preset variant: a single `.sfx` document. Some OS dialogs will not
 * filter on an extension they do not know, which is harmless - the parser
 * rejects anything that is not a preset.
 */
export function openPresetPicker(onFile: (file: File) => void): void {
  pick(
    (files) => {
      const file = files[0];
      if (file) onFile(file);
    },
    false,
    { accept: PRESET_FILE_EXT, multiple: false },
  );
}

/**
 * LUT variant: a single `.cube` colour table. Some OS dialogs won't filter on an
 * extension they don't know, which is harmless - the parser rejects anything
 * that is not a valid cube file.
 */
export function openCubePicker(onFile: (file: File) => void): void {
  pick(
    (files) => {
      const file = files[0];
      if (file) onFile(file);
    },
    false,
    { accept: '.cube', multiple: false },
  );
}

/**
 * Folder variant: the OS dialog selects a directory and hands back every file
 * inside it. Used to relink sources in bulk after a folder was renamed or moved
 * - the browser never exposes a path, so the caller matches on `file.name`.
 * No `accept` filter here: it is ignored in directory mode, and the probe
 * rejects anything unreadable anyway.
 */
export function openFolderPicker(onFiles: (files: FileList) => void): void {
  pick(onFiles, true);
}

function pick(
  onFiles: (files: FileList) => void,
  directory: boolean,
  opts: { accept?: string; multiple?: boolean } = {},
): void {
  const input = document.createElement('input');
  input.type = 'file';
  if (directory) {
    // Not in the HTMLInputElement typings, but supported by every target browser.
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  } else {
    input.accept = opts.accept ?? ACCEPT;
  }
  input.multiple = opts.multiple ?? true;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles(input.files);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
