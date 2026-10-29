# Granola 7.663.2: UI, UX and motion spec → Cereal

This is the second reverse-engineering pass over Granola's renderer. The first pass ([granola-findings.md §10](granola-findings.md#10-visual-design-system)) took the colour tokens, type scale and button shapes. This pass covers the rest of the interface:
- the design-system primitives
- the app shell (sidebar, toolbar, command palette)
- every main page
- the floating widget ("nub")
- the motion: keyframes, transition timings and spring configurations

Nothing here is Granola source code, CSS, fonts, icons, images or shaders. The spec records observed **values** (colours, sizes, durations, easing curves, layout and behaviour), and Cereal reimplements them in its own code.

## Provenance

- **REA evidence:** `analyze_javascript_application` over the extracted `app.asar` (`~/re/granola/7.663.2/asar`, directory sha256 `c063e811…`), with the UI chunks selected. The parent Evidence is `ev_1e8338e0a761a6c7c2bdae2b874f5e64b33ba6692d0b62fa08a2858c837517ce`, exported to `~/re/granola/evidence/granola-7.663.2-ui-evidence.json`.
- **How the chunks were read:** each renderer chunk was parsed with the TypeScript printer, as inert text and never executed, and its class strings and `motion` props were read. The chunks were:
  - `primary-*`, `PortraitPage-*`
  - `Toolbar-*`, `nub-*`
  - `Button-*`, `Menu-*`, `Select-*`, `Tooltip-*`, `Dialog-*`, `Popover-*`, `Switch-*`, `Checkbox-*`, `Input-*`, `Textarea-*`, `Badge-*`, `Avatar-*`, `IconButton-*`, `Spinner-*`
  - `TranscribeIcon-*`, `RandomAudioVisualizer-*`, `Transcript.module-*`, `NubTranscriptBubble-*`, `SettingsLayout-*`
  - `index-*.css`
- **Marks:** **[O]** means observed in shipped bytes and **[I]** means inferred. Where Granola's behaviour depends on experiment flags, the default branch is described.

## Stack

- **[O] Styling and primitives:** Tailwind v4, plus **Base UI** (`useRenderElement` and the `data-popup-open`, `data-starting-style` and `data-ending-style` attributes) for menus, selects, tooltips, popovers, dialogs, switches and checkboxes.
- **[O] Motion:** **motion** (framer-motion), using `AnimatePresence` and `motion.div`, layout animations and springs.
- **[O] Toasts:** **sonner**, unstyled, with Granola's own classes.
- **[O] Variants:** class variants are built with tailwind-variants and merged with tailwind-merge.

Cereal uses the same open-source libraries: `@base-ui/react`, `motion`, `sonner` and `tailwind-merge`. Its primitives are in `src/renderer/src/components/oats/`.

## Tokens

These extend §10 of the findings doc.

- **[O] Semantic tokens:** the names are `--oats-{surface,ink,fill}-*`, plus `--oats-border-hairline` and `--oats-border-focus`, each with a `html.dark` override. Cereal uses the same names; the accent family stays navy.
  - **Surfaces:** surface `#f7f7f2` / `#292929`; sunken `#f2f2ec` / `#212121`; elevated `#fff` / `#363635`; raised `#fff` / `#313130`; tooltip `#363635`.
  - **Ink:** primary `#292929` / `#fcfcf8`; secondary-strong `#4e4d4b` / `#acada8`; secondary `#72726e` / `#9e9e99`; tertiary `#acada8` / `#818179`.
  - **Fills:**
    - primary `#292929` (hover `#4e4d4b`), or `#eaebe5` (hover `#acada8`) in dark mode
    - highlight `#625a220f` / `#ffffff0f`, and highlight-strong `#56512e1f` / `#ffffff26`
    - soft: the same values as highlight; soft-opaque `#eaebe5` / `#363635`
    - disabled `#d5d5d2` / `#4e4d4b`; neutral `#acada8` / `#72726e`
    - danger `#e95d3d` (hover `#bd4a30`)
  - **Hairline:** `#47432a33` / `#ffffff26`. This is also the **default border colour for every element**.
