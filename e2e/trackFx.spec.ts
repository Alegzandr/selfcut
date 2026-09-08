import { test, expect, type Page } from './test';
import { appModuleUrl } from './appModule';

/**
 * FX on a whole lane, from the header button to the monitor.
 *
 * The claim a unit test cannot make: a track grade is applied ONCE to the
 * lane's composited picture and reaches the actual preview. Both halves have
 * failed silently before in this renderer - a grade wired into a path the
 * preview does not take looks exactly like a grade at the identity - so the
 * assertions read pixels back off the monitor rather than fields off the store.
 *
 * A solid clip is the subject on purpose: its colour is exact and known, so
 * "the lane was desaturated" is arithmetic (#6366f1 → its BT.709 luma in grey)
 * rather than an impression.
 */

const STORE = '/src/store/store.ts';

/** The indigo a solid clip is laid down in. */
const SOLID: [number, number, number] = [0x63, 0x66, 0xf1];

/** Fully desaturated, the three channels collapse onto the source's luma. */
const SOLID_LUMA = 0.2126 * SOLID[0] + 0.7152 * SOLID[1] + 0.0722 * SOLID[2];

type Pixel = [number, number, number];

interface StoreShape {
  useStore: {
    getState: () => {
      addSolidClip: (kind: 'color' | 'gradient') => void;
      setTrackColorLive: (trackId: string, prop: string, value: number) => void;
      project: { tracks: { id: string; kind: string }[] };
    };
  };
}

/** Lay a full-frame solid on a video lane and hand back that lane's id. */
async function solidOnALane(page: Page): Promise<string> {
  const url = await appModuleUrl(page, STORE);
  return page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as StoreShape;
    useStore.getState().addSolidClip('color');
    return useStore.getState().project.tracks.find((t) => t.kind === 'video')!.id;
  }, url);
}

async function setLaneGrade(page: Page, trackId: string, value: number): Promise<void> {
  const url = await appModuleUrl(page, STORE);
  await page.evaluate(
    async ({ mod, id, v }) => {
      const { useStore } = (await import(mod)) as StoreShape;
      useStore.getState().setTrackColorLive(id, 'saturation', v);
    },
    { mod: url, id: trackId, v: value },
  );
}

/** The colour at the centre of the monitor, where the full-frame clip is. */
async function centrePixel(page: Page): Promise<Pixel> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-preview-canvas]') as HTMLCanvasElement;
    // Copied out rather than read in place: the preview's own context is not
    // `willReadFrequently`, and this must not change how it is composited.
    const read = document.createElement('canvas');
    read.width = 1;
    read.height = 1;
    const ctx = read.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, canvas.width / 2, canvas.height / 2, 1, 1, 0, 0, 1, 1);
    const { data } = ctx.getImageData(0, 0, 1, 1);
    return [data[0]!, data[1]!, data[2]!] as Pixel;
  });
}

/**
 * Poll the monitor until its centre satisfies `ok`.
 *
 * The poll resolves to a STRING rather than a boolean so a failure prints the
 * colour that was actually on screen: "expected 'ok', received 'rgb(99,102,241)'"
 * says which half of the pipeline stopped, and `false` says nothing at all.
 */
function expectCentre(page: Page, message: string, ok: (px: Pixel) => boolean) {
  return expect
    .poll(
      async () => {
        const px = await centrePixel(page);
        return ok(px) ? 'ok' : `rgb(${px.join(', ')})`;
      },
      { message },
    )
    .toBe('ok');
}

/** Within a couple of code values - the colour pass dithers its 8-bit write. */
const isSolid = (px: Pixel) => px.every((v, i) => Math.abs(v - SOLID[i]!) <= 2);
const isGrey = ([r, g, b]: Pixel) => Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2;

test.beforeEach(async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
});

test('a grade set on the lane reaches the monitor, and comes back off it', async ({ page }) => {
  const trackId = await solidOnALane(page);
  await expectCentre(page, 'the solid is on the monitor, ungraded', isSolid);

  await setLaneGrade(page, trackId, -1);
  // Asserting the luma, not just "the channels are equal", is what separates a
  // real grade from a lane that went black or was never drawn at all.
  await expectCentre(
    page,
    'the whole lane is desaturated',
    (px) => isGrey(px) && Math.abs(px[0] - SOLID_LUMA) <= 6,
  );

  // Taken off again, the lane is exactly what it was. A track pass that leaked
  // - a scratch canvas left dirty, a grade cached past its edit - shows up here
  // and nowhere else.
  await setLaneGrade(page, trackId, 0);
  await expectCentre(page, 'the lane is back to its own colour', isSolid);
});

