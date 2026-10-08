---
name: SelfCut Landing
description: The marketing landing for SelfCut, a dark product page where the real editor is the picture and each section proves one capability with the interface itself.
colors:
  ground: "oklch(11.5% 0.004 286)"
  raised: "oklch(15.5% 0.005 286)"
  panel: "oklch(21% 0.006 285.885)"
  line: "oklch(27.4% 0.006 286.033)"
  line-strong: "oklch(37% 0.013 285.805)"
  hair: "oklch(100% 0 0 / 0.075)"
  hair-strong: "oklch(100% 0 0 / 0.13)"
  text: "oklch(97% 0.002 286)"
  muted: "oklch(72% 0.012 286)"
  faint: "oklch(62% 0.014 286)"
  heading-dim: "oklch(56% 0.014 286)"
  on-accent: "#ffffff"
  violet-action: "oklch(52.2% 0.245 293.2)"
  violet-action-hover: "oklch(56.5% 0.25 298)"
  violet-focus: "oklch(60.6% 0.254 302.9)"
  violet-text: "oklch(78% 0.135 303.5)"
  violet-selection: "oklch(44% 0.215 292)"
  replica-ground: "oklch(14.1% 0.005 285.823)"
  replica-blue: "oklch(68.7% 0.14 234)"
  replica-blue-pick: "oklch(49.6% 0.224 263.5)"
  replica-blue-deep: "oklch(22% 0.086 264)"
  replica-emerald: "oklch(37.8% 0.077 168.94)"
  replica-emerald-deep: "oklch(26.2% 0.051 172.552)"
  replica-emerald-text: "oklch(84.5% 0.143 164.978)"
  playhead-red: "oklch(63.7% 0.237 25.331)"
typography:
  display:
    fontFamily: "Madefor Display, system-ui, sans-serif"
    fontSize: "clamp(2.75rem, 6.2vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.038em"
  headline:
    fontFamily: "Madefor Display, system-ui, sans-serif"
    fontSize: "clamp(2.1rem, 4.4vw, 3.4rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.028em"
  title:
    fontFamily: "Madefor Display, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.012em"
  lede:
    fontFamily: "Madefor Text, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1.3vw, 1.1875rem)"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Madefor Text, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.65
  body-small:
    fontFamily: "Madefor Text, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Madefor Display, system-ui, sans-serif"
    fontSize: "0.9875rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  app:
    fontFamily: "Madefor Text, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  chip: "0.375rem"
  inner: "0.5rem"
  control: "0.625rem"
  tile: "0.75rem"
  frame: "0.875rem"
  panel: "1rem"
spacing:
  gutter: "clamp(1.25rem, 4vw, 3rem)"
  section: "clamp(5.5rem, 11vw, 9.5rem)"
  column: "72rem"
  measure: "62ch"
  cell: "clamp(1.5rem, 3vw, 2.5rem)"
components:
  button-primary:
    backgroundColor: "{colors.violet-action}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.6rem 1.15rem"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.violet-action-hover}"
  button-primary-large:
    backgroundColor: "{colors.violet-action}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "0.75rem 1.4rem"
    height: "3rem"
  button-ghost:
    backgroundColor: "oklch(100% 0 0 / 0.03)"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.6rem 1.15rem"
    height: "44px"
  button-ghost-hover:
    backgroundColor: "oklch(100% 0 0 / 0.07)"
  nav-link:
    textColor: "{colors.muted}"
    rounded: "{rounded.inner}"
    padding: "0.5rem 0.8rem"
  nav-link-hover:
    textColor: "{colors.text}"
  raised-panel:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.panel}"
    padding: "{spacing.cell}"
  app-panel:
    backgroundColor: "{colors.panel}"
    textColor: "oklch(87.1% 0.006 286.286)"
    typography: "{typography.app}"
    rounded: "{rounded.control}"
  app-chip-on:
    backgroundColor: "{colors.replica-blue-pick}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.chip}"
    padding: "0.2rem 0.5rem"
