import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Eye,
  Flag,
  LockOpen,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
  Volume2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore, getLinkTargets } from '../../store/store';
import { audioKey } from '../../media/mediaCache';
import type { ContextTarget } from '../../store/editorState';
import { reconnectAssetViaPicker } from '../MediaLibrary';
import { useEditorCommands, type Command } from '../commands';
import type { MenuEntry } from './MenuList';

/**
 * Resolve a right-click target into the rows the context menu shows. Two kinds
 * of rows are mixed:
 *  - clip / timeline surfaces reuse the shared selection-based `Command`s (the
 *    right-click has already selected the target), keeping enabled/checked flags
 *    identical to the menu bar;
 *  - marker / track / asset surfaces build small target-parameterised commands
 *    over the same `Command` shape, since those actions need a specific id.
 *
 * A hook (not a plain function) so it re-runs on store changes while the menu is
 * open - a toggled mute or a deleted clip stays reflected live.
 */
export function useContextMenuItems(target: ContextTarget): MenuEntry[] {
  const { t } = useTranslation();
  const commands = useEditorCommands();
  const tracks = useStore((s) => s.project.tracks);
  const transcodes = useStore((s) => s.transcodes);
  const assets = useStore((s) => s.assets);
  const canLink = useStore((s) => getLinkTargets(s) !== null);
  const st = useStore.getState;

  /** Map global command ids (and separators) to rows, dropping unknown ids. */
  const resolve = (ids: string[]): MenuEntry[] =>
    ids
      .map((id): MenuEntry | null => (id === '---' ? '---' : commands[id] ?? null))
      .filter((e): e is MenuEntry => e !== null);

  switch (target.kind) {
    case 'clip': {
      const clip = tracks.flatMap((tr) => tr.clips).find((c) => c.id === target.clipId);
      const linked = clip?.linkId != null;
      // A clip whose source carries sound the browser cannot decode: offer to
      // convert it right here, so a muted clip is fixable without a detour
      // through the media library.
      const asset = clip?.kind === 'media' ? assets[clip.assetId] : undefined;
      const convertible = (asset?.audioTracks ?? []).filter(
        (tr) => tr.undecodable && !tr.transcoded,
      );
      const transcodeRows: MenuEntry[] = convertible.map((tr) => ({
        id: `clip.activateAudio.${tr.index}`,
        labelKey: 'clip.activateAudio',
        label: `${t('clip.activateAudio')} · ${tr.label ?? tr.language ?? tr.codec ?? '?'}`,
        icon: AudioLines,
        disabled: audioKey(asset!.id, tr.index) in transcodes,
        onClick: () => void st().transcodeAudioTrack(asset!.id, tr.index),
      }));
      return resolve([
        'edit.cut',
        'edit.copy',
        'clip.duplicate',
        '---',
        'clip.split',
        'clip.punchIn',
        'clip.stream',
        'clip.adjust',
        // Link when the selection joins into a pair; unlink on an already-linked clip.
        ...(canLink ? ['clip.link'] : []),
        ...(linked ? ['clip.unlink'] : []),
        // The one preset row that is about *this* clip. Touch has no menu bar,
        // so without it saving a look would be desktop-only.
        '---',
        'file.savePreset',
        '---',
        'clip.delete',
        'clip.rippleDelete',
      ]).concat(transcodeRows.length > 0 ? ['---', ...transcodeRows] : []);
    }

    case 'timeline':
      return resolve([
        'edit.paste',
        '---',
        'insert.text',
        'insert.color',
        'insert.gradient',
        '---',
        'insert.marker',
        '---',
        'edit.selectAll',
      ]);

    case 'marker': {
      const id = target.markerId;
      return [
        {
          id: 'ctx.marker.goto',
          labelKey: 'ctx.marker.goto',
          icon: Flag,
          onClick: () => {
            const marker = st().project.markers.find((m) => m.id === id);
            if (marker) st().seek(marker.timeMs);
          },
        },
        {
          id: 'ctx.marker.rename',
          labelKey: 'ctx.marker.rename',
          icon: Pencil,
          onClick: () => st().setRenamingMarker(id),
        },
        '---',
        {
          id: 'ctx.marker.delete',
          labelKey: 'ctx.marker.delete',
          icon: Trash2,
          danger: true,
          onClick: () => st().removeMarker(id),
        },
      ];
    }

    case 'track': {
      const id = target.trackId;
      const track = tracks.find((tr) => tr.id === id);
      const items: MenuEntry[] = [
        {
          id: 'ctx.track.mute',
          // The label states what a click will do, like play/pause does. The
          // icon is unconditional: `checked` swaps it for a checkmark, so a
          // state-dependent icon here could never render in the state it means.
          labelKey: track?.muted ? 'track.unmute' : 'track.mute',
          icon: Volume2,
          checked: track?.muted,
          onClick: () => st().toggleTrackMuted(id),
        },
      ];
      if (track?.kind === 'video') {
        items.push({
          id: 'ctx.track.hide',
          labelKey: track.hidden ? 'track.show' : 'track.hide',
          icon: Eye,
          checked: track.hidden,
          onClick: () => st().toggleTrackHidden(id),
        });
      }
      items.push(
        {
          id: 'ctx.track.lock',
          labelKey: track?.locked ? 'track.unlock' : 'track.lock',
          icon: LockOpen,
          checked: track?.locked,
          onClick: () => st().toggleTrackLocked(id),
        },
        '---',
        {
          id: 'ctx.track.moveUp',
          labelKey: 'track.moveUp',
          icon: ChevronUp,
          onClick: () => st().moveTrack(id, -1),
        },
        {
          id: 'ctx.track.moveDown',
          labelKey: 'track.moveDown',
          icon: ChevronDown,
          onClick: () => st().moveTrack(id, 1),
        },
        '---',
        ...resolve(['insert.videoTrack', 'insert.audioTrack']),
        '---',
        {
          id: 'ctx.track.delete',
          labelKey: 'track.delete',
          icon: Trash2,
          danger: true,
          onClick: () => st().removeTrack(id),
        },
      );
      return items;
    }

    case 'asset': {
      const id = target.assetId;
      const asset = assets[id];
      const items: MenuEntry[] = [
        {
          id: 'ctx.asset.add',
          labelKey: 'library.add',
          icon: Plus,
          disabled: asset?.disconnected,
          onClick: () => st().addClipFromAsset(id),
        },
      ];
      // Same action either way: reconnecting a lost file and pointing a healthy
      // asset at another take are the same operation, only the intent differs.
      items.push({
        id: asset?.disconnected ? 'ctx.asset.reconnect' : 'ctx.asset.replace',
        labelKey: asset?.disconnected ? 'library.reconnect' : 'library.replaceSource',
        icon: PlugZap,
        onClick: () => reconnectAssetViaPicker(id),
      });
      items.push('---', {
        id: 'ctx.asset.remove',
        labelKey: 'library.remove',
        icon: Trash2,
        danger: true,
        onClick: () => st().removeAsset(id),
      });
      return items;
    }
  }
}

/** The `Command` type re-exported for handlers that build inline menu entries. */
export type { Command };
