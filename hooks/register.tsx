import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DayEntry,
  DayRow,
  History,
  Ledger,
  Limit,
  MachineFile,
  MachineRow,
  ModelTally,
  OtherEstimate,
  OtherStatus,
  LimitWindow,
  Calibration,
  Sample,
  Snapshot,
  SubscriptionValue,
  Tokens,
  Totals,
} from '../types'

const PANE = 'usage-stats'
const EMPTY: ModelTally = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const ZERO: Tokens = { ...EMPTY, byModel: {} }
const PACE_WINDOW_MS = 60 * 60 * 1000 // judge the burn rate on the last hour of readings
const KEEP_DAYS = 180 // history older than this is pruned from the store
const CHART_DAYS = 14
const DAY_PREFIX = 'day:'
const SYNC_EVERY_MS = 2 * 60 * 1000 // write and read the sync folder at most this often, but always at start and end
const REFRESH_MS = 60 * 1000 // while a session is open, refresh the figures this often, even with no turns
const HEARTBEAT_MS = 30 * 60 * 1000 // an idle machine still rewrites its file this often, so others see it is alive

// What this machine last wrote to the sync folder, so an idle refresh skips an unchanged
// write. Module state: a reload starts it over, which costs one extra write.
let lastWrite: { body: string; at: number } | undefined

const snapshot = atom({ plugin: 'usage-stats', key: 'snapshot' } as const, null, { shape: 'snap-2' })
const tokens = atom({ plugin: 'usage-stats', key: 'tokens' } as const, ZERO, { shape: 'tok-2' })
const samples = atom({ plugin: 'usage-stats', key: 'samples' } as const, {}, { shape: 'samp-1' })
const history = atom({ plugin: 'usage-stats', key: 'history' } as const, null, { shape: 'hist-4' })
const ledger = atom({ plugin: 'usage-stats', key: 'ledger' } as const, null, { shape: 'ledger-1' })
const remote = atom({ plugin: 'usage-stats', key: 'remote' } as const, {}, { shape: 'remote-1' })
const sync = atom({ plugin: 'usage-stats', key: 'sync' } as const, null, { shape: 'sync-1' })
const tab = atom({ plugin: 'usage-stats', key: 'tab' } as const, 'now', { shape: 'tab-1' })

