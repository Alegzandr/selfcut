import { openCubePicker } from './mediaPicker';
import { parseCube } from '../effects/lut';
import { useStore } from '../store/store';
import { t } from '../i18n';

/** Filename without its extension, for the LUT's display name. */
function baseName(file: File): string {
  return file.name.replace(/\.[^.]+$/, '') || file.name;
}

/**
 * Open the file dialog, parse the chosen `.cube`, import it into the project and
 * hand the caller its new id (or null if the user cancelled or the file was not
 * a usable LUT). A parse failure is reported as a notice, never thrown — a bad
 * file is a routine user mistake, not a crash.
 *
 * Shared by the inspector and the Effects pane so both import the same way.
 */
export function importLutFromDisk(onImported?: (id: string, name: string) => void): void {
  openCubePicker(async (file) => {
    const st = useStore.getState();
    let text: string;
    try {
      text = await file.text();
    } catch {
      st.setNotice(t('errors.lut.unreadable'));
      return;
    }
    try {
      const parsed = parseCube(text);
      const name = baseName(file);
      const id = st.importLut(name, parsed);
      st.setNotice(t('library.lut.imported', { name }));
      onImported?.(id, name);
    } catch {
      // Any parse failure (LutParseError or otherwise) is the same user-facing
      // outcome: the file was not a usable `.cube`.
      st.setNotice(t('errors.lut.invalid'));
    }
  });
}
