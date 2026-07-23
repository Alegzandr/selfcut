import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/store';
import type { TransitionType } from '../types';
import { EFFECTS, TRANSITIONS, type EffectGroup } from '../effects/catalog';
import { resolveEffectTargets } from '../effects/apply';
import { EFFECT_DRAG_MIME, PRESET_DRAG_MIME, TRANSITION_DRAG_MIME } from '../app/config';
import { useIsCoarsePointer } from '../lib/device';
import { applyPresetToClips } from './presetActions';
import { importLutFromDisk } from './lutActions';
import { Plus, X } from 'lucide-react';

/**
 * The Effects and Transitions panes of the media library. Both are catalogues
 * applied the way a desktop NLE applies them: double-click puts the entry on
 * the current selection, dragging puts it on the clip it lands on. The tiles
 * dim when the selection cannot take them, so a dead double-click is visible
 * before it is attempted rather than after.
 */

/**
 * Shared catalogue tile. Two input stories, because HTML5 drag does not exist
 * under a finger: with a mouse the tile is draggable and applies on
 * double-click (a single click must not fire an effect on the way into a drag);
 * on touch it is a plain button that applies on tap, since tapping is the only
 * gesture left. A dimmed tile stays draggable on desktop - the selection is not
 * the only possible target, the clip under the pointer is one too - but on
 * touch it is genuinely inert, so it is disabled rather than merely faint.
 */
function CatalogTile({
  label,
  enabled,
  coarse,
  onDragStart,
  onApply,
}: {
  label: string;
  enabled: boolean;
  coarse: boolean;
  onDragStart: (e: DragEvent) => void;
  onApply: () => void;
}) {
  return (
    <button
      type="button"
      draggable={!coarse}
      onDragStart={coarse ? undefined : onDragStart}
      onClick={coarse ? onApply : undefined}
      onDoubleClick={coarse ? undefined : onApply}
      disabled={coarse && !enabled}
      className={`touch-hit select-none rounded border border-zinc-800 bg-zinc-800/60 px-2 py-1.5 text-left text-2xs font-medium pointer-coarse:py-2.5 ${
        coarse ? '' : 'cursor-grab active:cursor-grabbing'
      } ${
        enabled
          ? 'text-zinc-200 hover:border-zinc-700 hover:bg-zinc-700/60 active:bg-zinc-700'
          : 'text-zinc-500 hover:bg-zinc-800'
      }`}
      title={label}
    >
      <span className="block truncate">{label}</span>
    </button>
  );
}

/** Section heading inside a catalogue pane. */
function GroupHeading({ children }: { children: string }) {
  return (
    <h3 className="px-0.5 pt-1 text-2xs font-semibold uppercase tracking-wide text-zinc-500">
      {children}
    </h3>
  );
}

function CatalogGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1">{children}</div>
  );
}

/**
 * The line above a catalogue: it has to name the gesture that actually exists
 * on this device, since they do not overlap between mouse and touch.
 */
function CatalogHint() {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  return (
    <p className="px-0.5 pb-1 text-2xs leading-snug text-zinc-500">
      {t(coarse ? 'library.catalog.hintTouch' : 'library.catalog.hint')}
    </p>
  );
}

/**
 * On touch the catalogue lives in a drawer covering the editor: leaving it open
 * after a tap would hide the very change the tap just made.
 */
function dismissOnTouch(coarse: boolean) {
  if (coarse) useStore.getState().setLibraryOpen(false);
}

/**
 * The presets imported this session, above the built-in catalogue.
 *
 * They sit in the Effects pane rather than behind a tab of their own: a preset
 * is an effect, and a fourth tab in a strip that already truncates would cost
 * more than it buys. The shelf is session state - the `.sfx` files on disk are
 * what actually persists - which the empty line says out loud so nobody expects
 * to find their presets here tomorrow.
 *
 * Read-only: importing a preset is a file action and lives with the other ones
 * (File ▸ Import preset, and the mobile tool rail), not on the shelf it fills.
 */
