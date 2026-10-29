# Granola 7.668.0: the generating animations → Cereal

This pass covers how Granola animates generation:
- the "swirl" mark it shows while the agent is thinking
- enhanced notes being written
- streamed chat text

It complements the Motion section of [granola-ui.md](granola-ui.md#motion). As with that doc, nothing here is Granola source, CSS, SVG path data, colours or assets. The doc records values (durations, easings, offsets, ordering) and techniques, and Cereal implements its own versions.

## Provenance

- **Artifact:** `~/re/granola/7.668.0/asar`, the extracted `app.asar` of the Windows build. Directory sha256 is `a908cf9e…6b`.
- **REA Evidence:** `analyze_javascript_application` (summary), parent `ev_a9527c2ca4d41545a1650ec0f94b9f7674c92e059187ea46dc7f45b1860d6cdb`. It ran over the chunks `useCombinedRef-_wP7rFTM.js`, `BriefContent-DVVwGUMT.js`, `namespace-e0oY6aTz.js` and `primary-CUZSZ_4J.js`.
  - The bundle is exported to `~/re/granola/evidence/granola-7.668.0-motion-evidence.json`.
  - The analyzer's heap ran out on `primary-*.js` (5 MB). Semantic coverage of that chunk is partial, so the enhanced-notes values below were read from the chunk text directly.
- **Read directly, as inert text** (never executed):
  - `index-BAP8dYrU.css`: global keyframes and `--animate-*` tokens
  - `PortraitPage-Sx0TUkP-.css`: the editor CSS module `_axfjk`
  - `primary-*.js`: the enhanced-notes pane
  - `PortraitPage-D7ruWljI.js`: the chat message and outputs
- **Marks:** **[O]** means observed in shipped bytes; **[I]** means inferred.

## The swirl (thinking mark)

- **[O] Shape:**
  - One spiral `<path>` with `pathLength=1`, `stroke-width` 172 in a 1000×1004 viewBox, and round caps and joins.
  - A `<mask>` clips it to the logo silhouette, so the stroke only ever shows inside the logo.
- **[O] Loop (`animate-logoStrokeLoop`):**
  - **Dash pattern:** `stroke-dasharray: 1 0.75`, a dash as long as the whole path followed by a gap of 0.75, so the period is 1.75. `stroke-dashoffset` runs over `var(--logo-loop-duration, 3.2s)` linear, infinitely.
  - **Phases:**
    - 0–15%: holds at 0, fully drawn
    - 15–47.5%: ramps to 1.08. The stroke unwinds from its start while the next dash enters from the end, leaving about the last third.
    - 47.5–50%: holds
    - 50–80%: ramps to 1.75, redrawing back to full
    - 80–100%: holds
  - **Seamless:** 1.75 is one whole period, so the loop doesn't jump.
- **[O] Echo layers (`logoStrokeLoopRainbow1…5`):**
  - **Layers:** five more copies of the path sit under the ink stroke. Each is `blur-2xl` in a pastel (green, yellow, blue, purple, pink).
  - **Curves:** they follow the same offsets on progressively stronger easing, baked as 2.5% keyframe samples. While the stroke unwinds they lag it, as an ease-in. While it redraws they lead it, as an ease-out; the fifth overshoots to 1.79 before settling.
  - **Result:** a soft chromatic trail behind the moving ends.
- **[O] Intro variant** (non-looping, on welcome, update and empty screens):
  - **Dash pattern:** `stroke-dasharray: 1 1`, with the offset going 1→2 over 1.5s `cubic-bezier(.16,1,.3,1)`, so the stroke draws itself once.
  - **Layers:** the colour layers are staggered 5% apart and fade out over the last 10%, leaving the ink.
- **[O] Thinking indicator:**
  - **Layout:** a 16px swirl (loop) and a label.
  - **Placeholder:** an invisible copy of the text, or "Thinking...", reserves the label's size.
  - **Status text:** when there is a status, it shows as `shimmer-text` (5s ease-in-out sweep, 250% background, ink at 20%→100%→20%).
  - **Swap:** it changes through `AnimatePresence mode="wait"`: in 0.4s easeOut, out 0.15s.
  - **Placement:** chat shows it while loading and before any output.
- **[O] Blur units:** the blur is applied to SVG children, so it is in user units (about 4% of the box). At 16px it is a faint halo; at 48px it is a visible glow.

## Enhanced notes being written

Granola renders the stream in a read-only document pane above the real editor while the panel is loading.

- **[O] Blocks blur in:** every paragraph and heading node is a `motion` element.
  - **Mount:** `opacity 0, filter blur(2px)` → `opacity 1, blur(0px)`.
  - **Exit:** `opacity 0, height 0, blur(2px)`.
  - **Transition:** 0.2s with ease `[.22, 1, .36, 1]`.
  - **Effect:** only newly streamed blocks animate.
- **[O] Height:** the stream sits in a box whose `height` is a motion value springing to the content's `offsetHeight`, read by a ResizeObserver.
  - **Spring:** `visualDuration .7, bounce 0`.
  - **Clip:** `overflow-y: clip` on the box.
  - **Reduced motion:** the height jumps instead.
  - **Result:** the column eases open instead of jumping a line at a time.
- **[O] Status card** (`data-slot="enhance-note-card"`):
  - **Look:** `h-10`, pill-shaped, `bg-surface-elevated`, with a bottom-bar shadow, a 0.5px hairline ring and `text-sm font-medium`. It is as wide as the chat bar (`min(100% − 1.5rem, 41.5rem)`).
  - **Spinner:** a 16px CSS spinner.
  - **Messages:**
    - "Analyzing transcript", or "Analyzing transcript and images" when the note has attachments
    - "Enhancing notes" once text arrives and the user's notes exceed 20 characters, otherwise "Writing notes"
  - **Enter:** `opacity 0, scale .96, blur(2px)` over 0.25s `[.22,1,.36,1]`.
  - **Position:** it sits in flow right after the stream. A per-frame check compares its slot with a fixed line 14px above the chat bar. While the slot is below that line, the card is `position: fixed` there and clicking it scrolls to the bottom.
- **[O] The user's notes, sweeping grey:**
  - **Placement:** below the card, the user's own notes render flat, read-only, with `grayscale-text-pulse`.
  - **Sweep property:** `@property --grayscale-text-pos` (`<percentage>`, inherits) animates 100%→0% over 2.2s linear, infinitely.
  - **Gradient:** the text is `background-clip: text` over a 320%-wide gradient that is ink-primary except for an ink-secondary band at 46–54%. This draws a soft grey band left to right through each line.
  - **Stagger:** each heading or paragraph gets `animation-delay: index × 140ms`, so the band runs diagonally down the notes.
  - **Inline marks:** strong, em, code and links repeat the gradient.
  - **Heading marker:** `::before` stays tertiary.
  - **Reduced motion:** it is all removed.
- **[O] On finish, the notes fold up into the new notes:**
  - **Slide:** the notes pane, measured at height `h` (capped at the window height), animates `y → −h`.
  - **Fade and blur:** opacity `[1, 1, 0]` and `filter [blur 0, blur 0, blur(8px)]`, with times `[0, .5, 1]`.
  - **Timing:** duration `1.3 + min(1, h / innerHeight) × 1.7` s, ease easeInExpo `2^(10t − 10)` and delay 1s.
  - **Clip:** the wrapper is clipped with `clip-path: inset(-2rem -100vmax 0)`. Only what falls below the wrapper is cut, so the notes visibly rise into the enhanced notes above.
  - **Collapse:** the wrapper's height then animates to 0 over 0.5s easeInOut, and it unmounts.
  - **Reduced motion, or zero height:** it unmounts at once.
- **[O] Leftover empty line:** after generation, an empty first paragraph left by the collaborative doc collapses: `height 1lh → 0, opacity 0` over 0.4s expo-out, 400ms after completion. The heading below drops its top margin in step. This is Yjs-specific; Cereal has no equivalent.

## Streamed chat text

- **[O] No text reveal:** assistant text in chat re-renders as Markdown on each chunk. There is no per-token, per-word or per-block animation and no requestAnimationFrame smoothing.
  - This is a bounded negative over the chat message, outputs and markdown chunks named above.
- **[O] Motion around the text:**
  - **Tool and thought groups enter** with `chat-tool-swap-in`: `opacity 0, blur 2px, y 8px` → rest over 0.2s.
  - **They leave** with `opacity 0, blur 2px, y −8px` over 0.2s, 600ms after the turn ends.
  - **Height:** the group's height eases over 0.5s `[.22,1,.36,1]`.
  - **Live rows:** "Thought for Ns" and running tool rows wear `shimmer-text`.
- **[O] Briefs:**
  - **Live status:** the meeting-brief header's status uses a rainbow `gradient-text` sweep. Its background is 500% wide, run over 2.4s `(.4,0,.2,1)`, infinitely.
  - **Citations:** citation links that arrive while streaming sweep once (`gradient-text-slide` 0.6s), staggered by an inline delay.
- **[O] Unused CSS:** `generating-muted-wave-letter` (letter-by-letter colour drift and bob) is still in the CSS, but no JavaScript in 7.668.0 references it.

## Cereal's versions

| Granola | Cereal | Where |
| --- | --- | --- |
| Logo-masked spiral swirl, 5 pastel echoes | **LoopMark**: the three cereal rings from the app icon, each one pen stroke drawn clockwise from the top. They use the same dash loop (3.2s), rippled ring to ring by 0.14s, with 3 blurred echoes in the icon's blues on our own cubic-bezier curves: ease-in while unwinding, ease-out (the last one overshooting) while redrawing. | `components/oats/LoopMark.tsx`, `styles.css` (`loop-ring`, `loop-echo-*`) |
| Thinking indicator | `ThinkingIndicator`: LoopMark plus shimmering status text, cross-fading. It shows in chat before the first output, and as "Working…" in the Assistant. The transcript's "Listening" keeps the jumping dots. | `components/Chat.tsx` |
| Streamed blocks blur in | `Markdown reveal="blur-in"`, used for the enhanced-notes stream. Our own addition: live chat answers too. | `components/Markdown.tsx` |
| Spring-height stream box | `GrowHeight` | `components/oats/Motion.tsx` |
| Status card | `EnhanceStatus`: the same card with LoopMark in place of the spinner. It uses CSS `position: sticky` above the chat bar (`--floating-chat-h`, published by the floating chat) instead of a per-frame check. Clicking it scrolls the writing point into view. With no transcript it says "Reading your notes". | `views/note/EnhancedView.tsx`, `components/FloatingChat.tsx` |
| Grey sweep through the user's notes | `Markdown reveal="pulse"` and `.grayscale-text-pulse`, with the same values | `components/Markdown.tsx`, `styles.css` |
| Fold-up on finish | `FoldAway`, with the same timings. It only folds when generation succeeds; on failure it removes the notes at once. | `components/oats/Motion.tsx`, `src/shared/motion.ts` |

**Reduced motion:**
- the rings rest fully drawn, without echoes
- there is no sweep
- the height jumps
- the notes disappear at once

The e2e smoke test checks that the status pill and the notes echo appear, then detach after finishing.