- **[O] Type:**
  - **Sizes:** xs 12/16 (+0.02em), sm 13/16 (+0.01em), base 14/18 (+0.01em), lg 16/20, 2xs 11, editor 15 or 16.
  - **Display:** `text-h1` 36/40 (−0.01em), `text-h2` 28/32, `text-h3` 24/28, `text-lg-slab` 16/24, all in the display serif at weight 400.
  - **Weight:** "book" is 430.
- **[O] Focus ring:** a 1.5px outline in the focus colour, offset 1px (`ring-focus-ring`) or −1.5px (`-inset`). A row shows the ring when a child marked `data-focus-ring-target` has keyboard focus.
- **[O] Icons:** a 24-unit viewBox drawn at 16px, with an **absolute 1.25px stroke** (`--icon-stroke-width = 24/size × 1.25`). Cereal keeps lucide and gets the same stroke from `vector-effect: non-scaling-stroke`.

## Motion

- **[O] Easing:**
  - The default transition is 150 ms `cubic-bezier(.4,0,.2,1)`.
  - `--ease-out-expo` is `cubic-bezier(.16,1,.3,1)`.
  - The animations below use the timings in their own entries.
- **[O] Keyframes in use:**

| Name | Use | Timing |
| --- | --- | --- |
| slideUpAndFade / slideDownAndFade | popovers | 0.3s expo, 2px / −3px |
| fade-in | page blocks | 0.3s ease-out, y 10px |
| chip-enter | chips, citations | 240ms ease-out, scale 0.95 |
| chat-tool-swap-in | chat tool cards | 0.2s ease-out, blur 2px, y 8px |
| workflowOutcomeIn | results | 0.3s (.22,1,.36,1) after 0.15s, blur 2px, y 4px |
| oats-jumping-dots | "thinking" dots | 1s, y −2px, opacity 0.3↔1 |
| sparklesIconSlow | sparkle icons | 2.25s, staggered 0.1/0.2/0.3s |
| chromaColorMuted + chromaGeneratingLetterWave | "generating" text, per letter (unreferenced by JS in 7.668.0; Cereal dropped it) | 4s colour drift + 2.5s, y −1.25px |
| chromaGenerateIdleSweepLoop | Generate notes label on hover | 2.2s pastel gradient sweep |
| nudge | nub prompt | 5.5s after a 5s delay, ±3px shakes |
| blink | text caret | 1.4s |
| shimmer | "Thinking…" text | 5s |
| follow-ups-check-pop | checkmarks | 0.35s (.34,1.56,.64,1) |

- **Generating animations:** the thinking swirl, enhanced notes being written and streamed chat text are covered in [granola-motion.md](granola-motion.md).
- **[O] Common `motion` transitions:**
  - `{duration:.2, ease:'easeInOut'}`
  - `{duration:.1}`
  - `{duration:.15, ease:'easeOut'}`
  - spring `{stiffness:300, damping:30}`
  - spring `{bounce:0, duration:.1/.15/.25/.3}`

## Primitives

- **[O] Button:**
  - **Base:** `inline-flex rounded-full font-book cursor-default select-none`, with **no colour transition**: hover switches instantly.
  - **Sizes:** xs `py-1 px-1.5 text-xs`; sm `py-1 px-2.5 text-xs`; md `h-7 px-3 text-sm`; lg `py-[9px] px-4 text-base`.
  - **Variants:** primary, accent, accent-soft, accent-outline, soft, soft-opaque, surface, outline, danger, danger-outline, ghost.
  - **Busy:** a 12px spinner with a 1.5px border.
  - **IconButton:** a square button at 16/24/28/36px.
