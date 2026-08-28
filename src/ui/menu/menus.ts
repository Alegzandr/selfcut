import {
  BookmarkIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeOpenIcon,
  LinkBreak1Icon,
  LockOpen1Icon,
  Pencil2Icon,
  PlusIcon,
  SliderIcon,
  SpeakerLoudIcon,
  SpeakerModerateIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { useTranslation } from 'react-i18next';
import { useStore, getLinkTargets } from '../../store/store';
import { EASE_IDS } from '../../model';
import { selectionEase } from '../../timeline/keyframeSelection';
import { CurveIcon } from '../../timeline/KeyframeIcon';
import { audioKey } from '../../media/mediaCache';
import type { ContextTarget } from '../../store/editorState';
import { reconnectAssetViaPicker } from '../MediaLibrary';
import { useEditorCommands, type Command } from '../commands';
import { useIsCoarsePointer } from '../../lib/device';
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
  const expandedTrackIds = useStore((s) => s.expandedTrackIds);
  const coarse = useIsCoarsePointer();
  const st = useStore.getState;

  /** Map global command ids (and separators) to rows, dropping unknown ids. */
  const resolve = (ids: string[]): MenuEntry[] =>
    ids
      .map((id): MenuEntry | null =>
        id === '---' ? '---' : (commands[id] ?? null),
      )
      .filter((e): e is MenuEntry => e !== null);

  switch (target.kind) {
    case 'clip': {
      const track = tracks.find((tr) => tr.clips.some((c) => c.id === target.clipId));
      const clip = track?.clips.find((c) => c.id === target.clipId);
      const linked = clip?.linkId != null;
      // Picture-only rows are dropped, not greyed out, on an audio lane: the
      // audio half of a linked pair still points at a video asset, and offering
      // to blur or reframe a waveform reads as a bug.
      const picture = track?.kind !== 'audio';
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
        icon: SpeakerModerateIcon,
        disabled: audioKey(asset!.id, tr.index) in transcodes,
        onClick: () => void st().transcodeAudioTrack(asset!.id, tr.index),
      }));
      return resolve([
        'edit.cut',
        'edit.copy',
        'clip.duplicate',
        '---',
        'clip.split',
        ...(picture ? ['clip.punchIn', 'clip.stream', 'clip.blurRegion'] : []),
        'clip.captions',
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
          icon: BookmarkIcon,
          onClick: () => {
            const marker = st().project.markers.find((m) => m.id === id);
            if (marker) st().seek(marker.timeMs);
          },
        },
        {
          id: 'ctx.marker.rename',
          labelKey: 'ctx.marker.rename',
          icon: Pencil2Icon,
          onClick: () => st().setRenamingMarker(id),
        },
        '---',
        {
          id: 'ctx.marker.delete',
          labelKey: 'ctx.marker.delete',
          icon: TrashIcon,
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
          icon: SpeakerLoudIcon,
          checked: track?.muted,
          onClick: () => st().toggleTrackMuted(id),
        },
      ];
      if (track?.kind === 'video') {
        items.push({
          id: 'ctx.track.hide',
          labelKey: track.hidden ? 'track.show' : 'track.hide',
          icon: EyeOpenIcon,
          checked: track.hidden,
          onClick: () => st().toggleTrackHidden(id),
        });
      }
      // Volume and opacity: faders on the desktop header, and nothing at all on
      // the 44px touch one, so on touch the menu is where they live.
      if (coarse) {
        items.push({
          id: 'ctx.track.settings',
          labelKey: 'track.settings',
          icon: SliderIcon,
          onClick: () => st().setTrackSettingsTrack(id),
        });
      }
      // Reachable nowhere else on a coarse pointer: the touch header is two
      // buttons wide and cannot carry the chevron the desktop one does.
      items.push({
        id: 'ctx.track.expand',
        labelKey: expandedTrackIds.includes(id) ? 'track.collapse' : 'track.expand',
        icon: ChevronDownIcon,
        checked: expandedTrackIds.includes(id),
        onClick: () => st().toggleTrackExpanded(id),
      });
      items.push({
        id: 'ctx.track.lock',
        labelKey: track?.locked ? 'track.unlock' : 'track.lock',
        icon: LockOpen1Icon,
        checked: track?.locked,
        onClick: () => st().toggleTrackLocked(id),
      });
      // Auto-captions, offered where a whole lane of talking heads is the thing
      // being pointed at. It selects the lane's clips and opens the subtitles
      // pane rather than transcribing on the spot: the model, the language and
      // the voice focus are choices, and a right-click is not the place to
      // commit to them silently.
      const audible = (track?.clips ?? []).filter(
        (clip) => clip.kind === 'media' && assets[clip.assetId]?.hasAudio,
      );
      if (audible.length > 0) {
        items.push('---', {
          id: 'ctx.track.captions',
          labelKey: 'ctx.track.captions',
          icon: ChatBubbleIcon,
          onClick: () => {
            st().setSelectedClips(audible.map((clip) => clip.id));
            st().setInspectorTab('subtitles');
            st().setInspectorOpen(true);
          },
        });
      }
      items.push(
        '---',
        {
          id: 'ctx.track.moveUp',
          labelKey: 'track.moveUp',
          icon: ChevronUpIcon,
          onClick: () => st().moveTrack(id, -1),
        },
        {
          id: 'ctx.track.moveDown',
          labelKey: 'track.moveDown',
          icon: ChevronDownIcon,
          onClick: () => st().moveTrack(id, 1),
        },
        '---',
        ...resolve(['insert.videoTrack', 'insert.audioTrack']),
        '---',
        {
          id: 'ctx.track.delete',
          labelKey: 'track.delete',
          icon: TrashIcon,
          danger: true,
          onClick: () => st().removeTrack(id),
        },
      );
      return items;
    }

    // A right-click on a diamond. The rows act on the whole keyframe selection
    // (the handler put the pressed key in it), which is what makes re-easing a
    // boxed run a single gesture rather than one menu per key.
    case 'keyframe': {
      const refs = st().selectedKeyframes;
      const current = selectionEase(st().project, refs);
      const items: MenuEntry[] = EASE_IDS.map((ease) => ({
        id: `ctx.keyframe.ease.${ease}`,
        labelKey: `inspector.easing.${ease}` as const,
        checked: current === ease,
        onClick: () => st().setSelectedKeyframesEase(ease),
      }));
      items.push('---', {
        id: 'ctx.keyframe.curve',
        labelKey: 'timeline.curveEditor',
        icon: CurveIcon,
        checked: current === 'custom',
        shortcut: 'G',
        onClick: () => st().setCurveEditorOpen(true),
      });
      items.push('---', {
        id: 'ctx.keyframe.delete',
        labelKey: refs.length > 1 ? 'ctx.keyframe.deleteMany' : 'ctx.keyframe.delete',
        icon: TrashIcon,
        danger: true,
        onClick: () => st().deleteSelectedKeyframes(),
      });
      return items;
    }

    case 'asset': {
      const id = target.assetId;
      const asset = assets[id];
      const items: MenuEntry[] = [
        {
          id: 'ctx.asset.add',
          labelKey: 'library.add',
          icon: PlusIcon,
          disabled: asset?.disconnected,
          onClick: () => st().addClipFromAsset(id),
        },
      ];
      // Same action either way: reconnecting a lost file and pointing a healthy
      // asset at another take are the same operation, only the intent differs.
      items.push({
        id: asset?.disconnected ? 'ctx.asset.reconnect' : 'ctx.asset.replace',
        labelKey: asset?.disconnected
          ? 'library.reconnect'
          : 'library.replaceSource',
        icon: LinkBreak1Icon,
        onClick: () => reconnectAssetViaPicker(id),
      });
      items.push('---', {
        id: 'ctx.asset.remove',
        labelKey: 'library.remove',
        icon: TrashIcon,
        danger: true,
        onClick: () => st().removeAsset(id),
      });
      return items;
    }
  }
}

/** The `Command` type re-exported for handlers that build inline menu entries. */
export type { Command };