---

# Design System: SelfCut Landing

Scope: this file documents the marketing landing only (`src/pages/index.astro`, `src/pages/[lang]/index.astro`, `src/layouts/Landing.astro`, `src/components/landing/`, tokens in `src/styles/landing.css`). The editor app has its own Tailwind theme in `src/index.css`, and since the in-app redesign it shares this world: Madefor Text as its one UI family (Display for surface titles via `title-display`), the same translucent hairlines (`border-hair`, `border-hair-strong`), the violet `brand-action` finish on Export, `sheet` and `popover` shells for dialogs and menus, and the two-tone heading with the hero light on the empty timeline. The landing mirrors those app tokens (zinc, brand violet, blue, emerald, red, hairlines, font) as custom properties so that the editor replica and the product fragments inside the page stay pixel-identical to the app; outside those fragments, the landing speaks its own vocabulary below.

## Overview

**Creative North Star: "The Lit Workbench"**

A near-black room with one light above it, and the real tool on the bench. The page is dark, quiet and exact; the editor replica is the brightest, densest object in it, and every section proves a capability by showing the interface that does it rather than illustrating it. The finish bar is a top-tier product page: hairline rules that read as light on an edge, tight-tracked display headings, generous vertical rhythm, and one violet accent that is spent almost entirely on the action.

Density is deliberately uneven. Copy passages are sparse and centered or left on one column; product passages (the replica, the export sheet, the grading and keyframe fragments) are as dense as the app itself, set in the app's own face at the app's own sizes. The contrast between the two is the argument: a calm page around a serious tool.

Confirmed rejections carried from the product: no generic SaaS look (no card grids, no decorative gradients, no dashboard tiles), no neon pill overlays floating on the preview (a caption is burnt into the frame as the editor renders it), and nothing developer-oriented on the page.

**Key Characteristics:**
- Near-black zinc ground with a single faint violet wash from above in the hero, returned from below at the close.
- Two-tone headings: the claim in near-white, its consequence stepped down to a dim zinc in the same sentence.
- Translucent white hairlines (7.5% and 13%) for every rule and border, on the page and inside the product fragments alike, because the app draws with them too.
- Madefor Display for headings, buttons and term labels; Madefor Text for copy and for anything that is a piece of the app.
- Product fragments built from the app's own tokens and dictionaries, never screenshots of UI.
- One authored scroll motion (the hero editor laying itself flat) and looping product demos on shared clocks; everything stills under reduced motion.

## Colors

A monochrome zinc world with a single violet voice; the app's blue and emerald appear only where the page is showing the app.

### Primary
- **Action Violet** (violet-action): the fill of every primary button (header, hero, closing) and the skip link. White text on it clears 6.2:1. It is also the color of the replica's Export button, because the app paints it there.
- **Lifted Violet** (violet-action-hover): primary button hover only.
- **Focus Violet** (violet-focus): the 2px focus outline on every focusable element, offset 3px.
- **Soft Violet** (violet-text): the rare violet text marker, used for the current-language marker in the language dialog.
- **Selection Violet** (violet-selection): the `::selection` background, with white text.
- The hero light is the same hue at low alpha (`oklch(52% 0.2 293 / 0.2)` falling off to transparent), and the closing section returns it from below at 0.16. It is light, not a fill.

### Secondary (replica only)
- **Pick Blue** (replica-blue, replica-blue-pick, replica-blue-deep): what the app uses for "selected": the chosen preset's border and tint, the active quality and chip, the ticked checkbox, video clips on the timeline, the selected keyframe. Never used for landing UI outside a product fragment.

### Tertiary (replica only)
- **Waveform Emerald** (replica-emerald, replica-emerald-deep, replica-emerald-text): audio clips and the MP3 format's waveform body, exactly as the app draws audio.
- **Playhead Red** (playhead-red): the playhead and the red curve channel. Nothing else.