- **[O] MorphButton:** a `motion.button` with `layout`, using a spring with bounce 0.15 over 0.25s. Its content is keyed by `contentKey` inside `AnimatePresence mode="popLayout"`, and swaps with a blur(3px) and opacity cross-fade over 0.15s ease-out. Granola uses it for the Generate, Resume and Start pills.
- **[O] NestedButton:** a split pill. Each Action has `p-[2px]` and rounded outer ends; each Inner is `h-6 px-2 rounded-full` and highlights on hover by itself.
- **[O] Menu:**
  - **Popup:** `min-w-[220px] max-w-sm rounded-xl p-1 bg-surface-elevated shadow-lg ring-[0.5px] ring-hairline`, with `origin-(--transform-origin)`. It enters and exits with scale 0.95 and opacity over 75 ms.
  - **Item:** `gap-2 rounded-lg px-2 py-1.5 text-sm`, highlighted with off-black at 6%.
  - **Separator:** a 0.5px hairline with `mx-2 my-1`.
  - **Group label:** `px-2 pt-1.5 pb-1 text-xs`.
  - **Placement:** aligned to the start of the trigger, 4px below it.
- **[O] Select:** the trigger is `rounded-lg px-2.5 ring-inset`. The popup matches the menu, with no animation, and is at least `max(180px, anchor+4px)` wide.
- **[O] Tooltip:**
  - **Look:** `bg-surface-tooltip text-[#fcfcf8] rounded-lg px-2 py-1 text-xs`.
  - **Placement:** below the trigger with a 6px offset.
  - **Motion:** scale 0.95 over 75 ms; hovering the popup does not keep it open.
  - **Shortcut hints:** keyboard hints are shown inline in secondary-strong-inverse ink.
  - **Delay:** 600 ms by default, 300 ms or 0 for toolbar and sidebar actions.
- **[O] Dialog:**
  - **Backdrop:** `neutral-600/40`, or `black/60` in dark mode, fading over 75 ms.
  - **Card:** centred, `rounded-2xl bg-surface p-4 shadow-xl ring-hairline sm:max-w-sm`, scaling from 0.95 over 75 ms.
  - **Title:** `text-lg font-medium`.
  - **Footer:** `-mx-4 -mb-4 p-4`, with its buttons aligned right.
- **[O] Popover:** like the menu popup, with `p-3`.
- **[O] Switch:** `h-5 w-8`. The thumb is 16px and moves 14px over 100 ms. The track is `fill-neutral` and turns `fill-accent` when on.
- **[O] Checkbox:** 14, 16 or 20px with radius 4, 5 or 6; checked uses `fill-primary`.
- **[O] Input and Textarea:** `rounded-md px-2.5 ring ring-hairline ring-inset bg-surface-elevated`, with a 1px accent ring on focus. Heights are 28, 36 or 44px.
- **[O] Badge:** `rounded-full`, either `px-1.5 text-2xs` or `px-2 py-0.5 text-xs`, on tinted backgrounds.
- **[O] Avatar:** a display-serif uppercase initial at 0.55 × the size, on a tinted pastel background, with an inset hairline ring.
- **[O] Toast (sonner):**
  - **Look:** `bg-surface-elevated ring-0.5 ring-hairline text-sm gap-1.5 p-3 rounded-lg max-w-sm shadow-sm`.
  - **Icons:** 20px; warning in amber and error in rose.
  - **Action:** a `bg-highlight h-7 px-2 rounded-lg` button.
  - **Close:** a close button is shown.

## Dancing bars

- **[O] Shape:** three rounded bars, each 16×3px, inside a 13×10px box with 2px gaps and overflow hidden. A mirrored copy (`scaleY(-1)`) sits below it, so each bar reads as a capsule growing from the middle.
- **[O] Movement:** each update sets a bar's `translateY` to `10 − min(floor(n·level/r) + 1.5, n)`, where:
  - `r = (rand·0.4 + 0.6) × weight`
  - the weight is 2 for the outer bars and 1 for the middle bar
  - `n` is 10, or 7 in the nub
  
  The transform transitions over 300 ms ease-in-out.
