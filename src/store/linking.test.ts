import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { MediaAsset } from '../types';
import { linkableSelection } from './projectOps';

/**
 * A/V linking: importing a video that carries audio must drop a picture clip AND
 * a linked audio clip, and every edit (move/trim/split/delete/duplicate) has to
 * keep the two sides in lockstep.
 *
 * The store is imported dynamically: its i18n dependency sets `document.lang` at
 * load time, so we stub a minimal `document` first (the suite runs in the node
 * environment, like the rest of the pure-logic tests).
 */

let useStore: typeof import('./store').useStore;

beforeAll(async () => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
  ({ useStore } = await import('./store'));
});

function videoAsset(id: string, durationMs = 5000, audioTrackCount = 1): MediaAsset {
  return {
    id,
    file: new File([], `${id}.mp4`),
    kind: 'video',
    durationMs,
    width: 1920,
    height: 1080,
    hasAudio: audioTrackCount > 0,
    audioTracks: Array.from({ length: audioTrackCount }, (_, i) => ({ index: i, channels: 2 })),
    thumbnails: [],
  };
}

const s = () => useStore.getState();

function tracksByKind() {
  const video = s().project.tracks.filter((t) => t.kind === 'video');
  const audio = s().project.tracks.filter((t) => t.kind === 'audio');
  return { video, audio };
}

/** The (video, audio) clips of the single linked pair on the timeline. */
function pair() {
  const clips = s().project.tracks.flatMap((t) => t.clips.map((c) => ({ c, kind: t.kind })));
  const video = clips.find((x) => x.kind === 'video')!.c;
  const audio = clips.find((x) => x.kind === 'audio')!.c;
  return { video, audio };
}

beforeEach(() => {
  useStore.getState().resetProject();
});

describe('addClipFromAsset', () => {
  it('creates a linked audio clip beside the video, aligned in time', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');

    const { video, audio } = tracksByKind();
    expect(video).toHaveLength(1);
    expect(audio).toHaveLength(1);
    const vClip = video[0]!.clips[0]!;
    const aClip = audio[0]!.clips[0]!;
    expect(vClip.linkId).toBeTruthy();
    expect(aClip.linkId).toBe(vClip.linkId);
    expect(aClip.timelineStartMs).toBe(vClip.timelineStartMs);
    expect(aClip.sourceOutMs).toBe(vClip.sourceOutMs);
    expect(aClip.assetId).toBe('v');
  });

  it('does not split audio for a silent video', () => {
    s().addAsset(videoAsset('v', 5000, 0));
    s().addClipFromAsset('v');
    const { video, audio } = tracksByKind();
    expect(video[0]!.clips).toHaveLength(1);
    expect(video[0]!.clips[0]!.linkId).toBeUndefined();
    expect(audio).toHaveLength(0);
  });

  it('explodes every audio track into its own linked clip on its own lane', () => {
    s().addAsset(videoAsset('v', 5000, 3));
    s().addClipFromAsset('v');

    const { video, audio } = tracksByKind();
    expect(video).toHaveLength(1);
    // One audio lane per source track, one extracted clip on each.
    expect(audio).toHaveLength(3);
    const audioClips = audio.flatMap((tr) => tr.clips);
    expect(audioClips).toHaveLength(3);

    const vClip = video[0]!.clips[0]!;
    // The whole group (video + 3 audio) shares one link.
    expect(vClip.linkId).toBeTruthy();
    for (const c of audioClips) {
      expect(c.linkId).toBe(vClip.linkId);
      expect(c.timelineStartMs).toBe(vClip.timelineStartMs);
    }
    // Each audio clip pins a distinct source track (0, 1, 2).
    expect(audioClips.map((c) => c.audioTrackIndex).sort()).toEqual([0, 1, 2]);
    // Each lane holds exactly one of the three.
    for (const tr of audio) expect(tr.clips).toHaveLength(1);
  });

  it('moves and deletes the whole exploded group together', () => {
    s().addAsset(videoAsset('v', 5000, 2));
    s().addClipFromAsset('v');
    const video = s().project.tracks.find((t) => t.kind === 'video')!.clips[0]!;

    s().moveClip(video.id, 2000);
    const allStarts = s()
      .project.tracks.flatMap((t) => t.clips)
      .map((c) => c.timelineStartMs);
    expect(allStarts).toEqual([2000, 2000, 2000]);

    s().deleteClip(video.id);
    const total = s().project.tracks.reduce((n, t) => n + t.clips.length, 0);
    expect(total).toBe(0);
  });
});