### Neutral
- **Ground** (ground): the page background, a hair darker than the app's zinc-950 so the replica reads as an object on it. Also `theme-color` (#0b0b0d).
- **Raised** (raised): the one lifted surface of the page: the format bench, the depth panel, the cue list, the lock tile.
- **Panel / Line / Line Strong** (panel, line, line-strong): the app's zinc-900, zinc-800 and zinc-700. Product fragments and the language dialog only.
- **Hair / Hair Strong** (hair, hair-strong): translucent white rules and borders for everything the landing itself draws: header bottom, section dividers, list separators, ghost button border, frame outlines.
- **Text** (text): headings and primary copy.
- **Muted** (muted): ledes, descriptions, nav links at rest, figure captions.
- **Faint** (faint): notes, timecodes, footer; the quietest text that still clears 4.5:1 on the ground.
- **Heading Dim** (heading-dim): the second clause of a heading only; 3:1 or better at display sizes.

### Named Rules
**The One Voice Rule.** Violet belongs to the action, focus, selection and the ambient light. It is never a heading color, a border, a badge or a section tint.

**The Borrowed Palette Rule.** Blue, emerald and red appear only inside a piece of the app (the replica, the export sheet, the depth fragments). If it is not something the editor would draw, it is zinc and violet.

**The One Kind of Line Rule.** Page and app draw with the same translucent hairlines: hair (7.5%) divides, hair-strong (13%) outlines something you can act on. No opaque zinc borders anywhere.

## Typography

**Display Font:** Madefor Display (with system-ui, sans-serif), variable 400 to 800, self-hosted, latin and latin-ext subsets.
**Body Font:** Madefor Text (with system-ui, sans-serif), variable 400 to 800, self-hosted.
**App Font:** Madefor Text at the app's sizes (`--font-app`, the editor's `font-sans`) for product fragments, key caps and timecodes.

**Character:** a neutral UI superfamily that sits beside the editor's interface without arguing with it; weight and tracking carry the authority, not a showy face.

### Hierarchy
- **Display** (700, clamp(2.75rem, 6.2vw, 4.5rem), 0.98, tracking -0.038em, max 16ch): the hero headline only.
- **Headline** (700, clamp(2.1rem, 4.4vw, 3.4rem), 1.05, tracking -0.028em, max 22ch): every section heading. The privacy and closing statements step it up (to clamp(2.3rem, 5.2vw, 4rem) and clamp(2.4rem, 5.6vw, 4.25rem)) because they stand alone without a picture.
- **Title** (650, 1.0625rem, 1.35, tracking -0.012em): point titles, spec terms, FAQ questions, figure caption names. Depth row terms step to 1.125rem and 1.375rem.
- **Lede** (400, clamp(1.0625rem, 1.3vw, 1.1875rem), 1.6, max 48ch, muted): the one sentence under each heading.
- **Body** (400, 1.0625rem, 1.65): base copy. Supporting copy (descriptions, dd, captions) runs at 0.9375 to 0.9875rem in muted.
- **Label** (650, 0.9875rem, tracking -0.01em, Display face): buttons.
- **App** (Madefor Text, 0.75 to 0.8125rem): everything inside a product fragment, at the app's own sizes.

### Named Rules
**The Two-Tone Heading Rule.** A heading is one sentence in two tones: the claim in text, its consequence in heading-dim, delivered as an `<em>` with `font-style: normal`. Emphasis is by value, never by italics or color.

**The Flat Tracking for CJK Rule.** Negative tracking applies to Latin scripts only; Japanese, Chinese and Korean headings run at 0, and Japanese breaks at phrase boundaries.

## Layout

One centered column (72rem) with a fluid gutter (clamp(1.25rem, 4vw, 3rem)); sections run edge to edge and pad themselves into the column, so a visual can bleed (the timeline strip in the cut section runs the full viewport width). Sections are separated by space alone: clamp(5.5rem, 11vw, 9.5rem) above each, no boxed bands. Copy measure is 62ch for long text, 44 to 52ch for ledes.