- **[O] Gain:** RMS levels arrive every 100 ms and are normalised against a fast-decaying peak: `peak = max(200/32767, peak·0.27, x)`, then `level = x / peak`.
- **Noise gate (Cereal):** Granola's fixed floor assumes a quiet capture; a raw PipeWire microphone hisses at RMS 0.015–0.025, which the fast-decaying peak turns into full volume, so the bars danced through silence. Cereal first subtracts twice the quietest level of the last 3s (`src/shared/barLevels.ts`) and skips the first second of a capture, so the bars rest as dots (8.5px) until someone speaks, as Granola's do.
- **[O] Silence:** after 3s of no audio at all, the bars turn red (`#BD4A30`).
- **[O] WebGL renderer:** live bars are drawn on a canvas laid over the bar boxes, twice the box height. Cereal's version is `components/oats/barsRenderer.ts`; the DOM bars stay in place, invisible, as the measuring template and the fallback.
  - **Shape:** each bar is a capsule, antialiased over one device pixel. The lower half mirrors the upper half about the centre line.
  - **Motion:** each new offset animates over 0.3s with `cubic-bezier(0.4, 0, 0.2, 1)`, starting from the bar's current position. Turning back toward where a running move began shortens the move, as CSS transitions do.
  - **Motion blur:** what a bar swept through since 1/60s earlier is drawn with partial coverage. Cereal box-filters six samples along that travel.
  - **Frames:** requestAnimationFrame at most 60 fps, only while a bar is moving, and not while the document is hidden.
  - **Colour:** read from a DOM bar's computed `--barcolor` (so theme and silence-red changes apply), via a 1×1 canvas.
  - **Fallback:** when WebGL fails (including software-only GL) or the context is lost, the DOM bars animate instead. Idle glyphs are always DOM, so they hold no GL context.

## Shell

- **[O] Window:** frameless. The 44px toolbar is the drag area, and the window controls sit at its right end; Granola leaves 138px for them on Windows. Cereal uses `titleBarStyle:'hidden'` with `titleBarOverlay` and sizes the spacer from `env(titlebar-area-*)`, because on GNOME the overlay shows only the close button.
- **[O] Toolbar:**
  - **Position:** the header floats over the page, which scrolls under a blurred fade (`from-surface 70%`, `blur-md`).
  - **Left cluster:** follows the visible sidebar width, with a 200 ms width transition only on a manual toggle. It holds the sidebar toggle ("Close sidebar ⌘S") and Search ("⌘K"): a 32px hit area around a 28px hover circle.
  - **Page actions:** pages render their own controls into a portal slot.
  - **Settings:** the title "Settings" is centred.
- **[O] Sidebar frame:**
  - **Look:** sunken surface with a right hairline.
  - **Width:** **192–330px**, resized with a 7px handle whose hover shows a 1px accent line. The width is saved with a 300 ms debounce.
  - **Collapse:** the width transitions over 200 ms ease-out, but only when toggled by hand.
  - **Narrow window (under 768px):** a floating panel, `top-1 bottom-1 left-1 rounded-[13px] shadow-2xl`, slides in over 150 ms ease-out over a `black/30` scrim that fades in over 0.28s.
  - **Keys:** Esc closes it; ⌘S toggles it.
  - **Note pages:** the sidebar **closes itself on note pages** and restores the user's choice when they leave one.
- **[O] Sidebar contents:**
  - **Navigation:** Home, then Assistant (with a hover action "Open chat"), then Chat.
  - **"My notes":** a section of folders.
  - **Footer:** a row of 28px icon links (Recipes and more), then a hairline, then an account or workspace button (`h-9 rounded-lg rounded-bl-xl`) that opens a menu upwards.
  - **Item:** `my-px h-7 rounded-lg px-1 gap-1.5 text-sm text-ink-secondary-strong`. Active is `fill-highlight`; hover is off-black at 6%. The icon slot is 20px.
  - **Hover actions and metadata:** actions fade in on hover, and metadata such as counts fade out at the same time.
- **[O] Command palette:**
  - **Scrim:** `black/10`.
  - **Panel:** `mt-[25vh] max-w-lg rounded-xl shadow-xl`.
  - **Input:** `h-12`.
  - **List:** `max-h-85 p-2`.
  - **Group labels:** `h-8 text-xs font-medium`.
  - **Items:** `min-h-9 gap-3 rounded-lg px-2 py-2`, each with a 20px icon cell.

## Pages

