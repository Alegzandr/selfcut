import { downloadBlob } from '../lib/download';
import { SaveCanceledError } from '../lib/projectFile';
import {
  PRESET_FILE_EXT,
  PRESET_FILE_MIME,
  parsePresetFile,
  presetFileName,
  serializePreset,
  type PresetFile,
} from './presetFile';
import { t } from '../i18n';

/**
 * Reading and writing `.sfx` files, mirroring the project file's picker dance
 * without its handle binding: every preset export is a fresh Save As, so there
 * is no file to overwrite in place and no permission to re-authorize.
 */

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/**
 * Write a preset to disk.
 *
 * Serialized synchronously above the picker call for the same reason the project
 * save is: `showSaveFilePicker` needs transient user activation, which does not
 * survive the first await. Callers must reach this straight from the click
 * handler. Browsers without the File System Access API get a download instead.
 */
export async function savePresetFile(doc: PresetFile): Promise<void> {
  const json = serializePreset(doc);
  const suggested = presetFileName(doc.name);
  const show = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;

  let handle: FileSystemFileHandle | null = null;
  if (show) {
    try {
      handle = await show({
        suggestedName: suggested,
        types: [{ description: t('preset.fileType'), accept: { [PRESET_FILE_MIME]: [PRESET_FILE_EXT] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw new SaveCanceledError();
      throw err;
    }
  }

  const blob = new Blob([json], { type: PRESET_FILE_MIME });
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  downloadBlob(blob, suggested);
}

export async function readPresetFile(file: File): Promise<PresetFile> {
  return parsePresetFile(await file.text());
}