function PresetsGroup({ coarse }: { coarse: boolean }) {
  const { t } = useTranslation();
  const presets = useStore((s) => s.loadedPresets);
  const selectedClipIds = useStore((s) => s.selectedClipIds);

  const apply = (id: string) => {
    const st = useStore.getState();
    if (selectedClipIds.length === 0) {
      st.setNotice(t('library.effects.noSelection'));
      return;
    }
    const preset = st.loadedPresets.find((p) => p.id === id);
    if (!preset) return;
    applyPresetToClips(preset.look, selectedClipIds);
    dismissOnTouch(coarse);
  };

  return (
    <div className="space-y-1">
      <GroupHeading>{t('library.effects.presets')}</GroupHeading>
      {presets.length === 0 ? (
        <p className="px-0.5 text-2xs leading-snug text-zinc-600">{t('library.presets.empty')}</p>
      ) : (
        <CatalogGrid>
          {presets.map((preset) => (
            <div key={preset.id} className="relative">
              <CatalogTile
                label={preset.name}
                coarse={coarse}
                enabled={selectedClipIds.length > 0}
                onDragStart={(e) => {
                  e.dataTransfer.setData(PRESET_DRAG_MIME, preset.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onApply={() => apply(preset.id)}
              />
              <button
                type="button"
                title={t('library.presets.remove')}
                aria-label={t('library.presets.remove')}
                className="absolute right-0.5 top-0.5 rounded p-0.5 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
                onClick={() => useStore.getState().removeLoadedPreset(preset.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </CatalogGrid>
      )}
    </div>
  );
}

/**
 * The project's imported LUTs, with an Import button. A LUT tile applies to the
 * selection like an effect does; the inspector is where its strength is tuned.
 * The list lives on the project (it persists and exports), unlike the session
 * preset shelf above it — so it says "no LUT imported", not "gone tomorrow".
 *
 * LUTs only mean something on a picture clip, so the tiles dim when the
 * selection has none, matching the built-in effect tiles.
 */
function LutsGroup({ coarse }: { coarse: boolean }) {
  const { t } = useTranslation();
  const luts = useStore((s) => s.project.luts) ?? [];
  const assets = useStore((s) => s.assets);
  const project = useStore((s) => s.project);
  const selectedClipIds = useStore((s) => s.selectedClipIds);

  // Selected clips that actually paint: generated clips always do, a media clip
  // does when its asset is not pure audio. The same gate the effect catalogue uses.
  const pictureIds = selectedClipIds.filter((id) => {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (!clip) continue;
      return clip.kind !== 'media' || (!!assets[clip.assetId] && assets[clip.assetId]!.kind !== 'audio');
    }
    return false;
  });
  const enabled = pictureIds.length > 0;

  const apply = (lutId: string) => {
    const st = useStore.getState();
    if (selectedClipIds.length === 0) {
      st.setNotice(t('library.effects.noSelection'));
      return;
    }
    if (pictureIds.length === 0) {
      st.setNotice(t('library.effects.rejected'));
      return;
    }
    st.setClipsLut(pictureIds, lutId);
    dismissOnTouch(coarse);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-0.5 pt-1">
        <GroupHeading>{t('library.effects.lut')}</GroupHeading>
        <button
          type="button"
          className="touch-hit flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800/70 active:bg-zinc-800"
          onClick={() => importLutFromDisk()}
          title={t('library.lut.import')}
        >
          <Plus className="h-3 w-3" />
          {t('library.lut.import')}
        </button>
      </div>
      {luts.length === 0 ? (
        <p className="px-0.5 text-2xs leading-snug text-zinc-600">{t('library.lut.empty')}</p>
      ) : (
        <CatalogGrid>
          {luts.map((lut) => (
            <div key={lut.id} className="relative">
              <CatalogTile
                label={lut.name}
                coarse={coarse}
                enabled={enabled}
                onDragStart={(e) => e.preventDefault()}
                onApply={() => apply(lut.id)}
              />
              <button
                type="button"
                title={t('library.lut.remove')}
                aria-label={t('library.lut.remove')}
                className="absolute right-0.5 top-0.5 rounded p-0.5 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
                onClick={() => useStore.getState().removeLut(lut.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </CatalogGrid>
      )}
    </div>
  );
}

export function EffectsPane() {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const project = useStore((s) => s.project);
  const assets = useStore((s) => s.assets);
  const selectedClipIds = useStore((s) => s.selectedClipIds);

  const apply = (effectId: string) => {
    const st = useStore.getState();
    if (selectedClipIds.length === 0) {
      st.setNotice(t('library.effects.noSelection'));
      return;
    }
    if (resolveEffectTargets(project, assets, effectId, selectedClipIds).length === 0) {
      st.setNotice(t('library.effects.rejected'));
      return;
    }
    st.applyEffectPreset(effectId, selectedClipIds);
    dismissOnTouch(coarse);
  };

  const groups: EffectGroup[] = ['video', 'audio'];
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
      <CatalogHint />
      <PresetsGroup coarse={coarse} />
      <LutsGroup coarse={coarse} />
      {groups.map((group) => (
        <div key={group} className="space-y-1">
          <GroupHeading>{t(`library.effects.${group}`)}</GroupHeading>
          <CatalogGrid>
            {EFFECTS.filter((fx) => fx.group === group).map((fx) => (
              <CatalogTile
                key={fx.id}
                label={t(fx.labelKey)}
                coarse={coarse}
                enabled={
                  selectedClipIds.length > 0 &&
                  resolveEffectTargets(project, assets, fx.id, selectedClipIds).length > 0
                }
                onDragStart={(e) => {
                  e.dataTransfer.setData(EFFECT_DRAG_MIME, fx.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onApply={() => apply(fx.id)}
              />
            ))}
          </CatalogGrid>
        </div>
      ))}
    </div>
  );
}

export function TransitionsPane() {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const selectedClipIds = useStore((s) => s.selectedClipIds);

  const apply = (type: TransitionType) => {
    const st = useStore.getState();
    if (selectedClipIds.length === 0) {
      st.setNotice(t('library.effects.noSelection'));
      return;
    }
    // A transition needs something to come out of. When no selected clip has a
    // usable predecessor, say so - the drop is otherwise a silent no-op.
    const applied = selectedClipIds.filter((id) => st.applyTransition(id, type));
    if (applied.length === 0) {
      st.setNotice(t('library.transitions.rejected'));
      return;
    }
    dismissOnTouch(coarse);
  };

  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
      <CatalogHint />
      <CatalogGrid>
        {TRANSITIONS.map((type) => (
          <CatalogTile
            key={type}
            label={t(`inspector.transition.${type}`)}
            coarse={coarse}
            enabled={selectedClipIds.length > 0}
            onDragStart={(e) => {
              e.dataTransfer.setData(TRANSITION_DRAG_MIME, type);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onApply={() => apply(type)}
          />
        ))}
      </CatalogGrid>
    </div>
  );
}
