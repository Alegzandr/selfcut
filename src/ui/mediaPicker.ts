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
const ACCEPT = [
  'video/*,audio/*,image/*',
  // Video containers.
  '.mp4,.m4v,.mov,.webm,.mkv,.ts,.mts,.m2ts,.3gp,.3g2',
  // Audio containers.
  '.mp3,.wav,.m4a,.aac,.adts,.ogg,.oga,.opus,.flac,.mka,.weba',
  // Still images.
  '.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.svg',
  // Subtitles.
  '.srt,.vtt,.ass,.ssa',
].join(',');

export function openMediaPicker(onFiles: (files: FileList) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles(input.files);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
