import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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

test(
  'a sync folder combines machines, counts a session once, and writes this machine its own file',
  { options: { syncFolder: '~/Dropbox/cu', machineName: 'laptop' } },
  async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    const DIR = '/home/t/Dropbox/cu'
    const entry = (costUsd: number) => ({
      day: '2026-11-16', turns: 1, input: 10, output: 100, cacheRead: 0, cacheWrite: 0,
      costUsd, byModel: {}, peaks: {},
    })
    const desk = { version: 1, machineId: 'desk0001', machine: 'desktop', updatedAt: NOON - 3600e3, entries: { 'day:2026-11-16:s-desk': entry(2) } }
    const files: Record<string, string> = {
      [`${DIR}/usage-desk0001.json`]: JSON.stringify(desk),
      // A sync service's conflicted copy: not a name this plugin reads.
      [`${DIR}/usage-desk0001 (conflicted copy).json`]: JSON.stringify(desk),
      // Another machine's file holding the same session: counted once.
      [`${DIR}/usage-dupe0001.json`]: JSON.stringify({ ...desk, machineId: 'dupe0001', machine: 'old-name' }),
      [`${DIR}/usage-bad00001.json`]: '{ not json',
      [`${DIR}/notes.txt`]: 'hello',
    }
    const writes: string[] = []
    mock.store(on, { 'day:2026-11-16:me-earlier': entry(1.5) })
    const runs: string[][] = []
    on('process.run', (_, e) => (runs.push([...e.argv]), { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
    on('fs.write', (_, e) => {
      files[e.path] = e.text
      writes.push(e.path)
      return { value: undefined }
    })
    on('fs.list', (_, e) => ({
      value: Object.keys(files)
        .filter(p => p.startsWith(`${e.path}/`))
        .map(p => ({ name: p.slice(DIR.length + 1), kind: 'file' as const, size: files[p]!.length, mtimeMs: 0, isLink: false })),
    }))
    on('fs.read', (_, e) => {
      const text = files[e.path]
      if (text === undefined) throw new Error('ENOENT')
      return { value: text }
    })
    on('session.usage', () => ({ value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
    on('session.id', () => ({ value: 'me' }))
    on('command.register', () => ({ value: { command: 'usage-stats' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.status', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.end', () => ({ sessionId: 'me' }))
    on('turn.complete', () => ({ text: '', usage: usage('claude-opus-5-5', 10) }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    // This machine wrote its own file, named by its id, holding its entries.
    expect(writes.length).toBe(1)
    const mine = writes[0]!
    expect(mine).toMatch(/^\/home\/t\/Dropbox\/cu\/usage-[a-z0-9]{12}\.json$/)
    const written = JSON.parse(files[mine]!)
    expect(written.machine).toBe('laptop')
    expect(Object.keys(written.entries)).toEqual(['day:2026-11-16:me-earlier'])
    // Readable by the group, so another machine's user can read it through a share.
    expect(runs).toEqual([['chmod', 'g+r', mine]])

    const r = await $.command.run({ ...HISTORY })
    const text = (r as { text: string }).text
    const line = (start: string) => text.split('\n').find(l => l.startsWith(start)) ?? ''
    expect(text).toContain('3 machines')
    // $1.50 here + $2.00 on the desktop; the duplicate and the conflicted copy add nothing.
    expect(line('Today')).toContain('$3.50')
    expect(line('Today')).toContain('2 sessions')
    expect(line('* laptop')).toContain('$1.50')
    expect(line('  desktop')).toContain('$2.00')
    expect(line('  desktop')).toContain('synced 1h 0m ago')
    expect(text).toContain('Sync problem: skipped usage-bad00001.json')
    expect(text).not.toContain('notes.txt')

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'usage-stats',
        component: 'Pane',
        requestId: 'usage-stats',
        surface,
        props: { title: 'Claude usage', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
      })
      expect((await ui.find({ type: 'Text', text: /^History/ }))?.text).toContain('3 machines')
      expect((await ui.find({ type: 'Text', text: /^\* laptop/ }))?.text).toContain('(this machine)')
      expect((await ui.find({ type: 'Text', text: /^ {2}desktop/ }))?.text).toContain('synced 1h 0m ago')
      expect((await ui.find({ type: 'Text', text: /^Sync problem/ }))?.text).toContain('usage-bad00001.json')
      await ui.unmount()
    }

    // A turn within two minutes doesn't rewrite the file; the refresh at the two-minute mark
    // writes what changed, a later turn inside that window waits, and the end always writes.
    const before = writes.length
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    expect(writes.length).toBe(before)
    await clock.advance(3 * 60 * 1000)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    expect(writes.length).toBe(before + 1)
    expect(Object.keys(JSON.parse(files[mine]!).entries)).toContain('day:2026-11-16:me')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'me', resume: { id: 'me' } })
    expect(writes.length).toBe(before + 2)
  },
)

test('without a sync folder nothing is written outside the store', async ($, on) => {
  mock.clock(on, { now: NOON })
  mock.store(on, {})
  const writes: string[] = []
  on('fs.write', (_, e) => (writes.push(e.path), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.id', () => ({ value: 'me' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'me' }))
  on('turn.complete', () => ({ text: '', usage: usage('claude-opus-5-5', 10) }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  const text = ((await $.command.run({ ...HISTORY })) as { text: string }).text
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'me', resume: { id: 'me' } })
  expect(writes).toEqual([])
  expect(text).toContain('this machine')
  expect(text).toContain('Set the syncFolder option')
})

test(
  'on a Windows sync folder the file is written there and no chmod runs',
  { options: { syncFolder: 'S:\\files\\Claude Sync Folder', machineName: 'laptop' } },
  async ($, on) => {
    mock.clock(on, { now: NOON })
    mock.store(on, {})
    const writes: string[] = []
    const runs: string[][] = []
    on('fs.write', (_, e) => (writes.push(e.path), { value: undefined }))
    on('fs.list', () => ({ value: [] }))
    on('process.run', (_, e) => (runs.push([...e.argv]), { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('env.get', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
    on('session.id', () => ({ value: 'me' }))
    on('command.register', () => ({ value: { command: 'usage-stats' } }))
    on('ui.status', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(writes.length).toBe(1)
    // A Linux test host reads `S:\\…` as relative and puts its own directory before it; on
    // Windows it is the absolute path. Either way the file is in the folder, by this machine's id.
    expect(writes[0]).toMatch(/S:\\files\\Claude Sync Folder\\usage-[a-z0-9]{12}\.json$/)
    expect(runs).toEqual([])
  },
)

test(
  'while idle the pane picks up another machine, and an unchanged file is not rewritten until the heartbeat',
  { options: { syncFolder: '/sync', machineName: 'laptop' } },
  async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    mock.store(on, {
      'day:2026-11-16:mine': {
        day: '2026-11-16', turns: 1, input: 1, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 1, byModel: {}, peaks: {},
      },
    })
    const files: Record<string, string> = {}
    const writes: number[] = []
    on('fs.write', (_, e) => {
      files[e.path] = e.text
      writes.push(clock.now())
      return { value: undefined }
    })
    on('fs.list', () => ({
      value: Object.keys(files).map(p => ({ name: p.slice('/sync/'.length), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
    }))
    on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('env.get', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
    on('session.id', () => ({ value: 'me' }))
    on('command.register', () => ({ value: { command: 'usage-stats' } }))
    on('ui.status', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(writes).toEqual([NOON])

    // Another machine's file lands while this one is idle: no turn, no command.
    files['/sync/usage-desk0001.json'] = JSON.stringify({
      version: 1, machineId: 'desk0001', machine: 'desktop', updatedAt: NOON,
      entries: { 'day:2026-11-16:s-desk': { day: '2026-11-16', turns: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 2, byModel: {}, peaks: {} } },
    })
    await clock.advance(2 * 60 * 1000)

    const ui = await $.ui.mount({
      plugin: 'usage-stats',
      component: 'Pane',
      requestId: 'usage-stats',
      surface: 'desktop',
      props: { title: 'Claude usage', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^History/ }))?.text).toContain('2 machines')
    expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toContain('$3.00')
    await ui.unmount()

    // Nothing changed here, so idle refreshes don't rewrite this machine's file...
    await clock.advance(20 * 60 * 1000)
    expect(writes).toEqual([NOON])
    // ...until the half-hourly heartbeat.
    await clock.advance(12 * 60 * 1000)
    expect(writes.length).toBe(2)
    expect(writes[1]! - NOON).toBeGreaterThanOrEqual(30 * 60 * 1000)
    expect(writes[1]! - NOON).toBeLessThanOrEqual(33 * 60 * 1000)
  },
)

test('a non-interactive session starts no refresh timer', { options: { syncFolder: '/sync' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOON })
  mock.store(on, {})
  let usageCalls = 0
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => (usageCalls++, { value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const after = usageCalls
  await clock.advance(10 * 60 * 1000)
  expect(usageCalls).toBe(after)
})

const day = (d: string, costUsd: number) => ({
  day: d, turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd, byModel: {}, peaks: {},
})
const valueText = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  store: Record<string, unknown>,
) => {
  mock.clock(on, { now: NOON })
  mock.store(on, store)
  on('session.usage', () => ({ value: { startedAt: NOON, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const r = await $.command.run({ ...HISTORY, args: 'value' })
  return (r as { text: string }).text
}
const STORE = {
  'day:2026-11-01:a': day('2026-11-01', 999), // before the period: not counted
  'day:2026-11-06:b': day('2026-11-06', 50),
  'day:2026-11-10:c': day('2026-11-10', 60), // cumulative $110 passes $100 here
  'day:2026-11-16:d': day('2026-11-16', 20),
}

test('value: spend, multiple, projection and break-even reached', { options: { subscriptionUsd: 100, billingDay: 5 } }, async ($, on) => {
  const text = await valueText($, on, STORE)
  expect(text).toContain('Plan $100.00/mo · Nov 5 – Dec 4 (day 12 of 30)')
  expect(text).toContain('API-equivalent so far  $130.00  = 1.30× the plan')
  // $130 over 12 days, carried to 30: 130 + 130/12 × 18 = 325.
  expect(text).toContain('Projected this period  $325.00  = 3.25×')
  expect(text).toContain('Break-even            reached Nov 10')
  expect(text).not.toContain('Recorded since')
})

test('value: projected break-even, and none when the pace falls short', { options: { subscriptionUsd: 200, billingDay: 5 } }, async ($, on) => {
  const text = await valueText($, on, STORE)
  // $70 to go at $130/12 a day: ceil(6.46) = 7 days after Nov 16.
  expect(text).toContain('Break-even            ~Nov 23 at this pace')
})

test('value: a price the pace never reaches', { options: { subscriptionUsd: 1000, billingDay: 5 } }, async ($, on) => {
  const text = await valueText($, on, STORE)
  expect(text).toContain('not this period at this pace')
})

test('value: a late install paces on recorded days only and says so', { options: { subscriptionUsd: 100, billingDay: 5 } }, async ($, on) => {
  const { 'day:2026-11-01:a': _, ...late } = STORE
  const text = await valueText($, on, late)
  // Recorded Nov 6–16 (11 days): 130 + 130/11 × 18 = 342.73.
  expect(text).toContain('Projected this period  $342.73')
  expect(text).toContain("Recorded since Nov 6 only; earlier days of this period aren't counted.")
})

test('value: a billing day past the month end renews on its last day', { options: { subscriptionUsd: 100, billingDay: 31 } }, async ($, on) => {
  const text = await valueText($, on, STORE)
  // November has 30 days, so the period runs Oct 31 – Nov 29.
  expect(text).toContain('Oct 31 – Nov 29 (day 17 of 30)')
})

test('value: with no price, the API-equivalent cost for the calendar month and a hint', async ($, on) => {
  const text = await valueText($, on, STORE)
  // No billing day either: the period is November. Nov 1 now counts: 999 + 50 + 60 + 20.
  expect(text).toContain('API-equivalent cost')
  expect(text).toContain('This month · Nov 1 – Nov 30 (day 16 of 30)')
  expect(text).toContain('API-equivalent so far  $1129.00\n')
  // 1129 over 16 days, carried to 30: 1129 + 1129/16 × 14 = 2116.875.
  expect(text).toContain('Projected this period  $2116.88\n')
  expect(text).not.toContain('×')
  expect(text).not.toContain('Break-even')
  expect(text).toContain('Add your plan price to compare: /plugin configure usage-stats@claude-usage-stats')
})

test('value: a billing day without a price measures that period', { options: { billingDay: 5 } }, async ($, on) => {
  const text = await valueText($, on, STORE)
  expect(text).toContain('Billing period · Nov 5 – Dec 4 (day 12 of 30)')
  expect(text).toContain('API-equivalent so far  $130.00\n')
  expect(text).not.toContain('Break-even')
})

test('value: with no price the pane shows the cost, no break-even bar, on every surface', async ($, on) => {
  await valueText($, on, STORE)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-stats',
      component: 'Pane',
      requestId: 'usage-stats',
      surface,
      props: { title: 'Claude usage', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 90 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^API-equivalent cost$/ }))?.text).toBe('API-equivalent cost')
    expect((await ui.find({ type: 'Text', text: /^API-equivalent so far/ }))?.text).toBe('API-equivalent so far  $1129.00')
    expect((await ui.find({ type: 'Text', text: /^Add your plan price/ }))?.text).toContain('/plugin configure')
    expect(await ui.find({ type: 'Text', text: /of break-even$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Subscription value/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('value: the pane draws the section on every surface', { options: { subscriptionUsd: 100, billingDay: 5 } }, async ($, on) => {
  await valueText($, on, STORE)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-stats',
      component: 'Pane',
      requestId: 'usage-stats',
      surface,
      props: { title: 'Claude usage', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 90 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^Subscription value/ }))?.text).toBe('Subscription value')
    expect((await ui.find({ type: 'Text', text: /^API-equivalent so far/ }))?.text).toContain('1.30×')
    expect((await ui.find({ type: 'Text', text: /of break-even$/ }))?.text).toContain('130% of break-even')
    await ui.unmount()
  }
})
