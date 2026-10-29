// Routine schedules, written like Granola's Assistant routines: `at(…)`, `rate(…)` or `cron(…)` plus an IANA timezone.
//   at(2026-10-20T09:00)            once, at that wall-clock time in the routine's timezone (or an explicit offset)
//   rate(15 minutes)                every N minutes | hours | days
//   cron(0 9 * * 1-5)               minute hour day-of-month month day-of-week (0 or 7 = Sunday; names allowed)

type Schedule =
  | { kind: 'at'; local: string }
  | { kind: 'rate'; ms: number; amount: number; unit: string }
  | { kind: 'cron'; minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean; fields: string[] }

const UNITS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function field(spec: string, min: number, max: number, names: string[] = [], nameBase = min): { values: Set<number>; any: boolean } {
  const values = new Set<number>()
  const any = spec === '*' || spec === '?'
  const value = (s: string): number => {
    const i = names.indexOf(s.toLowerCase())
    const n = i >= 0 ? i + nameBase : Number(s)
    if (!Number.isInteger(n)) throw new Error(`"${s}" is not a valid value`)
    return n
  }
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText ? Number(stepText) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${part}" has an invalid step`)
    let lo: number
    let hi: number
    if (range === '*' || range === '?') [lo, hi] = [min, max]
    else if (range.includes('-')) [lo, hi] = range.split('-').map(value) as [number, number]
    else [lo, hi] = [value(range), stepText ? max : value(range)]
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is out of range (${min}–${max})`)
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { values, any }
}

export function parseSchedule(expression: string): Schedule {
  const m = expression.trim().match(/^(at|rate|cron)\((.+)\)$/i)
  if (!m) throw new Error('A schedule must look like at(2026-10-20T09:00), rate(15 minutes) or cron(0 9 * * 1-5).')
  const kind = m[1].toLowerCase()
  const body = m[2].trim()
  if (kind === 'at') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/.test(body)) throw new Error('at() needs a date and time like 2026-10-20T09:00.')
    return { kind: 'at', local: body }
  }
  if (kind === 'rate') {
    const r = body.match(/^(\d+)\s+(minute|hour|day)s?$/i)
    if (!r || Number(r[1]) < 1) throw new Error('rate() needs an amount and a unit, like rate(15 minutes), rate(1 hour) or rate(2 days).')
    const unit = r[2].toLowerCase()
    if (unit === 'minute' && Number(r[1]) < 5) throw new Error('Routines can run at most every 5 minutes.')
    return { kind: 'rate', ms: Number(r[1]) * UNITS[unit], amount: Number(r[1]), unit }
  }
  let fields = body.split(/\s+/)
  // AWS-style six fields end with a year; only "*" is supported there.
  if (fields.length === 6 && (fields[5] === '*' || fields[5] === '?')) fields = fields.slice(0, 5)
  if (fields.length !== 5) throw new Error('cron() needs five fields: minute hour day-of-month month day-of-week.')
  try {
    const minute = field(fields[0], 0, 59)
    const hour = field(fields[1], 0, 23)
    const dom = field(fields[2], 1, 31)
    const month = field(fields[3], 1, 12, MONTHS, 1)
    const dow = field(fields[4], 0, 7, DAYS, 0)
    if (dow.values.delete(7)) dow.values.add(0)
    return { kind: 'cron', minute: minute.values, hour: hour.values, dom: dom.values, month: month.values, dow: dow.values, domAny: dom.any, dowAny: dow.any, fields }
  } catch (e) {
    throw new Error(`Invalid cron expression: ${(e as Error).message}.`)
  }
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new Error(`"${timezone}" is not a known timezone. Use an IANA name like Europe/London.`)
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Wall-clock parts of an instant in a timezone. */
function wallClock(t: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    formatters.set(timezone, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: DAYS.indexOf(String(p.weekday).toLowerCase()) }
}

/** The instant at which a timezone's clock shows the given wall-clock time. */
function fromWallClock(local: string, timezone: string): number {
  const [date, time] = local.split('T')
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi, s = 0] = time.split(':').map(Number)
  const target = Date.UTC(y, mo - 1, d, h, mi, s)
  let guess = target
  for (let i = 0; i < 3; i++) {
    const w = wallClock(guess, timezone)
    const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, s)
    guess += target - shown
  }
  return guess
}

/** When a routine next fires after `after`, or null if it never will again. */
export function nextFireAfter(expression: string, after: Date, timezone: string): Date | null {
  const s = parseSchedule(expression)
  if (s.kind === 'at') {
    const t = /(Z|[+-]\d{2}:?\d{2})$/.test(s.local) ? Date.parse(s.local) : fromWallClock(s.local, timezone)
    return t > after.getTime() ? new Date(t) : null
  }
  if (s.kind === 'rate') return new Date(after.getTime() + s.ms)

  // Walk forward through wall-clock time, skipping whole days and hours that can't match.
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
  for (let i = 0; i < 200_000; i++) {
    const w = wallClock(t, timezone)
    const domOk = s.dom.has(w.day)
    const dowOk = s.dow.has(w.weekday)
    const dayOk = s.domAny && s.dowAny ? true : s.domAny ? dowOk : s.dowAny ? domOk : domOk || dowOk
    if (!s.month.has(w.month) || !dayOk) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60_000
      continue
    }
    if (!s.hour.has(w.hour)) {
      t += (60 - w.minute) * 60_000
      continue
    }
    if (!s.minute.has(w.minute)) {
      t += 60_000
      continue
    }
    return new Date(t)
  }
  return null
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A short human description, e.g. "Every 15 minutes" or "Weekdays at 09:00". */
export function describeSchedule(expression: string, timezone: string): string {
  let s: Schedule
  try {
    s = parseSchedule(expression)
  } catch {
    return expression
  }
  if (s.kind === 'rate') return `Every ${s.amount === 1 ? s.unit : `${s.amount} ${s.unit}s`}`
  if (s.kind === 'at') return `Once, ${s.local.replace('T', ' at ')}${/(Z|[+-]\d{2}:?\d{2})$/.test(s.local) ? '' : ` (${timezone})`}`
  const [m, h, dom, mon, dow] = s.fields
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*') {
    const at = `${pad(+h)}:${pad(+m)}`
    if (dow === '*' || dow === '?') return `Every day at ${at}`
    if (dow === '1-5' || dow.toLowerCase() === 'mon-fri') return `Weekdays at ${at}`
    return `At ${at} on ${dow}`
  }
  return `cron(${s.fields.join(' ')})`
}