- **[O] Home:**
  - **Toolbar:** an outline "New note" button with an icon (`pr-3 pl-1.5`).
  - **Content:** a `max-w-2xl px-6` column.
  - **"Coming up":**
    - **Header:** `text-h3`, with a settings button that shows on hover and a "Today" ghost button.
    - **Card:** a hairline-ringed rounded-2xl card with dashed separators.
    - **Event rows:** a 36px icon tile, the title, and "attendees · time".
  - **Notes:** grouped by day under `pt-6 pb-1 text-xs font-medium` headers.
  - **Note row:** `rounded-xl py-[5px] px-2 hover:bg-highlight-faint`, with a 28px tile, a `text-base` title and a `text-xs` subtitle. A "…" button appears on hover.
  - **Chat bar:** a floating chat bar sits at the bottom.
- **[O] Note** (default layout, the same in 7.663.2 and 7.668.0; an earlier pass described the `transcript_tab` flag variant, which is off by default):
  - **Title:** `text-h3` (the default "small" title size), in `px-4 pt-3` → `max-w-2xl px-1`.
  - **Options row**, directly under the title (`mt-2`, `scrollbar-hide flex min-w-0 flex-nowrap items-start gap-2 overflow-x-auto py-1 text-sm text-ink-secondary`): left-aligned, scrolling sideways when narrow.
    - Granola's order: the notes toggle (only once enhanced notes exist), date and attendees, "In Trash", folder.
    - Cereal's: the My notes / Enhanced tabs (only once a panel exists), then date, mode, folder and template. The chips are hairline-bordered `h-7` pills.
  - **Scroll area:** a sticky top fade once the page scrolls.
  - **Bottom bar** (`bottom-4`, `max-w-[min(100cqw-16px,43rem)]`): one row, `flex w-full flex-wrap items-end justify-center gap-2`, holding the recording widget and then the chat input (`min-w-0 grow basis-3/5`, "Ask anything"). Generate notes sits centred above it in the chrome zone.
    - **Chat open:** the widget hides, and the chat panel grows above the input in one `rounded-[32px]` card.
    - **Transcript open:** the input hides (it stays mounted, keeping its draft), the widget spans the card, and the transcript panel grows above it.
    - **Panel:** 400px by default, at least 160px, at most the page height under the toolbar. It is resizable from an `h-4 w-48` handle whose bar shows on hover, and the height is remembered (`cereal.floatingChatHeight`). It opens on a 0.2s spring with bounce 0.2 and closes with bounce 0; it doesn't animate while resizing.
    - **Closing:** an outside mouse-down, Escape, or the control that opened it.
- **[O] Note tabs (My notes / Enhanced):** there is no Transcript tab by default.
  - **Control:** a sunken pill, `h-8`, with a raised thumb (`h-[28px]`, border `#D2CFC6`) that slides over **325 ms ease-out-expo**.
  - **Inactive tabs** collapse to their icon.
  - **Active tab:** its label expands. The width animates over 260 ms; the opacity animates over 200 ms after a 40 ms delay, and in 48 ms when collapsing.
  - **Enhanced tab:** its chevron opens a menu.
- **[O] Recording widget** (`views/note/RecordingWidget.tsx`): `rounded-[28px] bg-surface-elevated shadow-bottom-bar ring-0.5 ring-hairline` (no ring or shadow when merged into the open card), inner `flex h-14 items-center p-1`. There is no pause and no menu: Stop, then Resume, is the pause.
  - **Main segment** (`min-w-[48px]`, hover shape `rounded-l-3xl rounded-r-lg`): a spinner while starting, live dancing bars while recording, the static bars glyph once there is a transcript, otherwise a mic. A chevron points up and turns 180° over 200 ms while the transcript is open.
    - Its tooltip and test id are "Show transcript" / "Hide transcript" (`show-transcript-button` / `hide-transcript-button`).
    - Clicking it toggles the transcript. Mouse-down is prevented, so the editor keeps focus.
  - **Trailing segment** (mirrored hover shape): Stop while recording (`stop-transcript-button`; it also closes the transcript), "Resume" when a transcript exists, otherwise "Start now" (accent ink).
- **[O] Generate or Enhance notes:**
  - **Look:** an accent `lg` MorphButton with a sparkle icon.
  - **Label:** "Enhance notes" if the notes are over 20 characters, otherwise "Generate notes".
  - **Hover:** a pastel colour sweep runs through the label.
  - **Entrance:** it enters the bottom chrome zone (below).
