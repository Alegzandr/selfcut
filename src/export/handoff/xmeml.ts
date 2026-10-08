import type { AspectRatio, Clip, MediaAsset, Project, Track } from '../../types';
import {
  clipEndMs,
  delegatedLinkIds,
  findComp,
  hasVelocity,
  isCompClip,
  isGeneratedClip,
  isTrackAudible,
  isTrackVisible,
} from '../../model';

/**
 * The cut as a Final Cut Pro 7 XML (xmeml v5) sequence.
 *
 * The one interchange format both Premiere Pro ("Import" an .xml) and DaVinci
 * Resolve ("Import Timeline") open: an EDL is one video track and cuts only,
 * and FCPXML is not read by Premiere. What travels is the edit itself - which
 * piece of which rush sits where, on which track, at which speed and level -
 * so the editor receiving it re-links to the original rushes and keeps every
 * frame of handle, rather than starting from a flattened render.
 *
 * What does not travel is said, not dropped silently: generated clips (titles,
 * solids, shapes) and velocity ramps have no faithful xmeml form, and are
 * counted in `omitted` for the folder's read-me.
 */

export interface XmemlInput {
  project: Project;
  assets: Record<string, MediaAsset>;
  /** Sequence timebase, an integer rate (24, 25, 30, 50, 60). */
  fps: number;
  /** The exported span, in root timeline ms. */
  startMs: number;
  durationMs: number;
  sequenceName: string;
  /** The file name the rush of `asset` carries in the folder. */
  mediaName: (asset: MediaAsset) => string;
}

export interface XmemlResult {
  xml: string;
  /** Assets the sequence references, in first-use order. */
  usedAssetIds: string[];
  omitted: { generated: number; ramped: number };
}

const SEQUENCE_SIZE: Record<AspectRatio, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

/** Below this a clip is a sliver no NLE will keep, and only causes import warnings. */
const MIN_FRAMES = 1;

interface Placed {
  clip: Clip;
  /** Where it plays on the root timeline and from where in its source, ms. */
  startMs: number;
  endMs: number;
  sourceInMs: number;
  speed: number;
  /** Linear gain the clip plays at: its own volume times its lane's. */
  gain: number;
}

interface Lane {
  kind: 'video' | 'audio';
  enabled: boolean;
  items: Placed[];
}

/** A clip seen through a (possibly nested) composition, onto the root timeline. */
interface Frame {
  offsetMs: number;
  scale: number;
  fromMs: number;
  toMs: number;
  /** Gain of everything around it: the comp clips and lanes it plays through. */
  gain: number;
}

const ROOT: Frame = { offsetMs: 0, scale: 1, fromMs: -Infinity, toMs: Infinity, gain: 1 };