Section shapes vary on purpose: centered hero and statements (privacy, closing); heading-then-picture-then-three-points (cut); copy beside demo (captions, 0.9fr/1.1fr); a full-width bench of aspect ratios on a shared baseline (formats); one hairline-cut panel with wide rows and half cells (depth); a spec sheet of term/detail rows (spec, 1fr/2fr); heading left and sticky beside the question list (FAQ, 0.8fr/1.6fr).

Responsive behavior collapses grids to one column between 32rem and 56rem; the header hides its nav below 52rem; on phones the hero editor keeps its desktop proportions and runs off the right edge instead of shrinking. Primary action stays above the fold at 1440x900 and 390x844. Sticky header offset is 5rem scroll padding.

## Elevation & Depth

Mostly flat and tonal: the ground, one raised surface, and hairlines carry the structure. Shadows appear only under objects that are pictures of something (the editor, a video frame, the export sheet, an app panel), where they make the object sit on the page; they are deep, soft and black, never colored. The header is translucent ground with a 14px blur so the replica stays legible as it scrolls under.

### Shadow Vocabulary
- **Primary button lift** (`box-shadow: inset 0 1px 0 oklch(100% 0 0 / 0.18), 0 1px 2px oklch(0% 0 0 / 0.4)`): a top highlight and a contact shadow on the violet button only.
- **Hero editor** (`box-shadow: 0 0 0 1px oklch(0% 0 0 / 0.6), 0 2.5rem 6rem -1rem oklch(0% 0 0 / 0.7), 0 -1px 0 0 oklch(100% 0 0 / 0.12)`): the largest object, with an edge highlight on top.
- **Sheet** (`box-shadow: 0 0 0 1px oklch(0% 0 0 / 0.5), 0 2rem 4rem -1.5rem oklch(0% 0 0 / 0.85)`): the export dialog fragment.
- **Frame** (`box-shadow: 0 1.5rem 4rem -1.5rem oklch(0% 0 0 / 0.75)`): video stills.
- **App panel** (`box-shadow: 0 1rem 2.5rem -1.25rem oklch(0% 0 0 / 0.8)`): small inspector fragments.
- **Hairline ring** (`box-shadow: 0 0 0 1px var(--hair-strong)`): images that need an edge without a border box.

### Named Rules
**The Pictures Cast Shadows Rule.** Landing chrome (buttons aside, sections, lists, the raised bench) is flat; only depictions of the product or footage lift off the page.

## Shapes

Gently rounded and consistent: 0.375rem for chips, 0.5rem for inner pills and nav hit areas, 0.625rem for buttons and images, 0.75rem for the editor and the lock tile, 0.875rem for frames, the cue list and the sheet, 1rem for the largest raised panels. Radius grows with object size. Borders are 1px hairlines; separators between list items and cells are a single top or left hairline, never a box around each item. The section rule is a hairline that fades out at both ends. Key caps are the one exception with a heavier 2px bottom border, in the app's idiom.

## Components

### Buttons
Confident and compact, Display face at 650.
- **Shape:** gently rounded (0.625rem), min height 44px.
- **Primary:** violet-action fill, white label, top highlight shadow; trailing arrow icon on hero and closing.
- **Hover / Focus:** fill lifts to violet-action-hover in 0.18s on the expo-out curve (`cubic-bezier(0.16, 1, 0.3, 1)`); the arrow nudges 0.15em right; pressed sinks 1px; focus is the global 2px focus-violet outline.
- **Ghost:** 3% white fill with a hair-strong border, text color; hover raises fill to 7% and border to 22%.
- **Large:** hero and closing use 3rem height, 0.75rem x 1.4 to 1.5rem padding, 1.0625rem label. The header button shrinks to 2.25rem visible height and keeps a 44px hit area.

