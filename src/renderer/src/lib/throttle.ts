/** Leading + trailing throttle: runs at once, then at most every `ms` with the latest arguments. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const run = (): void => {
    timer = null
    last = Date.now()
    const args = pending
    pending = null
    if (args) fn(...args)
  }
  const throttled = (...args: A): void => {
    pending = args
    if (timer) return
    const wait = ms - (Date.now() - last)
    if (wait <= 0) run()
    else timer = setTimeout(run, wait)
  }
  throttled.flush = (): void => {
    if (timer) clearTimeout(timer)
    if (pending) run()
    else timer = null
  }
  throttled.cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }
  return throttled
}
