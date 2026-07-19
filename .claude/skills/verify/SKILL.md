---
name: verify
description: Drive the SelfCut editor in a real browser to observe a change working - launch Vite, import media, manipulate clips on the timeline, capture screenshots.
---

# Verifying SelfCut changes

SelfCut is a browser-only NLE (Vite + React + Zustand). The surface is
pixels: every verification means loading the app, importing media and
driving the timeline with a real pointer.

## Launch

```bash
npm run dev        # background it - Vite prints the URL and stays up
```

**Check the printed URL.** `vite.config.ts` sets `base`, and the editor
is a separate entry from the landing page - it has lived at both
`/selfcut/` and `/app/`. Read the dev server's output rather than
assuming; a stale URL 404s into an empty page with zero `<input>`
elements, which looks exactly like a broken build.

## Get a browser

No Playwright in `package.json`, but the CLI and Chromium are on the
machine. Require the module from the npx cache:

```js
const { chromium } = require(
  'C:/Users/Alegzandr/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright');
```

(`ls ~/AppData/Local/npm-cache/_npx/*/node_modules` to re-find it if
that hash changes.)

## Get media in

The empty timeline renders a hidden `input[type=file]`
(`src/timeline/Timeline.tsx`). Feed it directly - no dialog:

```js
await page.setInputFiles('input[type=file]', '/path/to/tone.wav');
await page.waitForSelector('[data-clip-id]');
await page.waitForTimeout(1200);   // decode + waveform peaks
```

A synthetic WAV is enough and decodes instantly. 16-bit PCM mono
44.1 kHz with a varying envelope gives a legible waveform - see
`scripts` in any prior scratchpad, or generate one with `Buffer` and a
44-byte RIFF header.

## Useful hooks in the DOM

- `[data-clip-id]` - one per clip, `data-clip-kind` is `video`/`audio`
- `[data-track-id]` - the track row; its `input[type=range]` are the
  track faders. **The inspector's sliders come first in DOM order**, so
  a bare `input[type=range]` selector grabs the wrong one.
- `[data-rowbg]` - the track row background
- Inspector rows are `<label>` elements: the first `<span>` is the
  label, the last is the value read-out.
- Drag read-out badges are the leaf `div`s containing the value; the
  clip's own status badge sits top-right.

## Driving gestures

Everything on the timeline is pointer-driven, so use `page.mouse`
rather than `locator.click()` - the components read `pointerdown` /
`pointermove` / `pointerup` and a synthesized click does nothing.
Move in several `steps`: the drag only arms past a 4 px threshold.

```js
await page.mouse.move(x, y);
await page.mouse.down();
await page.mouse.move(x, y - 30, { steps: 6 });
await page.mouse.up();
```

Modifiers matter: Shift, Ctrl and Alt on a clip select a range, copy /
ripple, and slip / roll respectively.

## Gotchas

- Clips are `overflow-hidden`. Anything positioned at the very top or
  bottom edge gets clipped away - and if it is a grab handle, it
  becomes unreachable while still looking fine in the code.
- Undo groups one gesture into one history entry through
  `beginGesture` / `endGesture`. Verify with Ctrl+Z that a drag undoes
  in a single step, not per pointer event.
- The project persists to IndexedDB. A fresh Playwright context starts
  empty, but reusing a profile carries the old project over - and then
  there is no file input to find.