test('the export composites the lane grade too, not just the preview', async ({ page }) => {
  // Driven through `FrameRenderer` rather than through a real export: it is the
  // exact class both the serial render and every parallel worker composite
  // with, and reaching it directly costs one solid fill instead of a full
  // encode. What is being checked is that the export's own track loop hands
  // each lane's clips to the same track pass the preview uses - the two walk
  // their tracks in different code, which is precisely how they drift apart.
  const url = await appModuleUrl(page, '/src/export/frameRenderer.ts');
  const px = await page.evaluate(async (mod) => {
    const { FrameRenderer } = (await import(mod)) as {
      FrameRenderer: new (opts: unknown) => {
        canvas: OffscreenCanvas;
        ready: () => Promise<void>;
        renderFrame: (index: number) => Promise<void>;
      };
    };
    const clip = {
      kind: 'solid',
      id: 'c1',
      assetId: '',
      trackId: 't1',
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 3000,
      speed: 1,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      solid: { kind: 'color', color: '#6366f1' },
    };
    const project = {
      id: 'p1',
      aspectRatio: '16:9',
      fps: 30,
      markers: [],
      tracks: [{ id: 't1', kind: 'video', clips: [clip], color: { saturation: -1 } }],
    };
    const renderer = new FrameRenderer({
      project,
      files: {},
      stills: {},
      width: 128,
      height: 72,
      fps: 30,
      startMs: 0,
    });
    await renderer.ready();
    await renderer.renderFrame(0);
    const read = new OffscreenCanvas(1, 1);
    const ctx = read.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(renderer.canvas, 64, 36, 1, 1, 0, 0, 1, 1);
    const { data } = ctx.getImageData(0, 0, 1, 1);
    return [data[0]!, data[1]!, data[2]!] as [number, number, number];
  }, url);

  expect(isGrey(px), `exported centre was rgb(${px.join(', ')})`).toBe(true);
  expect(Math.abs(px[0] - SOLID_LUMA)).toBeLessThanOrEqual(6);
});

/**
 * Render a lane of tone through the mix, with and without a track effect, and
 * hand back the level of each.
 *
 * Offline rather than in real time, through the very function the export uses:
 * a Web Audio graph cannot be inspected from the outside, so the only honest
 * question to ask of a track effect is whether the samples that come out are
 * louder. A 100 Hz tone under a +10 dB low shelf is a claim with an arithmetic
 * answer (~3.2x), which is what makes "the chain is wired in" distinguishable
 * from "the chain exists and nothing goes through it".
 */
async function laneLevels(page: Page): Promise<{ dry: number; wet: number }> {
  const url = await appModuleUrl(page, '/src/preview/audioMix.ts');
  return page.evaluate(async (mod) => {
    const { scheduleProjectAudio } = (await import(mod)) as {
      scheduleProjectAudio: (...args: unknown[]) => unknown;
    };
    const RATE = 48000;
    const HZ = 100;

    const render = async (audioFx: unknown) => {
      const ctx = new OfflineAudioContext(1, RATE, RATE);
      const buffer = ctx.createBuffer(1, RATE, RATE);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < RATE; i++) data[i] = 0.25 * Math.sin((2 * Math.PI * HZ * i) / RATE);
      const clip = {
        kind: 'media',
        id: 'c1',
        assetId: 'a1',
        trackId: 't1',
        timelineStartMs: 0,
        sourceInMs: 0,
        sourceOutMs: 1000,
        speed: 1,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
      };
      const project = {
        id: 'p1',
        aspectRatio: '16:9',
        fps: 30,
        markers: [],
        tracks: [{ id: 't1', kind: 'audio', clips: [clip], ...(audioFx ? { audioFx } : {}) }],
      };
      scheduleProjectAudio(
        ctx,
        ctx.destination,
        project,
        () => [{ buffer, startMs: 0, index: 0 }],
        0,
        0,
        1000,
      );
      const out = (await ctx.startRendering()).getChannelData(0);
      // The middle half only: the shelf takes a few cycles to settle, and the
      // tail is where the buffer runs out.
      let sum = 0;
      const from = RATE / 4;
      const to = (RATE * 3) / 4;
      for (let i = from; i < to; i++) sum += out[i]! * out[i]!;
      return Math.sqrt(sum / (to - from));
    };

    return {
      dry: await render(null),
      wet: await render([{ type: 'bass', amount: 1 }]),
    };
  }, url);
}

test('an effect on an audio lane processes the lane, not nothing', async ({ page }) => {
  const { dry, wet } = await laneLevels(page);
  // The tone came through at all: a dry level near zero would make the ratio
  // below meaningless.
  expect(dry).toBeGreaterThan(0.1);
  // A biquad low shelf's `frequency` is the MIDDLE of its transition, not its
  // corner, so a 100 Hz tone under the `bass` effect's +10 dB shelf at 140 Hz
  // comes out around +7.7 dB (~2.4x) rather than the full +10. The band is
  // wide enough for that and far too narrow for a chain that is not wired in
  // (1x) or one applied twice (~6x).
  expect(wet / dry).toBeGreaterThan(2);
  expect(wet / dry).toBeLessThan(3);
});

test('the header FX button opens the lane pane, and the catalogue fills it', async ({ page }) => {
  await solidOnALane(page);

  await page.getByRole('button', { name: 'Track effects…' }).first().click();
  // The pane names the lane it is pointed at, so two open headers can never be
  // confused for one another.
  await expect(page.getByRole('heading', { name: /Track FX · V1/ })).toBeVisible();

  // With the pane up, the catalogue applies to the LANE rather than to the clip
  // selection - which is the only path a touch device has, since there is no
  // drag gesture under a finger.
  await page.getByRole('button', { name: 'Effects', exact: true }).click();
  await page.getByRole('button', { name: 'B&W', exact: true }).dblclick();

  await expectCentre(page, 'the catalogue graded the lane, not the clip', isGrey);
  // One undo step takes it back off, and nothing is left underneath.
  await page.keyboard.press('Control+z');
  await expectCentre(page, 'one undo step takes the lane grade off', isSolid);
});