describe('linked edits', () => {
  beforeEach(() => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
  });

  it('moves the audio partner by the same delta', () => {
    const { video } = pair();
    s().moveClip(video.id, 2000);
    const after = pair();
    expect(after.video.timelineStartMs).toBe(2000);
    expect(after.audio.timelineStartMs).toBe(2000);
  });

  it('keeps the audio partner on its own track when the video changes track', () => {
    s().addTrack('video');
    const otherVideo = tracksByKind().video[1]!;
    const { video, audio } = pair();
    s().moveClip(video.id, 1000, otherVideo.id);
    const after = pair();
    expect(after.video.trackId).toBe(otherVideo.id);
    expect(after.audio.trackId).toBe(audio.trackId); // unchanged audio track
    expect(after.audio.timelineStartMs).toBe(1000);
  });

  it('trims both sides together', () => {
    const { video } = pair();
    s().trimClip(video.id, 'right', 3000);
    const after = pair();
    expect(after.video.sourceOutMs).toBe(after.audio.sourceOutMs);
    expect(after.audio.sourceOutMs).toBeLessThan(5000);
  });

  it('splits both sides and re-pairs each half', () => {
    s().seek(2000);
    s().selectClip(null);
    s().splitAtPlayhead();

    const videoClips = tracksByKind().video[0]!.clips;
    const audioClips = tracksByKind().audio[0]!.clips;
    expect(videoClips).toHaveLength(2);
    expect(audioClips).toHaveLength(2);

    // Four clips, two distinct links, each pairing exactly one video + one audio.
    const groups = new Map<string, string[]>();
    for (const c of [...videoClips, ...audioClips]) {
      expect(c.linkId).toBeTruthy();
      groups.set(c.linkId!, [...(groups.get(c.linkId!) ?? []), c.id]);
    }
    expect(groups.size).toBe(2);
    for (const ids of groups.values()) expect(ids).toHaveLength(2);
  });

  it('deletes the partner when one side is deleted', () => {
    const { audio } = pair();
    s().deleteClip(audio.id);
    const total = s().project.tracks.reduce((n, t) => n + t.clips.length, 0);
    expect(total).toBe(0);
  });

  it('unlinks into two independent, non-doubled clips', () => {
    const { video } = pair();
    s().unlinkClip(video.id);
    const after = pair();
    expect(after.video.linkId).toBeUndefined();
    expect(after.audio.linkId).toBeUndefined();
    // Audio stays on the audio clip; the video side is muted so sound is not doubled.
    expect(after.video.volume).toBe(0);
    expect(after.audio.volume).toBe(1);
  });

  it('leaves unlinked clips free to move on their own', () => {
    const { video, audio } = pair();
    s().unlinkClip(video.id);
    s().moveClip(video.id, 3000);
    const after = pair();
    expect(after.video.timelineStartMs).toBe(3000);
    expect(after.audio.timelineStartMs).toBe(audio.timelineStartMs); // unchanged
  });

  it('duplicates the pair as a fresh link', () => {
    const { video } = pair();
    s().duplicateClips([video.id]);
    const videoClips = tracksByKind().video[0]!.clips;
    const audioClips = tracksByKind().audio[0]!.clips;
    expect(videoClips).toHaveLength(2);
    expect(audioClips).toHaveLength(2);
    const links = new Set([...videoClips, ...audioClips].map((c) => c.linkId));
    expect(links.size).toBe(2); // original link + the duplicate's link
  });
});