function place(clip: Clip, frame: Frame, laneGain: number): Placed | null {
  const rawStart = frame.offsetMs + clip.timelineStartMs * frame.scale;
  const rawEnd = frame.offsetMs + clipEndMs(clip) * frame.scale;
  const startMs = Math.max(rawStart, frame.fromMs);
  const endMs = Math.min(rawEnd, frame.toMs);
  if (endMs <= startMs) return null;
  const speed = clip.speed / frame.scale;
  return {
    clip,
    startMs,
    endMs,
    sourceInMs: clip.sourceInMs + (startMs - rawStart) * speed,
    speed,
    gain: clip.volume * laneGain * frame.gain,
  };
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildXmeml(input: XmemlInput): XmemlResult {
  const { project, assets, fps, startMs: spanStart, durationMs, sequenceName, mediaName } = input;
  const spanEnd = spanStart + durationMs;
  const omitted = { generated: 0, ramped: 0 };
  const omittedIds = new Set<string>();
  const omit = (clip: Clip, why: 'generated' | 'ramped') => {
    if (omittedIds.has(clip.id)) return;
    omittedIds.add(clip.id);
    omitted[why]++;
  };

  const videoLanes: Lane[] = [];
  const audioLanes: Lane[] = [];

  /**
   * Walk a track set top lane first. A composition's own lanes are inserted
   * right under the lane that plays it, at the z-level the clip had, and a
   * video clip carrying its own sound (not delegated to a linked audio clip)
   * gets that sound on an audio lane of its own.
   */
  const walk = (tracks: Track[], frame: Frame, depth: number, enabledAbove: boolean) => {
    if (depth > 16) return;
    const delegated = delegatedLinkIds(tracks);
    for (const track of tracks) {
      const laneGain = track.volume ?? 1;
      const enabled =
        enabledAbove && (track.kind === 'video' ? isTrackVisible(track, tracks) : isTrackAudible(track, tracks));
      const lane: Lane = { kind: track.kind, enabled, items: [] };
      const ownSound: Lane = { kind: 'audio', enabled: enabledAbove && isTrackAudible(track, tracks), items: [] };
      const nested: Array<{ tracks: Track[]; frame: Frame }> = [];
      for (const clip of track.clips) {
        const placed = place(clip, frame, laneGain);
        if (!placed || placed.endMs <= spanStart || placed.startMs >= spanEnd) continue;
        if (isCompClip(clip)) {
          const comp = findComp(project, clip.compId);
          if (!comp) continue;
          if (hasVelocity(clip)) {
            omit(clip, 'ramped');
            continue;
          }
          const scale = frame.scale / (clip.speed || 1);
          nested.push({
            tracks: comp.tracks,
            // Root position of the composition's own t=0: where the clip
            // starts, minus how far into the composition it starts.
            frame: {
              offsetMs: placed.startMs - placed.sourceInMs * scale,
              scale,
              fromMs: placed.startMs,
              toMs: placed.endMs,
              gain: placed.gain,
            },
          });
          continue;
        }
        if (isGeneratedClip(clip)) {
          omit(clip, 'generated');
          continue;
        }
        if (hasVelocity(clip)) {
          omit(clip, 'ramped');
          continue;
        }
        const asset = assets[clip.assetId];
        if (!asset) continue;
        lane.items.push(placed);
        if (
          track.kind === 'video' &&
          asset.hasAudio &&
          !(clip.linkId && delegated.has(clip.linkId))
        ) {
          ownSound.items.push(placed);
        }
      }
      (track.kind === 'video' ? videoLanes : audioLanes).push(lane);
      if (ownSound.items.length) audioLanes.push(ownSound);
      for (const n of nested) walk(n.tracks, n.frame, depth + 1, enabled);
    }
  };
  walk(project.tracks, ROOT, 0, true);

  const frames = (ms: number) => Math.round((ms / 1000) * fps);
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const [width, height] = SEQUENCE_SIZE[project.aspectRatio] ?? SEQUENCE_SIZE['16:9'];

  const fileIds = new Map<string, string>();
  const usedAssetIds: string[] = [];
  const fileElement = (asset: MediaAsset): string => {
    const known = fileIds.get(asset.id);
    if (known) return `<file id="${known}"/>`;
    const id = `file-${fileIds.size + 1}`;
    fileIds.set(asset.id, id);
    usedAssetIds.push(asset.id);
    const name = mediaName(asset);
    const assetRate = Math.round(asset.fps ?? fps) || fps;
    const media: string[] = [];
    if (asset.kind !== 'audio') {
      media.push(
        `<video><samplecharacteristics>${rate}<width>${asset.width ?? width}</width><height>${asset.height ?? height}</height></samplecharacteristics></video>`,
      );
    }
    if (asset.hasAudio) {
      const channels = Math.max(1, ...asset.audioTracks.map((a) => a.channels || 2));
      media.push(`<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio>`);
    }
    return (
      `<file id="${id}"><name>${escapeXml(name)}</name>` +
      `<pathurl>file://localhost/${encodeURI(name).replace(/#/g, '%23').replace(/\?/g, '%3F')}</pathurl>` +
      `<rate><timebase>${assetRate}</timebase><ntsc>FALSE</ntsc></rate>` +
      `<duration>${Math.max(1, Math.round((asset.durationMs / 1000) * assetRate))}</duration>` +
      `<media>${media.join('')}</media></file>`
    );
  };

  let itemCount = 0;
  const clipItem = (placed: Placed, kind: 'video' | 'audio'): string | null => {
    const asset = assets[placed.clip.assetId]!;
    const from = Math.max(placed.startMs, spanStart);
    const to = Math.min(placed.endMs, spanEnd);
    const start = frames(from - spanStart);
    const end = frames(to - spanStart);
    if (end - start < MIN_FRAMES) return null;
    const sourceIn = placed.sourceInMs + (from - placed.startMs) * placed.speed;
    const sourceOut = sourceIn + (to - from) * placed.speed;
    const isStill = asset.kind === 'image';
    const inF = isStill ? 0 : frames(sourceIn);
    const outF = isStill ? end - start : Math.max(inF + 1, frames(sourceOut));
    const filters: string[] = [];
    if (kind === 'video' && Math.abs(placed.speed - 1) > 1e-6 && !isStill) {
      filters.push(
        '<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>' +
          '<parameter><parameterid>variablespeed</parameterid><name>variablespeed</name><value>0</value></parameter>' +
          `<parameter><parameterid>speed</parameterid><name>speed</name><value>${(placed.speed * 100).toFixed(2)}</value></parameter>` +
          '<parameter><parameterid>reverse</parameterid><name>reverse</name><value>FALSE</value></parameter>' +
          '</effect></filter>',
      );
    }
    if (kind === 'audio' && Math.abs(placed.gain - 1) > 1e-6) {
      filters.push(
        '<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>' +
          `<parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${placed.gain.toFixed(5)}</value></parameter>` +
          '</effect></filter>',
      );
    }
    let sourceTrack = '';
    if (kind === 'audio') {
      const index = placed.clip.audioTrackIndex;
      const position = index === undefined ? 0 : Math.max(0, asset.audioTracks.findIndex((a) => a.index === index));
      sourceTrack = `<sourcetrack><mediatype>audio</mediatype><trackindex>${position + 1}</trackindex></sourcetrack>`;
    }
    itemCount++;
    return (
      `<clipitem id="clipitem-${itemCount}"><name>${escapeXml(mediaName(asset))}</name><enabled>TRUE</enabled>` +
      `<duration>${isStill ? end - start : Math.max(1, Math.round((asset.durationMs / 1000) * fps))}</duration>${rate}` +
      `<start>${start}</start><end>${end}</end><in>${inF}</in><out>${outF}</out>` +
      `${fileElement(asset)}${sourceTrack}${filters.join('')}</clipitem>`
    );
  };

  const trackXml = (lane: Lane): string => {
    const items = lane.items
      .slice()
      .sort((a, b) => a.startMs - b.startMs)
      .map((p) => clipItem(p, lane.kind))
      .filter((x): x is string => x !== null);
    return `<track><enabled>${lane.enabled ? 'TRUE' : 'FALSE'}</enabled>${items.join('')}</track>`;
  };

  // xmeml numbers video tracks bottom-up (V1 is the lowest), SelfCut lists
  // them top-down: reverse so what was on top stays on top.
  const video = videoLanes.filter((l) => l.items.length).reverse().map(trackXml);
  const audio = audioLanes.filter((l) => l.items.length).map(trackXml);

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">' +
    `<sequence id="sequence-1"><name>${escapeXml(sequenceName)}</name>` +
    `<duration>${frames(durationMs)}</duration>${rate}` +
    `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` +
    '<media>' +
    `<video><format><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>${video.join('')}</video>` +
    `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audio.join('')}</audio>` +
    '</media></sequence></xmeml>\n';

  return { xml, usedAssetIds, omitted };
}
