import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DayEntry,
  DayRow,
  History,
  Ledger,
  Limit,
  ModelTally,
  Sample,
  Snapshot,
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

const snapshot = atom({ plugin: 'usage-stats', key: 'snapshot' } as const, null, { shape: 'snap-2' })
const tokens = atom({ plugin: 'usage-stats', key: 'tokens' } as const, ZERO, { shape: 'tok-2' })
const samples = atom({ plugin: 'usage-stats', key: 'samples' } as const, {}, { shape: 'samp-1' })
const history = atom({ plugin: 'usage-stats', key: 'history' } as const, null, { shape: 'hist-1' })
const ledger = atom({ plugin: 'usage-stats', key: 'ledger' } as const, null, { shape: 'ledger-1' })

const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const bar = (p: number, w = 20) => {
  const f = Math.max(0, Math.min(w, Math.round((p / 100) * w)))
  return '█'.repeat(f) + '░'.repeat(w - f)
}
const dur = (ms: number) => {
  const hrs = Math.floor(ms / 3.6e6)
  const m = Math.floor((ms % 3.6e6) / 6e4)
  return hrs >= 24 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : hrs > 0 ? `${hrs}h ${m}m` : `${m}m`
}
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

// Sum every stored entry into what the pane draws, pruning entries past KEEP_DAYS.
async function loadHistory($: EngineInterface, now: number) {
  const keys = (await $.store.keys()).filter(key => key.startsWith(DAY_PREFIX))
  const today = dayOf(now)
  const weekFrom = daysBefore(now, 6)
  const monthFrom = daysBefore(now, 29)
  const chartFrom = daysBefore(now, CHART_DAYS - 1)
  const pruneBefore = daysBefore(now, KEEP_DAYS)

  const spans = { today: { ...NO_TOTALS }, week: { ...NO_TOTALS }, month: { ...NO_TOTALS }, all: { ...NO_TOTALS } }
  const daysSeen = { today: new Set<string>(), week: new Set<string>(), month: new Set<string>(), all: new Set<string>() }
  const rows: Record<string, DayRow> = {}
  const models30: Record<string, ModelTally> = {}
  let firstDay: string | undefined

  for (const key of keys) {
    const entry = asEntry(await $.store.get(key))
    if (!entry) continue
    if (entry.day < pruneBefore) {
      await $.store.delete(key)
      continue
    }
    if (!firstDay || entry.day < firstDay) firstDay = entry.day
    const inSpan = {
      today: entry.day === today,
      week: entry.day >= weekFrom,
      month: entry.day >= monthFrom,
      all: true,
    }
    for (const name of ['today', 'week', 'month', 'all'] as const) {
      if (!inSpan[name]) continue
      const t = spans[name]
      spans[name] = { ...sum(t, entry), costUsd: t.costUsd + entry.costUsd, sessions: t.sessions + 1, activeDays: 0 }
      daysSeen[name].add(entry.day)
    }
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
  for (const name of ['today', 'week', 'month', 'all'] as const) spans[name].activeDays = daysSeen[name].size

  // One row per calendar day in the chart, empty days included, oldest first.
  const recent: DayRow[] = []
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const day = daysBefore(now, i)
    recent.push(rows[day] ?? { day, costUsd: 0, output: 0, turns: 0, sessions: 0, peaks: {} })
  }
  const hx: History = { ...spans, firstDay, recent, models30 }
  await update($, history, () => hx)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-stats',
      description: 'Open the Claude usage stats pane (add "history" for a text summary of past usage)',
    })
    const now = await $.clock.now()
    const u = await $.session.usage()
    const s = toSnapshot(u, now)
    await update($, snapshot, () => s)
    // Cost already on the ledger (a resumed session) was counted when it was spent.
    await update($, ledger, l => l ?? { lastCostUsd: u.cost?.usd ?? 0 })
    await recordSamples($, s.limits, now)
    await loadHistory($, now)
    $.ui.status(statusText(s, (await read($, samples)) ?? {}, now))
    return next(e)
  })

  on('command.run', { command: 'usage-stats' }, async ($, e) => {
    const now = await $.clock.now()
    const s = toSnapshot(await $.session.usage(), now)
    await update($, snapshot, () => s)
    await recordSamples($, s.limits, now)
    await loadHistory($, now)
    await $.ui.open({ id: PANE, title: 'Claude usage' })
    if (e.args.trim() === 'history') {
      const hx = await read($, history)
      if (!hx || hx.all.turns === 0) return { text: 'No usage history recorded yet; it starts with your next reply.' }
      const line = (name: string, t: Totals) =>
        `${name.padEnd(13)} ${usd(t.costUsd).padStart(9)}  ${String(t.turns).padStart(5)} turns  ${k(t.output).padStart(7)} out  ${t.sessions} sessions`
      return {
        text: [
          `Usage history (since ${hx.firstDay ?? 'today'})`,
          line('Today', hx.today),
          line('Last 7 days', hx.week),
          line('Last 30 days', hx.month),
          line(`All (${KEEP_DAYS}d max)`, hx.all),
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
      await loadHistory($, now)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const t = (await read($, tokens)) ?? ZERO
    const hist = (await read($, samples)) ?? {}
    const hx = await read($, history)
    const now = await $.clock.now()
    const models = Object.entries(t.byModel).sort((a, b) => b[1].output - a[1].output)
    const totalAll = (m: ModelTally) => m.input + m.output + m.cacheRead + m.cacheWrite
    const grand = totalAll(t)
    const elapsedHr = s ? (now - s.startedAt) / 3.6e6 : 0
    const models30 = Object.entries(hx?.models30 ?? {}).sort((a, b) => b[1].output - a[1].output)
    const grand30 = models30.reduce((n, [, m]) => n + totalAll(m), 0)
    const maxDayCost = Math.max(0, ...(hx?.recent ?? []).map(r => r.costUsd))
    const maxDayOut = Math.max(0, ...(hx?.recent ?? []).map(r => r.output))
    const chartByCost = maxDayCost > 0
    const span = (name: string, x: Totals) => (
      <Text>
        {name.padEnd(13)} {usd(x.costUsd).padStart(9)} {String(x.turns).padStart(5)} turns {k(x.output).padStart(7)} out{' '}
        {String(x.sessions).padStart(3)} sess
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text bold>Plan limits</Text>
        {(!s || s.limits.length === 0) && (
          <Text dimColor>No rate-limit readings: this session isn't reporting plan limits, so no ETA.</Text>
        )}
        {s?.limits.map(l => {
          const eta = projectEta(l, hist[l.kind], now)
          const reset = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
          return (
            <Box flexDirection="column">
              <Text>
                {label(l.kind).padEnd(8)} {bar(l.percentUsed)} {l.percentUsed}%
              </Text>
              <Text dimColor>
                {'         '}
                {Number.isFinite(reset) ? (reset > 0 ? `resets in ${dur(reset)}` : 'resetting') : ''}
              </Text>
              <Text color={eta.kind === 'hit' ? 'red' : undefined} dimColor={eta.kind !== 'hit'}>
                {'         '}
                {eta.kind === 'none' && `ETA: ${eta.why}`}
                {eta.kind === 'safe' && `pace ${eta.ratePerHr.toFixed(1)}%/h: won't hit before reset`}
                {eta.kind === 'hit' &&
                  (eta.inMs === 0
                    ? 'limit reached'
                    : `pace ${eta.ratePerHr.toFixed(1)}%/h: full ~${clock(eta.at)} (in ${dur(eta.inMs)})` +
                      (eta.beforeResetBy ? `, ${dur(eta.beforeResetBy)} before reset` : ''))}
              </Text>
            </Box>
          )
        })}
        <Text> </Text>
        <Text bold>Models used (this session)</Text>
        {models.length === 0 && <Text dimColor>No completed turns yet.</Text>}
        {models.map(([m, x]) => (
          <Box flexDirection="column">
            <Text>
              {shortModel(m).padEnd(18)} {bar(pct(totalAll(x), grand), 12)} {pct(totalAll(x), grand)}% of tokens
            </Text>
            <Text dimColor>
              {'  '}
              {x.turns} turns · in {k(x.input)} · out {k(x.output)} · cache {k(x.cacheRead + x.cacheWrite)}
            </Text>
          </Box>
        ))}
        <Text> </Text>
        <Text bold>Context window</Text>
        {s?.contextPercent !== undefined ? (
          <Text>
            {bar(s.contextPercent)} {s.contextPercent}% ({k(s.contextTokens ?? 0)} / {k(s.contextWindow)})
          </Text>
        ) : (
          <Text dimColor>No reading yet.</Text>
        )}
        <Text> </Text>
        <Text bold>This session</Text>
        <Text>
          Cost      {s?.costUsd !== undefined ? usd(s.costUsd) : 'n/a'}
          {s?.costUsd !== undefined && elapsedHr > 0.05 ? `  (~${usd(s.costUsd / elapsedHr)}/h over ${dur(now - s.startedAt)})` : ''}
        </Text>
        <Text>Turns     {t.turns}</Text>
        <Text>Input     {k(t.input)}  (cache read {k(t.cacheRead)}, write {k(t.cacheWrite)})</Text>
        <Text>Output    {k(t.output)}</Text>
        <Text> </Text>
        <Text bold>History{hx?.firstDay ? ` (since ${hx.firstDay}, this machine)` : ''}</Text>
        {(!hx || hx.all.turns === 0) && <Text dimColor>Nothing recorded yet; history starts with your next reply.</Text>}
        {hx && hx.all.turns > 0 && (
          <Box flexDirection="column">
            {span('Today', hx.today)}
            {span('Last 7 days', hx.week)}
            {span('Last 30 days', hx.month)}
            {span(`All (≤${KEEP_DAYS}d)`, hx.all)}
            {hx.month.activeDays > 0 && (
              <Text dimColor>
                Avg per active day (30d): {usd(hx.month.costUsd / hx.month.activeDays)} · {k(Math.round(hx.month.output / hx.month.activeDays))} out
              </Text>
            )}
            <Text> </Text>
            <Text bold>Last {CHART_DAYS} days ({chartByCost ? 'cost' : 'output tokens'})</Text>
            {hx.recent.map(r => {
              const v = chartByCost ? r.costUsd : r.output
              const max = chartByCost ? maxDayCost : maxDayOut
              const peak = Object.entries(r.peaks)
                .map(([kind, p]) => `${label(kind)} ${p}%`)
                .join(' ')
              return (
                <Text dimColor={r.turns === 0}>
                  {r.day.slice(5)} {bar(pct(v, max), 16)} {chartByCost ? usd(r.costUsd).padStart(8) : k(r.output).padStart(7)}
                  {peak ? `  peak ${peak}` : ''}
                </Text>
              )
            })}
            <Text> </Text>
            <Text bold>Models used (last 30 days)</Text>
            {models30.map(([m, x]) => (
              <Text>
                {shortModel(m).padEnd(18)} {bar(pct(totalAll(x), grand30), 12)} {pct(totalAll(x), grand30)}% · {x.turns} turns ·{' '}
                {k(x.output)} out
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
