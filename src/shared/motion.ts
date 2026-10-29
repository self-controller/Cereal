// Timing maths for the enhanced-notes choreography (docs/granola-motion.md), kept pure so tests can run it.

/** Each line of the user's notes starts its grey sweep this much after the line above, so the sweep runs down the page. */
export const PULSE_LINE_STEP_MS = 140

/** How a newly streamed block (paragraph, bullet, heading) fades and unblurs in. */
export const BLOCK_IN = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }

/** Starts slow and ends fast: the user's notes ease into their slide before rushing up into the new notes. */
export function easeInExpo(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (10 * t - 10)
}

/** The fold-away runs longer for taller notes: 1.3 s for a short pane, up to 3 s once it is a screen tall. */
export function foldAwayDuration(height: number, viewportHeight: number): number {
  const share = viewportHeight > 0 ? Math.min(1, Math.max(0, height / viewportHeight)) : 1
  return 1.3 + share * 1.7
}
