import { describe, it, expect } from 'vitest';
import type { Clip, Composition, MediaAsset, Project, Track } from '../../types';
import { buildZip, crc32 } from './zip';
import { WavWriter } from './wav';
import { buildXmeml } from './xmeml';
import { rushNames, stemProject } from './folder';

/**
 * The editor's folder: what an editor on Premiere or DaVinci receives instead
 * of a flattened render. Every piece is pure enough to pin here; the render of
 * the stems themselves is the export's mixer, covered where it lives.
 */

function clip(id: string, startMs: number, durMs: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'media',
    id,
    assetId: 'cam',
    trackId: 't',
    timelineStartMs: startMs,
    sourceInMs: 0,
    sourceOutMs: durMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...extra,
  } as Clip;
}

function lane(id: string, clips: Clip[], kind: Track['kind'] = 'video', extra: Partial<Track> = {}): Track {
  return { id, kind, clips: clips.map((c) => ({ ...c, trackId: id })), ...extra };
}

function project(tracks: Track[], comps: Composition[] = []): Project {
  return { id: 'p', aspectRatio: '16:9', fps: 60, tracks, markers: [], comps };
}

function asset(id: string, name: string, extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    file: new File([new Uint8Array(4)], name),
    kind: 'video',
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    audioTracks: [{ index: 1, channels: 2, sampleRate: 48000 } as MediaAsset['audioTracks'][number]],
    thumbnails: [],
    ...extra,
  };
}

const ASSETS: Record<string, MediaAsset> = {
  cam: asset('cam', 'interview.mov'),
  music: asset('music', 'music.mp3', { kind: 'audio', width: undefined, height: undefined, fps: undefined }),
};

function xmeml(p: Project, startMs = 0, durationMs = 10_000) {
  return buildXmeml({
    project: p,
    assets: ASSETS,
    fps: 30,
    startMs,
    durationMs,
    sequenceName: 'Episode <12>',
    mediaName: (a) => a.file.name,
  });
}

/** The clipitems of every track of one kind, as [start, end, in, out] tuples. */
function items(xml: string, kind: 'video' | 'audio'): number[][][] {
  // The sequence's own sections, not the <video>/<audio> of each file element.
  const section =
    kind === 'video'
      ? xml.slice(xml.indexOf('<media><video><format>'), xml.indexOf('<audio><numOutputChannels>'))
      : xml.slice(xml.indexOf('<audio><numOutputChannels>'), xml.indexOf('</media></sequence>'));
  return section
    .split('<track>')
    .slice(1)
    .map((track) =>
      [...track.matchAll(/<start>(\d+)<\/start><end>(\d+)<\/end><in>(\d+)<\/in><out>(\d+)<\/out>/g)].map((m) =>
        m.slice(1, 5).map(Number),
      ),
    );
}

describe('crc32 / buildZip', () => {
  it('computes the ZIP polynomial (check value of "123456789")', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('continues a CRC across chunks', () => {
    const all = new TextEncoder().encode('hello world');
    expect(crc32(all.subarray(6), crc32(all.subarray(0, 6)))).toBe(crc32(all));
  });

  it('writes a stored archive whose records point at each entry', async () => {
    const zip = await buildZip(
      [
        { name: 'a.txt', data: new Blob(['abc']) },
        { name: 'audio/plan séquence.wav', data: new Blob(['0123456789']) },
      ],
      () => false,
      undefined,
      new Date(2026, 9, 8, 14, 12),
    );
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);
    // End of central directory: two entries, and its offset lands on a record.
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
    // The second local header holds the UTF-8 name and the stored bytes.
    const second = view.getUint32(cdOffset + 46 + 5 + 42, true);
    expect(view.getUint32(second, true)).toBe(0x04034b50);
    const nameLength = view.getUint16(second + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(second + 30, second + 30 + nameLength));
    expect(name).toBe('audio/plan séquence.wav');
    expect(view.getUint32(second + 14, true)).toBe(crc32(new TextEncoder().encode('0123456789')));
    expect(new TextDecoder().decode(bytes.subarray(second + 30 + nameLength, second + 40 + nameLength))).toBe(
      '0123456789',
    );
  });
});