const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const dur = (ms: number) => {
  const hrs = Math.floor(ms / 3.6e6)
  const m = Math.floor((ms % 3.6e6) / 6e4)
  return hrs >= 24 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : hrs > 0 ? `${hrs}h ${m}m` : `${m}m`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7)} ${Number(day.slice(8, 10))}`
const CONFIGURE = '/plugin configure usage-stats@claude-usage-stats'
const SET_PRICE_HINT = `Add your plan price to compare: ${CONFIGURE}`
/**
 * The value section as lines, for the pane and the text summary alike: against the plan
 * when its price is set, else the API-equivalent cost alone. Lines from `dimFrom` on are notes.
 */
const valueLines = (v: SubscriptionValue): { head: string; lines: string[]; dimFrom: number } => {
  const span = `${shortDate(v.periodStart)} – ${shortDate(v.periodEnd)} (day ${v.daysElapsed} of ${v.periodDays})`
  const hasPrice = v.priceUsd > 0
  const times = (n: number) => (hasPrice ? `  = ${(n / v.priceUsd).toFixed(2)}×${n === v.spendUsd ? ' the plan' : ''}` : '')
  const o = v.other
  const otherLines =
    o.state === 'ok'
      ? [
          `Other apps (estimated) ${usd(o.usd)}`,
          `Incl. other apps       ${usd(v.spendUsd + o.usd)}${hasPrice ? `  = ${((v.spendUsd + o.usd) / v.priceUsd).toFixed(2)}× the plan` : ''}`,
        ]
      : o.state === 'calibrating'
        ? [`Other apps (estimated) calibrating: ${o.points} of ${o.needed} limit points seen`]
        : []
  const notes: string[] = []
  if (v.trackedFrom) notes.push(`Recorded since ${shortDate(v.trackedFrom)} only; earlier days of this period aren't counted.`)
  if (o.state === 'ok') {
    notes.push(
      `Other apps = ${o.kind === 'seven_day' ? 'weekly' : '5-hour'}-limit rise not explained by Claude Code (~${usd(o.usdPerPoint)} per point); a rough estimate.`,
    )
  } else if (o.state === 'calibrating') {
    notes.push('Other apps are estimated from plan-limit movement once enough Claude Code use has been seen.')
  } else {
    notes.push('Claude Code only: claude.ai, desktop and mobile chats need plan-limit readings (a Claude subscription).')
  }
  const lines = [
    `${hasPrice ? `Plan ${usd(v.priceUsd)}/mo` : v.isCalendarMonth ? 'This month' : 'Billing period'} · ${span}`,
    `API-equivalent so far  ${usd(v.spendUsd)}${times(v.spendUsd)}`,
    `Projected this period  ${usd(v.projectedUsd)}${hasPrice ? `  = ${(v.projectedUsd / v.priceUsd).toFixed(2)}×` : ''}`,
    ...(hasPrice
      ? [
          v.breakEven
            ? v.breakEven.isProjected
              ? `Break-even            ~${shortDate(v.breakEven.day)} at this pace`
              : `Break-even            reached ${shortDate(v.breakEven.day)}`
            : `Break-even            not this period at this pace (API would cost less)`,
        ]
      : []),
    ...otherLines,
  ]
  return {
    head: hasPrice ? 'Subscription value' : 'API-equivalent cost',
    lines: [...lines, ...notes, ...(hasPrice ? [] : [SET_PRICE_HINT])],
    dimFrom: lines.length,
  }
}
const ago = (ms: number) => (ms < 6e4 ? '<1m' : dur(ms))
const two = (n: number) => String(n).padStart(2, '0')
const clock = (t: number) => {
  const d = new Date(t)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
/** Local calendar day, YYYY-MM-DD. */
const dayOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
const daysBefore = (t: number, n: number) => dayOf(t - n * 864e5)
// Short model name: "claude-opus-5-5-20261001" -> "opus-5-5"
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

type Eta =
  | { kind: 'none'; why: string }
  | { kind: 'safe'; resetIn: number; ratePerHr: number }
  | { kind: 'hit'; at: number; inMs: number; ratePerHr: number; beforeResetBy?: number }

/** Linear projection of when a window reaches 100%, from readings in its current reset period. */
const projectEta = (l: Limit, hist: Sample[] | undefined, now: number): Eta => {
  if (l.percentUsed >= 100) return { kind: 'hit', at: now, inMs: 0, ratePerHr: 0 }
  const period = (hist ?? []).filter(s => s.resetsAt === l.resetsAt)
  const recent = period.filter(s => now - s.t <= PACE_WINDOW_MS)
  const use = recent.length >= 2 ? recent : period
  const first = use[0]
  const last = use[use.length - 1]
  if (use.length < 2 || !first || !last) return { kind: 'none', why: 'needs 2+ readings' }
  const hours = (last.t - first.t) / 3.6e6
  const rise = last.pct - first.pct
  if (hours <= 0 || rise <= 0) return { kind: 'none', why: 'no measurable climb yet' }
  const ratePerHr = rise / hours
  const inMs = ((100 - l.percentUsed) / ratePerHr) * 3.6e6
  const resetAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  if (Number.isFinite(resetAt) && now + inMs >= resetAt) {
    return { kind: 'safe', resetIn: resetAt - now, ratePerHr }
  }
  return {
    kind: 'hit',
    at: now + inMs,
    inMs,
    ratePerHr,
    beforeResetBy: Number.isFinite(resetAt) ? resetAt - (now + inMs) : undefined,
  }
}

const etaShort = (e: Eta) =>
  e.kind === 'hit' ? (e.inMs === 0 ? 'AT LIMIT' : `full ~${clock(e.at)}`) : e.kind === 'safe' ? 'ok till reset' : ''

const statusText = (s: Snapshot, hist: Record<string, Sample[]>, now: number) => {
  const parts = s.limits.map(l => {
    const e = etaShort(projectEta(l, hist[l.kind], now))
    return `${label(l.kind)} ${l.percentUsed}%${e ? ` (${e})` : ''}`
  })
  if (s.contextPercent !== undefined) parts.push(`ctx ${s.contextPercent}%`)
  if (s.costUsd !== undefined) parts.push(usd(s.costUsd))
  return parts.length ? parts.join(' · ') : undefined
}

const toSnapshot = (
  u: {
    startedAt?: number
    rateLimits: Limit[]
    context: { tokens?: number; window: number; percent?: number }
    cost?: { usd: number }
  },
  startedAt: number,
): Snapshot => ({
  startedAt: u.startedAt ?? startedAt,
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  costUsd: u.cost?.usd,
})

type RawUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
const add = (a: ModelTally, u: RawUsage): ModelTally => ({
  turns: a.turns + 1,
  input: a.input + u.input_tokens,
  output: a.output + u.output_tokens,
  cacheRead: a.cacheRead + u.cache_read_input_tokens,
  cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
})
const sum = (a: ModelTally, b: ModelTally): ModelTally => ({
  turns: a.turns + b.turns,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
const NO_TOTALS: Totals = { ...EMPTY, costUsd: 0, sessions: 0, activeDays: 0 }

/** Reads a stored entry, or undefined when it is not one this version wrote. */
const asEntry = (v: unknown): DayEntry | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const e = v as Partial<DayEntry>
  return typeof e.day === 'string' && typeof e.turns === 'number' && typeof e.costUsd === 'number'
    ? (e as DayEntry)
    : undefined
}

// Record a reading for each window, dropping readings from earlier reset periods.
async function recordSamples($: EngineInterface, limits: Limit[], now: number) {
  if (limits.length === 0) return
  await update($, samples, hx => {
    const next: Record<string, Sample[]> = { ...(hx ?? {}) }
    for (const l of limits) {
      const kept = (next[l.kind] ?? []).filter(s => s.resetsAt === l.resetsAt)
      const lastS = kept[kept.length - 1]
      if (!lastS || lastS.pct !== l.percentUsed) kept.push({ t: now, pct: l.percentUsed, resetsAt: l.resetsAt })
      next[l.kind] = kept.slice(-200)
    }
    return next
  })
}

// --- Other apps (claude.ai, desktop, mobile), estimated from plan-limit movement ---
//
// The 5-hour and weekly limits are account-wide, so chats in other apps move them too.
// Readings minutes apart during active Claude Code use teach roughly how many dollars of
// Claude Code cost move a limit one point; within a window, the rise not explained by
// Claude Code cost (all synced machines) is then other apps' usage. Rough by design.
const LIMIT_KINDS = ['seven_day', 'five_hour'] // preference order for the estimate
const TIGHT_MS = 3 * 60 * 1000 // readings this close are taken as Claude Code alone
const MIN_POINTS = 5 // points of calibration before an estimate is shown
const FORGET_AT = 100 // past this many points, halve the calibration so it follows changes
const WINDOW_KEEP_MS = 40 * 864e5
const WINDOWS_KEY = 'limitWindows'
const CAL_KEY = 'limitCal'

/** A window's reset time rounded to ten minutes, so every reading and machine agrees on it. */
const windowKey = (resetsAt: string | undefined) => {
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  return Number.isFinite(t) ? String(Math.round(t / 6e5)) : undefined
}
const asNumberRecord = <T,>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> => {
  const out: Record<string, T> = {}
  if (isRecord(v)) for (const [k2, x] of Object.entries(v)) if (ok(x)) out[k2] = x
  return out
}
const isWindow = (x: unknown): x is LimitWindow =>
  isRecord(x) && typeof x.kind === 'string' && typeof x.key === 'string' && typeof x.firstPct === 'number' &&
  typeof x.lastPct === 'number' && typeof x.firstCc === 'number' && typeof x.lastCc === 'number' &&
  typeof x.lastAt === 'number' && typeof x.day === 'string'
const isCalibration = (x: unknown): x is Calibration =>
  isRecord(x) && typeof x.costUsd === 'number' && typeof x.points === 'number'
const isEstimate = (x: unknown): x is OtherEstimate =>
  isRecord(x) && typeof x.kind === 'string' && typeof x.day === 'string' && typeof x.usd === 'number'

/**
 * Folds one reading into a window and a calibration; undefined when it is the same reading
 * again. A reading only changes when Claude Code gets an API response: an idle refresh
 * re-reads the last one, so it must not move `last.at` on, or the first reply after an
 * idle spell (other apps' usage and all) would look minutes after the one before it.
 */
const foldReading = (
  windows: Record<string, LimitWindow>,
  cals: Record<string, Calibration>,
  r: { kind: string; key: string; pct: number; cc: number; at: number; day: string },
) => {
  const prevLast = cals[r.kind]?.last
  if (prevLast && prevLast.key === r.key && prevLast.pct === r.pct && prevLast.cc === r.cc && windows[`${r.kind}|${r.key}`]) {
    return undefined
  }
  const wk = `${r.kind}|${r.key}`
  const w = windows[wk]
  const nextWindows = {
    ...windows,
    [wk]: w
      ? { ...w, day: r.day, lastPct: r.pct, lastCc: r.cc, lastAt: r.at }
      : { kind: r.kind, key: r.key, day: r.day, firstPct: r.pct, firstCc: r.cc, lastPct: r.pct, lastCc: r.cc, lastAt: r.at },
  }
  const c = cals[r.kind] ?? { costUsd: 0, points: 0 }
  let { costUsd, points } = c
  const l = c.last
  if (l && l.key === r.key && r.at - l.at <= TIGHT_MS && r.pct >= l.pct && r.cc >= l.cc) {
    costUsd += r.cc - l.cc
    points += r.pct - l.pct
    if (points > FORGET_AT) {
      costUsd /= 2
      points /= 2
    }
  }
  return {
    windows: nextWindows,
    cals: { ...cals, [r.kind]: { costUsd, points, last: { key: r.key, pct: r.pct, cc: r.cc, at: r.at } } },
  }
}

/** This machine's estimate for each window of each calibrated kind. */
const estimatesOf = (windows: Record<string, LimitWindow>, cals: Record<string, Calibration>) => {
  const out: Record<string, OtherEstimate> = {}
  for (const [wk, w] of Object.entries(windows)) {
    const c = cals[w.kind]
    if (!c || c.points < MIN_POINTS || c.costUsd <= 0) continue
    const perPoint = c.costUsd / c.points
    const usd = Math.max(0, perPoint * (w.lastPct - w.firstPct) - (w.lastCc - w.firstCc))
    out[wk] = { kind: w.kind, day: w.day, usd }
  }
  return out
}

/** The other-apps figure for a period, from every machine's estimates (each window once). */
const otherFor = (
  merged: Record<string, OtherEstimate>,
  cals: Record<string, Calibration>,
  hasWindows: boolean,
  from: string,
  to: string,
): OtherStatus => {
  const kind = LIMIT_KINDS.find(kd => Object.values(merged).some(e => e.kind === kd))
  if (!kind) {
    if (!hasWindows) return { state: 'none' }
    const best = Math.max(0, ...LIMIT_KINDS.map(kd => cals[kd]?.points ?? 0))
    return { state: 'calibrating', points: Math.floor(best * 10) / 10, needed: MIN_POINTS }
  }
  let usd = 0
  for (const e of Object.values(merged)) if (e.kind === kind && e.day >= from && e.day <= to) usd += e.usd
  const c = cals[kind]
  return { state: 'ok', kind, usdPerPoint: c && c.points > 0 ? c.costUsd / c.points : 0, usd }
}

// Record a plan-limit reading against the Claude Code cost recorded so far.
async function recordLimits($: EngineInterface, limits: Limit[], now: number, sessionCostUsd: number) {
  const readings = limits.filter(l => LIMIT_KINDS.includes(l.kind) && windowKey(l.resetsAt))
  if (readings.length === 0) return
  const hx = await read($, history)
  const led = await read($, ledger)
  // Recorded cost, plus what this session has spent since its last recorded turn.
  const cc = (hx?.ccTotalUsd ?? 0) + Math.max(0, sessionCostUsd - (led?.lastCostUsd ?? sessionCostUsd))
  let windows = asNumberRecord(await $.store.get(WINDOWS_KEY), isWindow)
  let cals = asNumberRecord(await $.store.get(CAL_KEY), isCalibration)
  let isChanged = false
  for (const l of readings) {
    const key = windowKey(l.resetsAt)
    if (!key) continue
    const folded = foldReading(windows, cals, { kind: l.kind, key, pct: l.percentUsed, cc, at: now, day: dayOf(now) })
    if (!folded) continue
    ;({ windows, cals } = folded)
    isChanged = true
  }
  if (!isChanged) return
  for (const [wk, w] of Object.entries(windows)) if (now - w.lastAt > WINDOW_KEEP_MS) delete windows[wk]
  await $.store.set(WINDOWS_KEY, windows)
  await $.store.set(CAL_KEY, cals)
}

// Add one turn to this session's entry for today. Each session writes only its own
// key, so sessions running side by side never overwrite each other.
async function recordTurn($: EngineInterface, u: RawUsage & { model: string }, now: number) {
  const day = dayOf(now)
  const key = `${DAY_PREFIX}${day}:${await $.session.id()}`
  const usage = await $.session.usage()
  const costNow = usage.cost?.usd ?? 0
  const prev = await read($, ledger)
  const last = prev?.lastCostUsd ?? 0
  // A cost that went down means the engine's ledger started over (a /clear): count it from zero.
  const costDelta = costNow >= last ? costNow - last : costNow
  await update($, ledger, () => ({ lastCostUsd: costNow }))

  const old = asEntry(await $.store.get(key))
  const base: DayEntry = old ?? { ...EMPTY, day, costUsd: 0, byModel: {}, peaks: {} }
  const peaks = { ...base.peaks }
  for (const l of usage.rateLimits) peaks[l.kind] = Math.max(peaks[l.kind] ?? 0, l.percentUsed)
  const entry: DayEntry = {
    ...add(base, u),
    day,
    costUsd: base.costUsd + costDelta,
    byModel: { ...base.byModel, [u.model]: add(base.byModel[u.model] ?? EMPTY, u) },
    peaks,
  }
  await $.store.set(key, entry)
}

type SyncOptions = {
  folder: string
  machineName: string
  force: boolean
  priceUsd: number
  billingDay: number
  /** False when billingDay is the default: the period is then the calendar month. */
  isBillingDaySet: boolean
}

/** A local `YYYY-MM-DD` as a local-midnight Date. */
const dateOfDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}
const daysBetween = (a: string, b: string) => Math.round((dateOfDay(b).getTime() - dateOfDay(a).getTime()) / 864e5)
const addDays = (day: string, n: number) => {
  const d = dateOfDay(day)
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime())
}
/** The renewal day in a month, clamped to the month's length (the 31st renews on the 30th in November). */
const renewalIn = (year: number, month: number, billingDay: number) =>
  new Date(year, month, Math.min(billingDay, new Date(year, month + 1, 0).getDate()))

