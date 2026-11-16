import { expect, mock, test } from 'claude-code/testing'

const NOON = new Date(2026, 10, 16, 12, 0, 0).getTime() // 16 Nov 2026, local noon
const DAY = 864e5
const HISTORY = {
  command: 'usage-stats',
  args: 'history',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

const usage = (model: string, output: number) => ({
  model,
  input_tokens: 100,
  output_tokens: output,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 10,
})

test('history sums turns across sessions and days, counts cost once, and prunes old days', async ($, on) => {
  const clock = mock.clock(on, { now: NOON })
  mock.store(on, {
    // Another session, earlier today, written by this version.
    'day:2026-11-16:other': {
      day: '2026-11-16', turns: 2, input: 200, output: 2000, cacheRead: 0, cacheWrite: 0,
      costUsd: 1.5, byModel: {}, peaks: { five_hour: 40 },
    },
    // Ten days ago: inside 30 days, outside 7.
    'day:2026-11-06:old': {
      day: '2026-11-06', turns: 1, input: 1, output: 500, cacheRead: 0, cacheWrite: 0,
      costUsd: 3, byModel: {}, peaks: {},
    },
    // Past the 180-day keep: pruned, never counted.
    'day:2026-01-01:ancient': {
      day: '2026-01-01', turns: 9, input: 9, output: 9, cacheRead: 0, cacheWrite: 0,
      costUsd: 99, byModel: {}, peaks: {},
    },
    // Not an entry this version wrote: ignored.
    'day:2026-11-15:junk': { hello: 'world' },
  })

  // The session's ledger already holds $0.40 when it starts (a resume): not counted again.
  let cost = 0.4
  on('session.usage', () => ({
    value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 55 }], cost: { usd: cost } },
  }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  let next = usage('claude-opus-5-5', 300)
  on('turn.complete', () => ({ text: '', usage: next }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
  cost = 0.9
  await $.turn.complete(turn)
  cost = 1.4
  next = usage('claude-sonnet-5-5', 200)
  await $.turn.complete(turn)

  const r = await $.command.run({ ...HISTORY })
  const text = (r as { text: string }).text
  const line = (name: string) => text.split('\n').find(l => l.startsWith(name)) ?? ''

  // Today: other session (2 turns, $1.50) + this one (2 turns, $1.00 spent since start).
  expect(line('Today')).toContain('$2.50')
  expect(line('Today')).toContain('4 turns')
  expect(line('Today')).toContain('2 sessions')
  expect(line('Last 7 days')).toContain('$2.50')
  expect(line('Last 30 days')).toContain('$5.50')
  expect(line('Last 30 days')).toContain('3 sessions')
  expect(line('All')).toContain('$5.50')
  expect(text).toContain('since 2026-11-06')

  // The next day, a turn lands under a new day key.
  await clock.set(NOON + DAY)
  cost = 1.9
  await $.turn.complete(turn)
  const r2 = await $.command.run({ ...HISTORY })
  const t2 = (r2 as { text: string }).text
  expect(t2.split('\n').find(l => l.startsWith('Today'))).toContain('$0.50')
  expect(t2.split('\n').find(l => l.startsWith('Last 7 days'))).toContain('$3.00')
})

test('the pane draws history on every surface', async ($, on) => {
  mock.clock(on, { now: NOON })
  mock.store(on, {
    'day:2026-11-16:other': {
      day: '2026-11-16', turns: 2, input: 200, output: 2000, cacheRead: 0, cacheWrite: 0,
      costUsd: 1.5, byModel: { 'claude-opus-5-5': { turns: 2, input: 200, output: 2000, cacheRead: 0, cacheWrite: 0 } },
      peaks: { five_hour: 40 },
    },
  })
  on('session.usage', () => ({ value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-stats',
      component: 'Pane',
      requestId: 'usage-stats',
      surface,
      props: { title: 'Claude usage', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^History/ }))?.text).toContain('since 2026-11-16')
    expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toContain('$1.50')
    expect((await ui.find({ type: 'Text', text: /^opus-5-5/ }))?.text).toContain('100%')
    expect((await ui.find({ type: 'Text', text: /^11-16/ }))?.text).toContain('peak 5-hour 40%')
    await ui.unmount()
  }
})
