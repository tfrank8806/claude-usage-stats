import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, ModelTally, Sample, Snapshot, Tokens } from '../types'

const PANE = 'usage-stats'
const EMPTY: ModelTally = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const ZERO: Tokens = { ...EMPTY, byModel: {} }
const PACE_WINDOW_MS = 60 * 60 * 1000 // judge the burn rate on the last hour of readings

const snapshot = atom({ plugin: 'usage-stats', key: 'snapshot' } as const, null, { shape: 'snap-2' })
const tokens = atom({ plugin: 'usage-stats', key: 'tokens' } as const, ZERO, { shape: 'tok-2' })
const samples = atom({ plugin: 'usage-stats', key: 'samples' } as const, {}, { shape: 'samp-1' })

const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const bar = (p: number, w = 20) => {
  const f = Math.max(0, Math.min(w, Math.round((p / 100) * w)))
  return '█'.repeat(f) + '░'.repeat(w - f)
}
const dur = (ms: number) => {
  const h = Math.floor(ms / 3.6e6)
  const m = Math.floor((ms % 3.6e6) / 6e4)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}
const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// Short model name: "claude-opus-5-5-20261001" -> "opus-5-5"
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

type Eta =
  | { kind: 'none'; why: string }
  | { kind: 'safe'; resetIn: number; ratePerHr: number }
  | { kind: 'hit'; at: number; inMs: number; ratePerHr: number; beforeResetBy?: number }

/** Linear projection of when a window reaches 100%, from readings in its current reset period. */
const projectEta = (l: Limit, history: Sample[] | undefined, now: number): Eta => {
  if (l.percentUsed >= 100) return { kind: 'hit', at: now, inMs: 0, ratePerHr: 0 }
  const period = (history ?? []).filter(s => s.resetsAt === l.resetsAt)
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
  if (s.costUsd !== undefined) parts.push(`$${s.costUsd.toFixed(2)}`)
  return parts.length ? parts.join(' · ') : undefined
}

const toSnapshot = (u: {
  startedAt?: number
  rateLimits: Limit[]
  context: { tokens?: number; window: number; percent?: number }
  cost?: { usd: number }
}, startedAt: number): Snapshot => ({
  startedAt: u.startedAt ?? startedAt,
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  costUsd: u.cost?.usd,
})

const add = (a: ModelTally, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): ModelTally => ({
  turns: a.turns + 1,
  input: a.input + u.input_tokens,
  output: a.output + u.output_tokens,
  cacheRead: a.cacheRead + u.cache_read_input_tokens,
  cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
})

// Record a reading for each window, dropping readings from earlier reset periods.
async function record($: EngineInterface, limits: Limit[], now: number) {
  if (limits.length === 0) return
  await update($, samples, h => {
    const next: Record<string, Sample[]> = { ...(h ?? {}) }
    for (const l of limits) {
      const kept = (next[l.kind] ?? []).filter(s => s.resetsAt === l.resetsAt)
      const lastS = kept[kept.length - 1]
      if (!lastS || lastS.pct !== l.percentUsed) kept.push({ t: now, pct: l.percentUsed, resetsAt: l.resetsAt })
      next[l.kind] = kept.slice(-200)
    }
    return next
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-stats', description: 'Open the Claude usage stats pane' })
    const now = await $.clock.now()
    const u = await $.session.usage()
    const s = toSnapshot(u, now)
    await update($, snapshot, () => s)
    await record($, s.limits, now)
    $.ui.status(statusText(s, (await read($, samples)) ?? {}, now))
    return next(e)
  })

  on('command.run', { command: 'usage-stats' }, async $ => {
    const now = await $.clock.now()
    const s = toSnapshot(await $.session.usage(), now)
    await update($, snapshot, () => s)
    await record($, s.limits, now)
    await $.ui.open({ id: PANE, title: 'Claude usage' })
    return { text: statusText(s, (await read($, samples)) ?? {}, now) ?? 'Usage pane opened; figures appear after the first reply.' }
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const prev = await read($, snapshot)
    const s = toSnapshot(e, prev?.startedAt ?? now)
    await update($, snapshot, () => s)
    await record($, s.limits, now)
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
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const t = (await read($, tokens)) ?? ZERO
    const hist = (await read($, samples)) ?? {}
    const now = await $.clock.now()
    const models = Object.entries(t.byModel).sort((a, b) => b[1].output - a[1].output)
    const totalAll = (m: ModelTally) => m.input + m.output + m.cacheRead + m.cacheWrite
    const grand = totalAll(t)
    const elapsedHr = s ? (now - s.startedAt) / 3.6e6 : 0

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
        <Text bold>Models used</Text>
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
          Cost      {s?.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : 'n/a'}
          {s?.costUsd !== undefined && elapsedHr > 0.05 ? `  (~$${(s.costUsd / elapsedHr).toFixed(2)}/h over ${dur(now - s.startedAt)})` : ''}
        </Text>
        <Text>Turns     {t.turns}</Text>
        <Text>Input     {k(t.input)}  (cache read {k(t.cacheRead)}, write {k(t.cacheWrite)})</Text>
        <Text>Output    {k(t.output)}</Text>
      </Box>
    )
  })
}