- **[O] Chrome zones:** an item's slot grows from height 0 to auto while the content rises from y 100% (or 8px at the top) and scales from 0.9. Height, y and scale use springs with bounce 0 over 0.3s; opacity takes 0.15s. The "fade" variant uses y 8px and scale 0.98.
- **[O] Transcript** (the bottom-bar panel, `views/note/TranscriptPanel.tsx` + `TranscriptView.tsx`):
  - **Header:** `flex h-12 items-center justify-between border-b px-3`, with no title. The border stays transparent until the list scrolls.
    - **Left, "Find in transcript" (Ctrl+F):** an icon that widens into a "Find" field, 28→220px over 0.1s. It shows an `n/m` count with previous and next, or "No results". Enter and Shift+Enter step through matches, which are marked in the bubbles. Escape closes Find before the panel.
    - **Right:** "Copy transcript" (the icon becomes a check for 3s) and "Close transcript".
  - **List:**
    - **First row:** a consent note.
    - **Bubbles:** one per group, `rounded-lg px-2 py-1.5 text-sm leading-snug`. The microphone is on the right in the accent tint (`pl-16`); the other side is on the left in neutral-150 (`pr-16`). There are no You/Them labels.
    - **Corners:** consecutive bubbles from one side get tighter inner corners.
    - **Bubble grouping:** consecutive chunks from one source share a bubble until a chunk ends with a full stop (`groupChunks` in `src/shared/transcript.ts`). Each chunk is an inline span (`data-chunk-id`), so live speech grows one bubble.
  - **Interim text:** inline at 50% opacity. While transcribing, a bubble with interim text ends in the jumping dots (`ml-1`, 250 ms stagger).
  - **Empty states:** "Transcript on…" while recording, "Transcript starting…", otherwise "Transcript paused".
  - **Following:** the view follows new text while within 48px of the bottom, by setting the scroller's `scrollTop` (never `scrollIntoView`). Scrolling further up stops following.
  - **Scroll to latest:** a pill, `h-8 w-12 rounded-full bg-neutral-50/80 backdrop-blur-lg shadow-lg`, fades up 8px over 0.1s. It sits in a zero-height sticky slot, so showing it never changes the content height, and jumps straight to the bottom.
  - **Jump to a chunk:** a Transcript Summary quote opens the panel, puts the chunk a third of the way down, and flashes it for 2s.