### Cards / Containers
- **Corner Style:** 1rem on the format bench and the depth panel; 0.875rem on the cue list.
- **Background:** raised, with an optional faint white radial light from the top (3.5%).
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px hair.
- **Internal Padding:** clamp(1.5rem, 3vw, 2.5rem); the depth panel is one container cut into rows and cells by hairlines, not separate cards.

### Navigation
- **Header:** sticky, 4rem (3.5rem on phones), three-column grid: wordmark left, links center, primary button right; bottom hair rule; translucent ground with blur. Links are muted, 0.9375rem, 0.5rem radius pill hit area, turning to text on hover. Below 52rem the links hide.
- **Footer:** one row on a top hair rule, faint 0.92rem text, links brightening to muted on hover, a language button that opens a panel-colored dialog listing the eight locales.

### Lists of facts
- **Spec rows and defaults:** term in Display 650, detail in muted 0.9375rem, side by side (1fr/2fr) on a top hairline per row, closing hairline at the bottom; stacked below 36rem.
- **Points and claims:** three columns separated by left hairlines; stacked with top hairlines on narrow screens.

### FAQ
Native `details`; question in Display 650 at 1.0625rem with a plus icon that rotates 45 degrees when open; answer in muted at 62ch, fading down 0.35rem on open; hairline between items.

### Key caps
Inline `kbd` in the app face: zinc-800 fill, hair-strong border with a 2px bottom edge, 5px radius, used wherever copy names a shortcut.

### Editor replica (signature)
A fixed-width (64em) replica of the desktop editor built from the app's tokens, dictionaries and icon sprite, scaled by one font-size knob. Menu bar, toolbar with the violet Export button, media panel, monitor, inspector, and a timeline with blue video, violet text and emerald audio clips under a red playhead. It loops on one 12s clock: the playhead sweeps and the monitor cuts to whichever real shot it is over. A cropped "split" variant shows a split and a trim snapping to the playhead. In the hero it rests tilted back (rotateX 16deg, scale 0.95) and lays itself flat on scroll; its bottom dissolves into the page with a mask. Under reduced motion it is a still with the playhead parked inside a clip.

### Product fragments
The export sheet, the Adjust/curves panel, keyframe lanes, mask strip and transition picker are smaller pieces of the app drawn the same way: panel fill, hairline borders, 0.625 to 0.875rem radius, app face at 0.6875 to 0.8125rem, blue for what is picked, uppercase 0.04em-tracked section heads in zinc-400 as the app's inspector does. Captions are burnt into the frame as the app's text clip renders them (white bold Display on a 72% black rounded box), with the cue list beside them on the same clock.

## Do's and Don'ts

### Do:
- **Do** split every section heading into a claim and its consequence, with the second clause in heading-dim via a normal-style `<em>`.
- **Do** draw every landing border and separator with the translucent hair (7.5%) or hair-strong (13%) whites.
- **Do** prove a capability with a fragment of the app built from its tokens and its own localized labels, not with an illustration or a screenshot of UI.
- **Do** keep violet to the primary action, focus, selection and the hero and closing light.
- **Do** keep every motion behind `prefers-reduced-motion: no-preference` and make the still state read correctly.
- **Do** keep touch targets at 44px, even where the visible control is smaller.
- **Do** keep tracking at 0 for CJK headings.

### Don't:
- **Don't** use blue, emerald or red outside a depiction of the app.
- **Don't** build card grids, decorative gradients or dashboard-style tiles; group facts with hairlines and space.
- **Don't** float neon pills or pulsing dots over a preview; burn the caption into the frame the way the editor does.
- **Don't** use italics or a new color for emphasis inside headings.
- **Don't** use em dashes in copy, titles or UI strings; use a colon, a middle dot or a hyphen.
- **Don't** add developer-oriented touches (console messages, DevTools references) to the page.
- **Don't** put shadows on landing chrome; only pictures of the product or footage lift.