describe('re-link', () => {
  beforeEach(() => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
  });

  it('joins two unlinked clips into one shared link', () => {
    const { video, audio } = pair();
    s().unlinkClip(video.id);
    s().linkClips([video.id, audio.id]);
    const after = pair();
    expect(after.video.linkId).toBeTruthy();
    expect(after.audio.linkId).toBe(after.video.linkId);
  });

  it('auto-pairs a single unlinked clip with its same-asset partner', () => {
    const { video } = pair();
    s().unlinkClip(video.id);
    // Only the video is selected; its audio is resolved as the link candidate.
    const targets = linkableSelection(s().project, [video.id]);
    expect(targets).not.toBeNull();
    s().linkClips(targets!);
    const after = pair();
    expect(after.video.linkId).toBe(after.audio.linkId);
    expect(after.video.linkId).toBeTruthy();
  });

  it('offers no link target while the pair is already linked', () => {
    const { video } = pair();
    expect(linkableSelection(s().project, [video.id])).toBeNull();
  });

  it('makes re-linked clips move together again', () => {
    const { video, audio } = pair();
    s().unlinkClip(video.id);
    s().linkClips([video.id, audio.id]);
    s().moveClip(video.id, 2500);
    const after = pair();
    expect(after.video.timelineStartMs).toBe(2500);
    expect(after.audio.timelineStartMs).toBe(2500);
  });
});

/**
 * A link group is generic: any number of clips on video and audio tracks, no
 * master side. Linking a clip to a group that already exists must ADD it,
 * keeping the group whole rather than re-grouping a subset under a new id.
 */
describe('multi-clip link groups', () => {
  const allClips = () => s().project.tracks.flatMap((t) => t.clips);

  it('adds a third audio clip to an existing two-clip group', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    const { video, audio } = pair();
    const groupId = video.linkId;

    // A second audio clip from another asset, linked into the same group.
    s().addAsset({ ...videoAsset('w'), id: 'w', kind: 'audio' } as MediaAsset);
    s().addClipFromAsset('w');
    const extra = allClips().find((c) => c.assetId === 'w')!;

    s().linkClips([audio.id, extra.id]);

    const after = allClips();
    // The group id is preserved, so the video that was not selected stays in.
    expect(after.filter((c) => c.linkId === groupId)).toHaveLength(3);
  });

  it('keeps the group whole when linking through linkableSelection', () => {
    s().addAsset(videoAsset('v', 5000, 2));
    s().addClipFromAsset('v');
    const clips = allClips();
    const groupId = clips[0]!.linkId;
    expect(clips.filter((c) => c.linkId === groupId)).toHaveLength(3);

    // Unlink, then re-link from the video alone: both audio lanes come back.
    s().unlinkClip(clips[0]!.id);
    const targets = linkableSelection(s().project, [clips[0]!.id]);
    expect(targets).toHaveLength(3);
    s().linkClips(targets!);
    const after = allClips();
    expect(after.filter((c) => c.linkId === after[0]!.linkId)).toHaveLength(3);
  });

  it('moves every member of a three-clip group together', () => {
    s().addAsset(videoAsset('v', 5000, 2));
    s().addClipFromAsset('v');
    const first = allClips()[0]!;
    s().moveClip(first.id, 3000);
    for (const c of allClips()) expect(c.timelineStartMs).toBe(3000);
  });

  it('does not silence a group that holds no audio-track clip', () => {
    // Two video clips linked together delegate nothing: unlinking them must
    // leave their volume alone, unlike the video side of an A/V group.
    s().addAsset(videoAsset('v', 5000, 0));
    s().addClipFromAsset('v');
    s().addClipFromAsset('v');
    const clips = allClips();
    expect(clips).toHaveLength(2);
    expect(clips.every((c) => c.linkId == null)).toBe(true);

    s().linkClips([clips[0]!.id, clips[1]!.id]);
    s().unlinkClip(clips[0]!.id);
    for (const c of allClips()) expect(c.volume).toBeGreaterThan(0);
  });
});