- **[O] Enhanced notes:** an editor like My notes, not a rendered view.
  - **Grey lines:** lines the AI wrote are grey (`data-generated`, a 0.1s colour transition); an edited line turns black. See [granola-findings.md §6](granola-findings.md#6-enhance-notes-summary-generation).
  - **While generating:** the stream shows read-only, without its unfinished last line.
- **[O] Transcript Summary:** hovering a paragraph of the enhanced notes (not a heading) shows a small button at the right end of its row.
  - **Popover:** aligned to the end, 5px offset, `max-w-xs sm:max-w-sm lg:max-w-lg`, at most 28rem tall.
  - **Header:** "Transcript Summary", `text-xs font-semibold tracking-wide uppercase text-ink-secondary`.
  - **Body:** three skeleton lines, then the streamed sentences (`text-base leading-relaxed`) with quote cards between them. A card has a 1px accent bar, the quote, and "Speaker • time".
  - **Footer:** a note when the meeting is still being transcribed.
- **[O] Chat:** the chat bar has its own spec, [granola-chat-bar.md](granola-chat-bar.md) (Granola 7.668.0). It covers the composer, menus, chips, files, model picker, dictation, the floating panel, the docked sidebar and the Chat page. The points below are from the first pass.
  - **Input:** `rounded-[20px]`. At rest it has a 0.5px hairline shadow plus a soft drop shadow; when focused, an accent border with a 3px accent/20 ring. It is at least 47px tall.
  - **Floating panel:** a 320px card on the right, `rounded-[20px] bg-surface-elevated ring-0.5 shadow-lg`. It **docks** at 384px, without the shadow, when the page is at least 64rem wide.
  - **Full-page chat:** the greeting is `text-h3` at `pt-[120px]`. The toolbar holds a "History" dropdown and a "New chat" button.
- **[O] Settings:**
  - **Navigation:** a settings sidebar replaces the main one.
  - **Pages:** `max-w-2xl px-4 pt-3 pb-8` with a `text-h3` title.
  - **Groups:** `rounded-2xl bg-surface-elevated ring-hairline mb-8` cards with dashed separators.
  - **Rows:** `p-4 py-[15px] gap-4`, each with a 32px `surface-tint-neutral` icon tile.
- **[O] Templates:** a "Note templates" dialog, `h-[85vh] max-h-[48rem] max-w-5xl p-0`, in two panes.
  - **Left pane:** resizable, with a "New template" row (a 36px tile) and a `bg-highlight-faint` search field.
  - **Right pane:** the template.
  - **Footer:** "Apply template".

## Nub (floating widget)

- **[O] Pill:**
  - **Look:** 34px wide, `rgba(38,38,38,.95)`, with a neutral-600/95 border, a `black/80` ring and a drop shadow.
  - **Contents:** stacked 30px cells: the logo at 80% opacity, then the mirrored bars (2px bars in a 12×10 box), then a capture dot when one is shown.
  - **Click:** opens the app.
- **[O] Meeting prompt:**
  - **Look:** the pill becomes a small orange card (`oats-yellow-300`, 96–120px wide).
  - **Contents:** the meeting title, clamped to 3 lines, with stacked "Take notes" and "Not now" buttons.
  - **Nudge:** it shakes with the nudge animation.
- **[O] Motion:** layout uses a spring (bounce 0.15, 0.3s). The content swaps with y ∓12, blur 3px and scale 0.9 over 0.2s ease-in-out.
- **[O] Placement:** on the display nearest the cursor, flush with the right edge, at y = top + (height − 37) × 0.7. A dragged position is saved with its display's bounds and restored only while that display is still attached. Size changes keep the top-right corner and stay inside the work area (`src/main/widget/placement.ts`).
- **Linux on Wayland (Cereal only):** Wayland compositors such as GNOME ignore where a window asks to be and won't keep it on top. So the widget runs in a small host process under XWayland (`--cereal-widget-host --ozone-platform=x11`, `src/main/widget/host.ts`), driven by the app over a pipe (`widget/controller.ts`), while the main window stays native Wayland.
  - **Size:** the host zooms the page by the app's display scale over its own, so on native-resolution XWayland (GNOME 50: scale 2 on a 167% display) the widget matches the app's UI.
  - **Focus:** a click in the XWayland widget gives the app no Wayland activation token, so "Open Cereal" and "Take notes" only show and focus the main window. When another app has focus, GNOME may answer with "Cereal is ready" instead of raising it.
    - **Re-mapping was removed (2026-10-21):** hiding and re-showing the window did get focus, but Chromium re-maps it against xdg-shell, and mutter logs "invalid window geometry" and "Buggy client … without acknowledging configuration".
  - **Switches:** `CEREAL_WIDGET_IN_PROCESS=1` keeps the widget in the app (the e2e test does this). `CEREAL_WIDGET_DEBUG_PORT=<port>` opens DevTools on the host.

## Cereal deviations

- **Accent:** navy instead of olive green: fill `#1E3A8A`, ink `#3558C8`, tint `#E4EAF7`, dancing bars `#3D7BFF`. The "generating" colour drift uses blue-greys.
- **Fonts:** the OFL fallbacks Granola itself declares (Inter Variable at opsz 28, and IBM Plex Serif) instead of KMR Melange Grotesk and Quadrant Notepad.
- **Icons:** lucide icons, chosen to match Granola's metaphors, instead of Granola's own icon set.
- **Features Granola doesn't have:** Lecture mode (a mode chip in the note's options row) and the Assistant's own pages keep Cereal's sections, restyled.
- **Note page:** the options row keeps Cereal's chips (mode and template beside date and folder) rather than Granola's notes toggle menu and attendee editor. The recording widget has no audio settings or language controls.
- **Granola features with no counterpart in Cereal:** workspaces, sharing, Shared with me, CRM spaces and the in-meeting brief.
