---
version: 1
slug: "src-pages-index-astro"
primary_target: "src/pages/index.astro"
related_targets: ["src/pages/[lang]/index.astro","src/layouts/Landing.astro"]
---

## Scope

Landing page (`/` and `/<lang>/`), mode: Persuade. Full redesign, replaces the previous landing.

## Audience and job

Amateur short-form creators (YouTube, TikTok, Reels, gaming clips) and people who must edit without being editors. They must leave believing SelfCut is a serious, complete editor (not "quick software"), that their footage never leaves their machine, and that the export is right for the platform by default. Action: open the editor (`/app/`).

Proof on hand: the editor replica (`Editor.astro`, built from app tokens and dictionaries), real gameplay stills in `public/landing/`, verified product facts (local Whisper captions, -14 LUFS master + -1 dB limiter on by default, H.264/HEVC/AV1 up to 4K / 120 fps, scopes, curves, LUTs, chroma key, tracked masks, keyframes, 8 languages, no watermark, no account).

Constraints: no em dashes; no developer-oriented touches; no neon pill overlays; 8 locales must share one key set; CSP self-hosted assets only; WCAG AA.

## Direction contract

THESIS: The category standard, played straight at Linear's finish level: a dark product page where the real editor is the hero image and every section proves one capability with the interface itself. It refuses the "fast, simple, one tab" pitch: the headline sells a serious edit delivered clean.

OWN-WORLD: Near-black zinc ground, one violet brand accent used only for the primary action and focus, two-tone headings (white lead clause, zinc-500 continuation), hairline 1px rules with a faint top highlight, Madefor Display tight-tracked headings, Madefor Text copy, the app's own blue/emerald only inside the replica and product visuals.

STORY: Understand (a full editor in the browser) → believe (timeline, captions, formats, grading depth, all shown) → trust (nothing uploaded, good defaults, no lock-in) → act (open the editor).

FIRST VIEWPORT: Centered headline at ~4.5rem desktop, lead below, primary "Start editing" + secondary "See what it does" side by side, small note line; under it the full editor replica at near column width tilting from a slight perspective to flat as it rises, top light behind it, bottom fade into the page. Primary action above the fold at 1440x900 and 390x844.

FORM: Canon (standing exit), user-chosen; quality bar: Linear. Seed key f761fdc2.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment

The editor rising and flattening into place as the playhead sweeps and the monitor cuts between real shots.
