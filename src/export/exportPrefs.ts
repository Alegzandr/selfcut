/**
 * The export choices worth remembering between renders.
 *
 * Per machine rather than per project, and only the ones that describe a
 * habit rather than a render: whether the master is normalized is how this
 * person delivers, not a fact about one cut. (The frame-rate override is
 * deliberately NOT here - see `ExportSheet`.)
 */

const NORMALIZE_KEY = 'selfcut.export.normalize';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / no storage - the choice just will not persist */
  }
}

/**
 * Whether the export brings the master to the loudness target. On until
 * turned off: a file delivered at the platforms' level is what an export is
 * for, and the one case for leaving the level alone - a hand-off to someone
 * else's mix - is the one where the person knows to untick it.
 */
export function storedNormalize(): boolean {
  return read(NORMALIZE_KEY) !== 'off';
}

export function setStoredNormalize(on: boolean): void {
  write(NORMALIZE_KEY, on ? 'on' : 'off');
}
