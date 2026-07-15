import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Flag,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useStore, getLinkTargets } from '../../store/store';
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
  const commands = useEditorCommands();
  const tracks = useStore((s) => s.project.tracks);
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
        '---',
        'clip.delete',
        'clip.rippleDelete',
      ]);
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
          labelKey: 'track.mute',
          icon: track?.muted ? VolumeX : Volume2,
          checked: track?.muted,
          onClick: () => st().toggleTrackMuted(id),
        },
      ];
      if (track?.kind === 'video') {
        items.push({
          id: 'ctx.track.hide',
          labelKey: 'track.hide',
          icon: track.hidden ? EyeOff : Eye,
          checked: track.hidden,
          onClick: () => st().toggleTrackHidden(id),
        });
      }
      items.push(
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
      if (asset?.disconnected) {
        items.push({
          id: 'ctx.asset.reconnect',
          labelKey: 'library.reconnect',
          icon: PlugZap,
          onClick: () => reconnectAssetViaPicker(id),
        });
      }
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