/** The billing period holding `today`: from the last renewal through the day before the next. */
const billingPeriod = (today: string, billingDay: number) => {
  const t = dateOfDay(today)
  const thisMonth = renewalIn(t.getFullYear(), t.getMonth(), billingDay)
  const start = t >= thisMonth ? thisMonth : renewalIn(t.getFullYear(), t.getMonth() - 1, billingDay)
  const next = renewalIn(start.getFullYear(), start.getMonth() + 1, billingDay)
  const startDay = dayOf(start.getTime())
  const endDay = addDays(dayOf(next.getTime()), -1)
  return { startDay, endDay, periodDays: daysBetween(startDay, endDay) + 1 }
}

/** Subscription value this period from per-day API-equivalent cost. */
const subscriptionValue = (
  costByDay: Record<string, number>,
  today: string,
  firstDay: string | undefined,
  priceUsd: number,
  billingDay: number,
  isBillingDaySet: boolean,
): Omit<SubscriptionValue, 'other'> => {
  const { startDay, endDay, periodDays } = billingPeriod(today, billingDay)
  const daysElapsed = daysBetween(startDay, today) + 1
  const days = Object.keys(costByDay).filter(d => d >= startDay && d <= today).sort()
  let spendUsd = 0
  let reachedOn: string | undefined
  for (const d of days) {
    spendUsd += costByDay[d] ?? 0
    if (priceUsd > 0 && !reachedOn && spendUsd >= priceUsd) reachedOn = d
  }
  // Pace over the days actually recorded this period, so a late install doesn't dilute it.
  const trackedFrom = firstDay && firstDay > startDay ? firstDay : undefined
  const paceDays = trackedFrom ? daysBetween(trackedFrom, today) + 1 : daysElapsed
  const perDay = paceDays > 0 ? spendUsd / paceDays : 0
  const projectedUsd = spendUsd + perDay * (periodDays - daysElapsed)
  let breakEven: SubscriptionValue['breakEven']
  if (reachedOn) breakEven = { day: reachedOn, isProjected: false }
  else if (priceUsd > 0 && perDay > 0) {
    const day = addDays(today, Math.ceil((priceUsd - spendUsd) / perDay))
    if (day <= endDay) breakEven = { day, isProjected: true }
  }
  return {
    priceUsd,
    periodStart: startDay,
    periodEnd: endDay,
    periodDays,
    daysElapsed,
    isCalendarMonth: !isBillingDaySet,
    spendUsd,
    projectedUsd,
    trackedFrom,
    breakEven,
  }
}