describe('WavWriter', () => {
  it('writes 24-bit PCM with a header that matches the data', async () => {
    const w = new WavWriter(48000, 2);
    w.push([new Float32Array([0, 1, -1]), new Float32Array([0.5, -0.5, 2])]);
    const bytes = new Uint8Array(await w.finish().arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(3 * 2 * 3);
    const sample = (i: number) => {
      const o = 44 + i * 3;
      const v = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
      return v & 0x800000 ? v - 0x1000000 : v;
    };
    // Interleaved L/R; full scale both ways, and an over (2) clamped, not wrapped.
    expect([sample(0), sample(1), sample(2), sample(3), sample(4), sample(5)]).toEqual([
      0, 0x3fffff + 1, 0x7fffff, -0x400000, -0x800000, 0x7fffff,
    ]);
  });

  it('tells silence from sound', () => {
    expect(WavWriter.isSilent([new Float32Array(10)])).toBe(true);
    expect(WavWriter.isSilent([new Float32Array([0, 0.01])])).toBe(false);
  });
});

describe('buildXmeml', () => {
  it('places each cut in frames, with source in and out', () => {
    const p = project([lane('v', [clip('c', 1000, 2000, { sourceInMs: 5000, sourceOutMs: 7000 })])]);
    const { xml } = xmeml(p);
    expect(items(xml, 'video')).toEqual([[[30, 90, 150, 210]]]);
    expect(xml).toContain('<timebase>30</timebase>');
    expect(xml).toContain('<name>Episode &lt;12&gt;</name>');
  });

  it('keeps the top lane on top: xmeml numbers video tracks from the bottom', () => {
    const p = project([lane('top', [clip('a', 0, 1000)]), lane('bottom', [clip('b', 2000, 1000)])]);
    expect(items(xmeml(p).xml, 'video')).toEqual([[[60, 90, 0, 30]], [[0, 30, 0, 30]]]);
  });

  it('gives a video clip its own sound only when no linked audio clip carries it', () => {
    const linked = project([
      lane('v', [clip('vid', 0, 1000, { linkId: 'L' })]),
      lane('a', [clip('aud', 0, 1000, { linkId: 'L' })], 'audio'),
    ]);
    expect(items(xmeml(linked).xml, 'audio')).toHaveLength(1);
    const unlinked = project([lane('v', [clip('vid', 0, 1000)])]);
    expect(items(xmeml(unlinked).xml, 'audio')).toEqual([[[0, 30, 0, 30]]]);
  });

  it('carries speed as a time remap and level as linear gain', () => {
    const p = project([
      lane('v', [clip('fast', 0, 1000, { sourceOutMs: 2000, speed: 2 })]),
      lane('a', [clip('m', 0, 1000, { assetId: 'music', volume: 0.5 })], 'audio', { volume: 0.5 }),
    ]);
    const { xml } = xmeml(p);
    expect(items(xml, 'video')).toEqual([[[0, 30, 0, 60]]]);
    expect(xml).toContain('<parameterid>speed</parameterid><name>speed</name><value>200.00</value>');
    expect(xml).toContain('<value>0.25000</value>');
  });

  it('trims to the exported region and starts the sequence at its first frame', () => {
    const p = project([lane('v', [clip('c', 0, 4000)])]);
    expect(items(xmeml(p, 1000, 2000).xml, 'video')).toEqual([[[0, 60, 30, 90]]]);
  });

  it('flattens a nest onto lanes of its own, at the time and rate it plays', () => {
    const inner = { id: 'k', name: 'Intro', markers: [], tracks: [lane('kv', [clip('in', 0, 2000)])] };
    const nestClip = {
      ...clip('nest', 1000, 1000, { sourceInMs: 500, sourceOutMs: 1500 }),
      kind: 'comp',
      compId: 'k',
      assetId: '',
    } as Clip;
    const p = project([lane('v', [nestClip])], [inner]);
    // The nest starts 1 s in and enters its composition 0.5 s in: the inner
    // clip shows from 1 s for 1 s, from 0.5 s of its source.
    expect(items(xmeml(p).xml, 'video')).toEqual([[[30, 60, 15, 45]]]);
  });

  it('says what it could not carry instead of dropping it silently', () => {
    const title = { ...clip('t', 0, 1000), kind: 'text', assetId: '' } as Clip;
    const ramp = clip('r', 2000, 1000, { velocity: [{ t: 0, value: 1 }] as Clip['velocity'] });
    const { omitted, usedAssetIds } = xmeml(project([lane('v', [title, ramp, clip('c', 4000, 1000)])]));
    expect(omitted).toEqual({ generated: 1, ramped: 1 });
    expect(usedAssetIds).toEqual(['cam']);
  });

  it('marks a muted lane disabled rather than leaving it out', () => {
    const p = project([lane('a', [clip('m', 0, 1000, { assetId: 'music' })], 'audio', { muted: true })]);
    expect(xmeml(p).xml).toContain('<track><enabled>FALSE</enabled><clipitem');
  });
});

describe('rushNames', () => {
  it('keeps two rushes with the same name apart', () => {
    const names = rushNames([asset('a', 'IMG_0001.MOV'), asset('b', 'img_0001.mov'), asset('c', 'x.mp4')], true);
    expect([...names.values()]).toEqual(['IMG_0001.MOV', 'img_0001 (2).mov', 'x.mp4']);
  });

  it('refers to a remuxed source by the name the editor has, unless it travels', () => {
    const remuxed = asset('a', 'remux.mkv', { originalSource: { name: 'GH010042.MP4', size: 1, lastModified: 0 } });
    expect(rushNames([remuxed], false).get('a')).toBe('GH010042.MP4');
    expect(rushNames([remuxed], true).get('a')).toBe('remux.mkv');
  });
});

describe('stemProject', () => {
  it('leaves only the target lane heard, whatever was muted or soloed', () => {
    const p = project([
      lane('a1', [], 'audio', { solo: true }),
      lane('a2', [], 'audio', { muted: true }),
      lane('v1', []),
    ]);
    const stem = stemProject(p, p.tracks[1]!);
    expect(stem.tracks.map((t) => [t.id, !!t.muted, !!t.solo])).toEqual([
      ['a1', true, false],
      ['a2', false, false],
      ['v1', true, false],
    ]);
    // The original is untouched.
    expect(p.tracks[0]!.solo).toBe(true);
  });
});
