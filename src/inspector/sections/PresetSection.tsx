import { useTranslation } from 'react-i18next';
import { Download, Upload } from 'lucide-react';
import { useStore } from '../../store/store';
import type { Clip } from '../../types';
import { applyPresetToClips, exportClipPreset, importPreset } from '../../ui/presetActions';

/**
 * Save this clip's look to a `.sfx` file, or drop one onto it.
 *
 * Export belongs here rather than in the library because it is inherently about
 * *this* clip, and the inspector is the per-clip surface. There is no naming
 * field: the OS save dialog is already one, and a second would be a form to fill
 * before a file dialog that asks the same question again.
 */
export function PresetSection({ clip, name }: { clip: Clip; name: string }) {
  const { t } = useTranslation();
  const selectedClipIds = useStore((s) => s.selectedClipIds);

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {t('inspector.preset')}
      </h3>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="touch-hit flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1.5 text-2xs font-medium text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700"
          // Called straight from the click: the save picker needs transient user
          // activation, which would be gone after an await.
          onClick={() => exportClipPreset(clip.id, name)}
        >
          <Download className="h-3.5 w-3.5" />
          {t('inspector.preset.export')}
        </button>
        <button
          type="button"
          className="touch-hit flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1.5 text-2xs font-medium text-zinc-300 hover:bg-zinc-700/60 active:bg-zinc-700"
          onClick={() =>
            importPreset((presetName, look) => {
              const s = useStore.getState();
              // Shelved as well as applied: the file dialog is the expensive part,
              // and the next clip that wants this look should not reopen it.
              s.addLoadedPreset(presetName, look);
              applyPresetToClips(look, selectedClipIds.length ? selectedClipIds : [clip.id]);
            })
          }
        >
          <Upload className="h-3.5 w-3.5" />
          {t('inspector.preset.import')}
        </button>
      </div>
    </div>
  );
}