const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** This machine's id, made once and kept in the store. */
async function machineIdOf($: EngineInterface) {
  const kept = await $.store.get('machineId')
  if (typeof kept === 'string' && /^[a-z0-9]{6,32}$/.test(kept)) return kept
  let id = ''
  while (id.length < 12) id += Math.floor(Math.random() * 36).toString(36)
  await $.store.set('machineId', id)
  return id
}

/** The name shown for this machine: the setting, else the host's name, else its id. */
async function machineNameOf($: EngineInterface, setting: string, id: string) {
  const named = setting.trim() || (await $.env.get('HOSTNAME')) || (await $.env.get('COMPUTERNAME')) || ''
  return named.trim() || `machine-${id.slice(0, 4)}`
}

/** The sync folder as an absolute path with its separator, `~` expanded; undefined when unset. */
async function syncDirOf($: EngineInterface, folder: string) {
  let dir = folder.trim()
  if (!dir) return undefined
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!home) return undefined
    dir = home + dir.slice(1)
  }
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return { dir: dir.replace(/[\\/]+$/, ''), sep }
}

const FILE_RE = /^usage-([a-z0-9]{6,32})\.json$/

/** Reads one machine's file, or undefined when it is not one this plugin wrote. */
const asMachineFile = (v: unknown): MachineFile | undefined => {
  if (!isRecord(v) || v.version !== 1 || typeof v.machineId !== 'string' || !isRecord(v.entries)) return undefined
  const entries: Record<string, DayEntry> = {}
  for (const [key, e] of Object.entries(v.entries)) {
    const entry = asEntry(e)
    if (entry && key.startsWith(DAY_PREFIX)) entries[key] = entry
  }
  return {
    version: 1,
    machineId: v.machineId,
    machine: typeof v.machine === 'string' ? v.machine : v.machineId,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    entries,
    other: asNumberRecord(v.other, isEstimate),
  }
}