describe('addSubtitleClips', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'one' },
    { startMs: 2000, endMs: 3000, text: 'two' },
  ];
  const clips = () => s().project.tracks.flatMap((t) => t.clips);
  /** Captions sit on their own video lane, so `pair()` can't tell them apart. */
  const captions = () =>
    clips()
      .filter((c) => c.kind === 'text')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const picture = () => clips().find((c) => c.kind === 'media' && c.assetId === 'v')!;
  const sound = () =>
    s()
      .project.tracks.filter((t) => t.kind === 'audio')
      .flatMap((t) => t.clips)[0]!;

  /** A video with one audio track, on the timeline, plus its container captions. */
  function importWithCaptions() {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    s().addSubtitleClips(cues, 'v');
  }

  it('links container captions to the footage they came from', () => {
    importWithCaptions();

    // The captions join the picture clip's EXISTING group, so the extracted
    // audio stays in the same set rather than being split off.
    const linkId = picture().linkId;
    expect(linkId).toBeTruthy();
    expect(captions()).toHaveLength(2);
    for (const c of captions()) expect(c.linkId).toBe(linkId);
    expect(sound().linkId).toBe(linkId);
  });

  it('carries the captions when the footage moves', () => {
    importWithCaptions();
    s().moveClip(picture().id, 4000);

    expect(captions().map((c) => c.timelineStartMs)).toEqual([4000, 6000]);
  });

  it('leaves cue timings alone when the footage is trimmed', () => {
    // Trim re-aims a clip into its media; a caption has no source to absorb
    // that, so the group's text side must sit the edit out.
    importWithCaptions();
    const before = captions().map((c) => ({ ...c }));
    s().trimClip(picture().id, 'left', 1500);

    for (const [i, c] of captions().entries()) {
      expect(c.timelineStartMs).toBe(before[i]!.timelineStartMs);
      expect(c.sourceInMs).toBe(before[i]!.sourceInMs);
      expect(c.sourceOutMs).toBe(before[i]!.sourceOutMs);
    }
    // The extracted audio still trims in lockstep with the picture.
    expect(picture().sourceInMs).toBeGreaterThan(0);
    expect(sound().sourceInMs).toBe(picture().sourceInMs);
  });

  it('drops captions lower in landscape than in vertical', () => {
    // The bottom band is not one fixed fraction: a phone player covers the last
    // stretch of the frame with its own chrome, so vertical sits higher while
    // 16:9 follows the tighter broadcast lower third.
    s().setAspectRatio('16:9');
    s().addSubtitleClips(cues);
    const landscape = captions()[0]!.transform!.y;

    s().resetProject();
    s().setAspectRatio('9:16');
    s().addSubtitleClips(cues);
    const vertical = captions()[0]!.transform!.y;

    expect(landscape).toBeGreaterThan(vertical);
    // Both stay inside the bottom third, which is all a subtitle file can say.
    for (const y of [landscape, vertical]) expect(y).toBeGreaterThan(0.67);
    expect(landscape).toBeLessThan(1);
  });

  it('leaves a loose .srt unlinked', () => {
    s().addAsset(videoAsset('v'));
    s().addClipFromAsset('v');
    s().addSubtitleClips(cues);

    for (const c of captions()) expect(c.linkId).toBeUndefined();
  });

  it('replaces a previous pass instead of stacking a second caption lane', () => {
    importWithCaptions();
    const first = captions().map((c) => c.id);
    const lanes = s().project.tracks.length;

    s().addSubtitleClips([{ startMs: 0, endMs: 500, text: 'again' }], 'v', first);

    expect(captions().map((c) => c.text.content)).toEqual(['again']);
    // The emptied lane went with its clips: one lane in, one lane out.
    expect(s().project.tracks).toHaveLength(lanes);
  });

  it('undoes a regeneration in one step', () => {
    // Delete-then-add as two history entries would let an undo land on the
    // state where the old cues are gone and the new ones are not there yet.
    importWithCaptions();
    const first = captions().map((c) => c.id);
    s().addSubtitleClips([{ startMs: 0, endMs: 500, text: 'again' }], 'v', first);
    s().undo();

    expect(captions().map((c) => c.text.content)).toEqual(['one', 'two']);
  });

  it('keeps an empty lane the replacement did not empty', () => {
    importWithCaptions();
    s().addTrack('video');
    const before = s().project.tracks.length;

    s().addSubtitleClips([{ startMs: 0, endMs: 500, text: 'again' }], 'v', captions().map((c) => c.id));

    // One lane removed (the emptied caption one), one added (the new cues):
    // the hand-added empty lane is untouched.
    expect(s().project.tracks).toHaveLength(before);
    expect(s().project.tracks.some((t) => t.clips.length === 0)).toBe(true);
  });
});