// Write this machine's file to the sync folder and read every other machine's.
// Throttled to once per SYNC_EVERY_MS unless forced; a failure keeps the last good read.
async function syncFolder(
  $: EngineInterface,
  own: Record<string, DayEntry>,
  ownOther: Record<string, OtherEstimate>,
  opts: SyncOptions,
  now: number,
) {
  const where = await syncDirOf($, opts.folder)
  if (!where) {
    await update($, sync, () => null)
    await update($, remote, () => ({}))
    return
  }
  const prev = await read($, sync)
  const isDue = opts.force || !prev || prev.folder !== where.dir || now - (prev.lastAt ?? 0) >= SYNC_EVERY_MS
  if (!isDue) return
  const id = await machineIdOf($)
  const machine = await machineNameOf($, opts.machineName, id)
  const file: MachineFile = { version: 1, machineId: id, machine, updatedAt: now, entries: own, other: ownOther }
  const ownPath = `${where.dir}${where.sep}usage-${id}.json`
  const body = `${ownPath}\n${machine}\n${JSON.stringify(own)}\n${JSON.stringify(ownOther)}`
  const isUnchanged = !opts.force && lastWrite?.body === body && now - lastWrite.at < HEARTBEAT_MS
  try {
    if (!isUnchanged) {
      await $.fs.write(ownPath, JSON.stringify(file))
      lastWrite = { body, at: now }
      // The file is written owner-only (0600), which on a shared folder also zeroes the
      // ACL mask, so the other machines' users (e.g. through Samba) cannot read it.
      // Let the group read it: that lifts the mask to r-- and leaves "other" untouched.
      if (where.sep === '/') await $.process.run(['chmod', 'g+r', ownPath]).catch(() => undefined)
    }
    const found: Record<string, MachineFile> = {}
    const problems: string[] = []
    for (const f of await $.fs.list(where.dir)) {
      const m = FILE_RE.exec(f.name)
      if (f.kind !== 'file' || !m || m[1] === id) continue
      try {
        const other = asMachineFile(JSON.parse(await $.fs.read(`${where.dir}${where.sep}${f.name}`)))
        if (other) found[other.machineId] = other
        else problems.push(`${f.name}: not a usage file`)
      } catch (err) {
        problems.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await update($, remote, () => found)
    await update($, sync, () => ({
      folder: where.dir,
      lastAt: now,
      error: problems.length ? `skipped ${problems.join('; ')}` : undefined,
    }))
  } catch (err) {
    await update($, sync, () => ({
      folder: where.dir,
      lastAt: now,
      error: err instanceof Error ? err.message : String(err),
    }))
  }
}

// Sum this machine's stored entries and every synced machine's into what the pane
// draws, pruning this machine's entries past KEEP_DAYS.
async function loadHistory($: EngineInterface, now: number, opts: SyncOptions) {
  const today = dayOf(now)
  const weekFrom = daysBefore(now, 6)
  const monthFrom = daysBefore(now, 29)
  const chartFrom = daysBefore(now, CHART_DAYS - 1)
  const pruneBefore = daysBefore(now, KEEP_DAYS)

  // This machine's entries, from the store.
  const own: Record<string, DayEntry> = {}
  for (const key of (await $.store.keys()).filter(key => key.startsWith(DAY_PREFIX))) {
    const entry = asEntry(await $.store.get(key))
    if (!entry) continue
    if (entry.day < pruneBefore) {
      await $.store.delete(key)
      continue
    }
    own[key] = entry
  }

  const windows = asNumberRecord(await $.store.get(WINDOWS_KEY), isWindow)
  const cals = asNumberRecord(await $.store.get(CAL_KEY), isCalibration)
  const ownOther = estimatesOf(windows, cals)
  await syncFolder($, own, ownOther, opts, now)
  const others = (await read($, remote)) ?? {}
  // Every machine's estimates, each window once: the largest any machine saw of it.
  const mergedOther: Record<string, OtherEstimate> = { ...ownOther }
  for (const f of Object.values(others)) {
    for (const [wk, e] of Object.entries(f.other ?? {})) {
      const mine = mergedOther[wk]
      if (!mine || e.usd > mine.usd) mergedOther[wk] = e
    }
  }
  const status = (await read($, sync)) ?? undefined
  const id = await machineIdOf($)
  const name = status ? await machineNameOf($, opts.machineName, id) : 'this machine'

  // Every entry once, by key: a session id is unique, so the same key in two files
  // (a sync service's conflicted copy, a renamed machine) is one session.
  const all = new Map<string, { entry: DayEntry; machineId: string }>()
  for (const [key, entry] of Object.entries(own)) all.set(key, { entry, machineId: id })
  for (const f of Object.values(others)) {
    for (const [key, entry] of Object.entries(f.entries)) {
      if (!all.has(key) && entry.day >= pruneBefore) all.set(key, { entry, machineId: f.machineId })
    }
  }

  const spans = { today: { ...NO_TOTALS }, week: { ...NO_TOTALS }, month: { ...NO_TOTALS }, all: { ...NO_TOTALS } }
  const daysSeen = { today: new Set<string>(), week: new Set<string>(), month: new Set<string>(), all: new Set<string>() }
  const rows: Record<string, DayRow> = {}
  const models30: Record<string, ModelTally> = {}
  const perMachine: Record<string, { month: Totals; all: Totals }> = {}
  let firstDay: string | undefined
  const addTo = (t: Totals, entry: DayEntry): Totals => ({
    ...sum(t, entry),
    costUsd: t.costUsd + entry.costUsd,
    sessions: t.sessions + 1,
    activeDays: 0,
  })

  const costByDay: Record<string, number> = {}
  let ccTotalUsd = 0
  for (const { entry, machineId } of all.values()) {
    ccTotalUsd += entry.costUsd
    if (!firstDay || entry.day < firstDay) firstDay = entry.day
    costByDay[entry.day] = (costByDay[entry.day] ?? 0) + entry.costUsd
    const inSpan = {
      today: entry.day === today,
      week: entry.day >= weekFrom,
      month: entry.day >= monthFrom,
      all: true,
    }
    for (const span of ['today', 'week', 'month', 'all'] as const) {
      if (!inSpan[span]) continue
      spans[span] = addTo(spans[span], entry)
      daysSeen[span].add(entry.day)
    }
    const pm = perMachine[machineId] ?? { month: { ...NO_TOTALS }, all: { ...NO_TOTALS } }
    perMachine[machineId] = { month: inSpan.month ? addTo(pm.month, entry) : pm.month, all: addTo(pm.all, entry) }
    if (inSpan.month) {
      for (const [m, tally] of Object.entries(entry.byModel)) models30[m] = sum(models30[m] ?? EMPTY, tally)
    }
    if (entry.day >= chartFrom) {
      const r = rows[entry.day] ?? { day: entry.day, costUsd: 0, output: 0, turns: 0, sessions: 0, peaks: {} }
      const peaks = { ...r.peaks }
      for (const [kind, p] of Object.entries(entry.peaks)) peaks[kind] = Math.max(peaks[kind] ?? 0, p)
      rows[entry.day] = {
        day: entry.day,
        costUsd: r.costUsd + entry.costUsd,
        output: r.output + entry.output,
        turns: r.turns + entry.turns,
        sessions: r.sessions + 1,
        peaks,
      }
    }
  }
  for (const span of ['today', 'week', 'month', 'all'] as const) spans[span].activeDays = daysSeen[span].size

  // One row per calendar day in the chart, empty days included, oldest first.
  const recent: DayRow[] = []
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const day = daysBefore(now, i)
    recent.push(rows[day] ?? { day, costUsd: 0, output: 0, turns: 0, sessions: 0, peaks: {} })
  }

  const machines: MachineRow[] = [
    { machineId: id, machine: name, isThis: true, ...(perMachine[id] ?? { month: NO_TOTALS, all: NO_TOTALS }) },
    ...Object.values(others)
      .map(f => ({
        machineId: f.machineId,
        machine: f.machine,
        isThis: false,
        updatedAt: f.updatedAt,
        ...(perMachine[f.machineId] ?? { month: NO_TOTALS, all: NO_TOTALS }),
      }))
      .sort((a, b) => b.month.costUsd - a.month.costUsd),
  ]
  const base = subscriptionValue(costByDay, today, firstDay, opts.priceUsd, opts.billingDay, opts.isBillingDaySet)
  const other = otherFor(mergedOther, cals, Object.keys(windows).length > 0, base.periodStart, today)
  const value = { ...base, other }
  const hx: History = { ...spans, firstDay, recent, models30, machines, sync: status, value, ccTotalUsd }
  await update($, history, () => hx)
}

// The periodic refresh: the session's figures, the limit countdowns, and the sync folder,
// so the pane and status line keep up with other machines while this one sits idle.
async function refresh($: EngineInterface, opts: SyncOptions) {
  const now = await $.clock.now()
  const prev = await read($, snapshot)
  const s = toSnapshot(await $.session.usage(), prev?.startedAt ?? now)
  await update($, snapshot, () => s)
  await recordSamples($, s.limits, now)
  await recordLimits($, s.limits, now, s.costUsd ?? 0)
  await loadHistory($, now, opts)
  $.ui.status(statusText(s, (await read($, samples)) ?? {}, now))
}

// Puts the settings command in the prompt box, ready for Enter; false where there is no box.
async function openSettings($: EngineInterface) {
  const { isFilled } = await $.prompt.fill({ text: CONFIGURE })
  if (isFilled) $.ui.toast('Press Enter to open the usage-stats settings')
  return isFilled
}

export const register: Register = (on, options) => {
  const syncOpts = (force: boolean): SyncOptions => ({
    folder: typeof options.syncFolder === 'string' ? options.syncFolder : '',
    machineName: typeof options.machineName === 'string' ? options.machineName : '',
    force,
    priceUsd: Math.max(0, Number(options.subscriptionUsd) || 0),
    billingDay: Math.min(31, Math.max(1, Math.round(Number(options.billingDay) || 1))),
    isBillingDaySet: Number(options.billingDay) > 1,
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-stats',
      description: 'Open the Claude usage stats pane ("history" or "value" for a text summary, "settings" to configure)',
    })
    const now = await $.clock.now()
    const u = await $.session.usage()
    const s = toSnapshot(u, now)
    await update($, snapshot, () => s)
    // Cost already on the ledger (a resumed session) was counted when it was spent.
    await update($, ledger, l => l ?? { lastCostUsd: u.cost?.usd ?? 0 })
    await recordSamples($, s.limits, now)
    await recordLimits($, s.limits, now, s.costUsd ?? 0)
    await loadHistory($, now, syncOpts(true))
    $.ui.status(statusText(s, (await read($, samples)) ?? {}, now))
    // Keep refreshing while the session is open; a reload drops this timer and starts a new one.
    if (e.isInteractive) {
      $.clock.every(REFRESH_MS, () => {
        void refresh($, syncOpts(false)).catch(() => undefined)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'usage-stats' }, async ($, e) => {
    const now = await $.clock.now()
    const s = toSnapshot(await $.session.usage(), now)
    await update($, snapshot, () => s)
    await recordSamples($, s.limits, now)
    await recordLimits($, s.limits, now, s.costUsd ?? 0)
    await loadHistory($, now, syncOpts(true))
    await $.ui.open({ id: PANE, title: 'Claude usage' })
    if (e.args.trim() === 'settings') {
      return { text: (await openSettings($)) ? 'Press Enter to open the settings.' : `Run ${CONFIGURE} to open the settings.` }
    }
    if (e.args.trim() === 'value') {
      const v = (await read($, history))?.value
      if (!v) return { text: 'No usage recorded yet; it starts with your next reply.' }
      const { head, lines } = valueLines(v)
      return { text: [head, ...lines].join('\n') }
    }
    if (e.args.trim() === 'history') {
      const hx = await read($, history)
      if (!hx || hx.all.turns === 0) return { text: 'No usage history recorded yet; it starts with your next reply.' }
      const line = (name: string, t: Totals) =>
        `${name.padEnd(Math.max(13, name.length))} ${usd(t.costUsd).padStart(9)}  ${String(t.turns).padStart(5)} turns  ${k(t.output).padStart(7)} out  ${t.sessions} sessions`
      return {
        text: [
          `Usage history (since ${hx.firstDay ?? 'today'}${hx.sync ? `, ${hx.machines.length} machine${hx.machines.length === 1 ? '' : 's'}` : ', this machine'})`,
          line('Today', hx.today),
          line('Last 7 days', hx.week),
          line('Last 30 days', hx.month),
          line(`All (${KEEP_DAYS}d max)`, hx.all),
          ...(hx.sync
            ? [
                '',
                `By machine, last 30 days (sync: ${hx.sync.folder})`,
                ...hx.machines.map(m =>
                  line(`${m.isThis ? '* ' : '  '}${m.machine}`, m.month) + (m.updatedAt ? `  (synced ${ago(now - m.updatedAt)} ago)` : ''),
                ),
                ...(hx.sync.error ? [`Sync problem: ${hx.sync.error}`] : []),
              ]
            : ['', 'This machine only. Set the syncFolder option to combine machines.']),
          ...(hx.value ? ['', valueLines(hx.value).head, ...valueLines(hx.value).lines] : []),
        ].join('\n'),
      }
    }
    return { text: statusText(s, (await read($, samples)) ?? {}, now) ?? 'Usage pane opened; figures appear after the first reply.' }
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const prev = await read($, snapshot)
    const s = toSnapshot(e, prev?.startedAt ?? now)
    await update($, snapshot, () => s)
    await recordSamples($, s.limits, now)
    await recordLimits($, s.limits, now, s.costUsd ?? 0)
    const hist = (await read($, samples)) ?? {}
    $.ui.status(statusText(s, hist, now))
    if (e.changed.includes('rateLimits')) {
      for (const l of e.rateLimits) {
        const eta = projectEta(l, hist[l.kind], now)
        if (l.percentUsed >= 90) $.ui.toast(`${label(l.kind)} limit at ${l.percentUsed}%`)
        else if (eta.kind === 'hit' && eta.inMs < 30 * 60 * 1000) {
          $.ui.toast(`${label(l.kind)} limit projected in ~${dur(eta.inMs)} at this pace`)
        }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const u = done.usage
    if (u) {
      await update($, tokens, t => {
        const cur = t ?? ZERO
        return {
          ...add(cur, u),
          byModel: { ...cur.byModel, [u.model]: add(cur.byModel[u.model] ?? EMPTY, u) },
        }
      })
      const now = await $.clock.now()
      await recordTurn($, u, now)
      await loadHistory($, now, syncOpts(false))
    }
    return done
  })

  // A last write, so this session's final turns reach the other machines.
  on('session.end', async ($, e, next) => {
    if (syncOpts(true).folder.trim()) await loadHistory($, await $.clock.now(), syncOpts(true))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const t = (await read($, tokens)) ?? ZERO
    const hist = (await read($, samples)) ?? {}
    const hx = await read($, history)
    const chosen = await read($, tab)
    const now = await $.clock.now()
    const totalAll = (m: ModelTally) => m.input + m.output + m.cacheRead + m.cacheWrite

    const tabs = [
      { value: 'now', label: 'Now', key: 'now' },
      { value: 'value', label: hx?.value && hx.value.priceUsd > 0 ? 'Value' : 'Cost', key: 'value' },
      { value: 'history', label: 'History', key: 'history' },
      ...(hx?.sync ? [{ value: 'machines', label: 'Machines', key: 'machines' }] : []),
    ]
    const current = tabs.some(x => x.value === chosen) ? (chosen as string) : 'now'

    // Building blocks: a heading, a label/value row that lines up in any font, a note.
    const heading = (text: string) => (
      <Box marginTop={1}>
        <Text weight="semibold" bold>
          {text}
        </Text>
      </Box>
    )
    const row = (name: string, value: string, color?: 'green' | 'yellow' | 'red') => (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text dimColor wrap="truncate-end">
          {name}
        </Text>
        <Text tabular color={color}>
          {value}
        </Text>
      </Box>
    )
    const note = (text: string, color?: 'red') => (
      <Text dimColor={!color} color={color} size="footnote" wrap="wrap">
        {text}
      </Text>
    )
    const level = (pct: number) => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')
    // A level, not a task, so a bar of Boxes rather than Progress: label and figure, the bar below.
    const meter = (name: string, value: number, max: number, figure: string, color: string = 'blue') => {
      const fill = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
      return (
        <Box flexDirection="column">
          {row(name, figure)}
          <Box flexDirection="row" width="100%" height={1} backgroundColor="gray">
            {fill > 0 && <Box width={`${Math.max(1, Math.round(fill))}%`} height={1} backgroundColor={color} />}
          </Box>
        </Box>
      )
    }
    const share = (name: string, part: number, whole: number, detail: string) =>
      meter(name, whole > 0 ? part : 0, whole, `${pct(part, whole)}% · ${detail}`)

    // --- Now: limits, context, this session ---
    const nowTab = () => {
      const models = Object.entries(t.byModel).sort((a, b) => b[1].output - a[1].output)
      const grand = totalAll(t)
      const elapsedHr = s ? (now - s.startedAt) / 3.6e6 : 0
      return (
        <Box flexDirection="column">
          {heading('Plan limits')}
          {(!s || s.limits.length === 0) &&
            note("No readings: this session isn't reporting plan limits (they come with a Claude subscription).")}
          {s?.limits.map(l => {
            const eta = projectEta(l, hist[l.kind], now)
            const reset = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
            const resetText = Number.isFinite(reset) ? (reset > 0 ? `resets in ${dur(reset)}` : 'resetting') : ''
            return (
              <Box flexDirection="column" marginTop={1}>
                {meter(label(l.kind), l.percentUsed, 100, `${l.percentUsed}%${resetText ? ` · ${resetText}` : ''}`, level(l.percentUsed))}
                {eta.kind === 'hit' &&
                  note(
                    eta.inMs === 0
                      ? 'Limit reached'
                      : `At ${eta.ratePerHr.toFixed(1)}%/h, full ~${clock(eta.at)} (in ${dur(eta.inMs)})` +
                          (eta.beforeResetBy ? `, ${dur(eta.beforeResetBy)} before reset` : ''),
                    'red',
                  )}
                {eta.kind === 'safe' && note(`At ${eta.ratePerHr.toFixed(1)}%/h, won't fill before reset`)}
                {eta.kind === 'none' && note(`Time to limit: ${eta.why}`)}
              </Box>
            )
          })}

          {heading('Context window')}
          {s?.contextPercent !== undefined ? (
            meter('Context', s.contextPercent, 100, `${s.contextPercent}% · ${k(s.contextTokens ?? 0)} of ${k(s.contextWindow)}`, level(s.contextPercent))
          ) : (
            note('No reading yet.')
          )}

          {heading('This session')}
          {row('Cost', s?.costUsd !== undefined ? usd(s.costUsd) : 'n/a')}
          {s?.costUsd !== undefined && elapsedHr > 0.05 && row('Pace', `${usd(s.costUsd / elapsedHr)}/h over ${dur(now - s.startedAt)}`)}
          {row('Turns', String(t.turns))}
          {row('Input', `${k(t.input)} (cache ${k(t.cacheRead + t.cacheWrite)})`)}
          {row('Output', k(t.output))}
          {models.length > 0 && heading('Models this session')}
          {models.map(([m, x]) => share(shortModel(m), totalAll(x), grand, `${x.turns} turns · ${k(x.output)} out`))}
        </Box>
      )
    }

    // --- Value / Cost: API-equivalent cost, against the plan when its price is set ---
    const valueTab = () => {
      const v = hx?.value
      if (!v) return note('No usage recorded yet; it starts with your next reply.')
      const { head, lines, dimFrom } = valueLines(v)
      return (
        <Box flexDirection="column">
          {heading(head)}
          {note(lines[0] ?? '')}
          {row('API-equivalent so far', lines[1]?.replace(/^API-equivalent so far\s+/, '') ?? '', v.priceUsd > 0 && v.spendUsd >= v.priceUsd ? 'green' : undefined)}
          {row('Projected this period', lines[2]?.replace(/^Projected this period\s+/, '') ?? '')}
          {lines.slice(3, dimFrom).map(line => {
            const m = /^(Break-even|Other apps \(estimated\)|Incl\. other apps)\s+(.*)$/.exec(line)
            return m ? row(m[1] ?? '', m[2] ?? '') : note(line)
          })}
          {v.priceUsd > 0 && (
            <Box marginTop={1}>
              {meter('Toward break-even', v.spendUsd, v.priceUsd, `${Math.round((v.spendUsd / v.priceUsd) * 100)}% of ${usd(v.priceUsd)}`, v.spendUsd >= v.priceUsd ? 'green' : 'blue')}
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            {lines.slice(dimFrom).map(line => note(line))}
          </Box>
        </Box>
      )
    }

    // --- History: spans, daily chart, models over 30 days ---
    const historyTab = () => {
      if (!hx || hx.all.turns === 0) return note('Nothing recorded yet; history starts with your next reply.')
      const spanText = (x: Totals) => `${usd(x.costUsd)} · ${x.turns} turns · ${k(x.output)} out · ${x.sessions} sess`
      const maxDayCost = Math.max(0, ...hx.recent.map(r => r.costUsd))
      const maxDayOut = Math.max(0, ...hx.recent.map(r => r.output))
      const byCost = maxDayCost > 0
      const models30 = Object.entries(hx.models30).sort((a, b) => b[1].output - a[1].output)
      const grand30 = models30.reduce((n, [, m]) => n + totalAll(m), 0)
      return (
        <Box flexDirection="column">
          {note(`Since ${shortDate(hx.firstDay ?? dayOf(now))} · ${hx.sync ? `${hx.machines.length} machine${hx.machines.length === 1 ? '' : 's'}` : 'this machine'}`)}
          {heading('Totals')}
          {row('Today', spanText(hx.today))}
          {row('Last 7 days', spanText(hx.week))}
          {row('Last 30 days', spanText(hx.month))}
          {row(`All (≤${KEEP_DAYS}d)`, spanText(hx.all))}
          {hx.month.activeDays > 0 &&
            note(`Average per active day (30d): ${usd(hx.month.costUsd / hx.month.activeDays)} · ${k(Math.round(hx.month.output / hx.month.activeDays))} out`)}
          {heading(`Last ${CHART_DAYS} days (${byCost ? 'cost' : 'output tokens'})`)}
          {[...hx.recent].reverse().map(r => {
            const peak = Object.entries(r.peaks)
              .map(([kind, p]) => `${label(kind)} ${p}%`)
              .join(', ')
            return meter(
              shortDate(r.day),
              byCost ? r.costUsd : r.output,
              (byCost ? maxDayCost : maxDayOut) || 1,
              `${byCost ? usd(r.costUsd) : k(r.output)}${peak ? ` · peak ${peak}` : ''}`,
            )
          })}
          {models30.length > 0 && heading('Models (30 days)')}
          {models30.map(([m, x]) => share(shortModel(m), totalAll(x), grand30, `${x.turns} turns · ${k(x.output)} out`))}
        </Box>
      )
    }

    // --- Machines: per-machine usage and sync health ---
    const machinesTab = () => {
      if (!hx?.sync) return note('Set the sync folder to combine machines.')
      return (
        <Box flexDirection="column">
          {note(`Sync folder: ${hx.sync.folder}`)}
          {hx.sync.error && note(`Sync problem: ${hx.sync.error}`, 'red')}
          {heading('Last 30 days')}
          {hx.machines.map(m =>
            row(
              `${m.machine}${m.isThis ? ' (this machine)' : ''}`,
              `${usd(m.month.costUsd)} · ${m.month.turns} turns${m.updatedAt ? ` · synced ${ago(now - m.updatedAt)} ago` : ''}`,
            ),
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Select key="tab" label="View" options={tabs} value={current} onSelect={value => void update($, tab, () => value)} />
        {hx?.sync?.error && current !== 'machines' && note(`Sync problem: ${hx.sync.error}`, 'red')}
        {current === 'now' && nowTab()}
        {current === 'value' && valueTab()}
        {current === 'history' && historyTab()}
        {current === 'machines' && machinesTab()}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1} columnGap={2}>
          <Text dimColor size="footnote" wrap="truncate-middle">
            Settings: {CONFIGURE}
          </Text>
          {(e.surface === 'terminal' || e.surface === 'desktop') && (
            <Button key="settings" label="Open settings" onPress={() => openSettings($)} />
          )}
        </Box>
      </Box>
    )
  })
}
