export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Snapshot = {
  startedAt: number
  limits: Limit[]
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
}
export type ModelTally = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export type Tokens = ModelTally & { byModel: Record<string, ModelTally> }
/** One reading of a rate-limit window: when, how full, and which reset it belongs to. */
export type Sample = { t: number; pct: number; resetsAt?: string }

/** One session's usage on one local calendar day, as kept in $.store under `day:<YYYY-MM-DD>:<sessionId>`. */
export type DayEntry = ModelTally & {
  day: string
  costUsd: number
  byModel: Record<string, ModelTally>
  /** Highest % used seen for each rate-limit window that day. */
  peaks: Record<string, number>
}
/** Usage summed over a span of days. */
export type Totals = ModelTally & { costUsd: number; sessions: number; activeDays: number }
/** One day's row in the daily chart. */
export type DayRow = { day: string; costUsd: number; output: number; turns: number; sessions: number; peaks: Record<string, number> }
/**
 * One machine's file in the shared sync folder, `usage-<machineId>.json`.
 * Only that machine ever writes it, so file-sync services never see two writers.
 */
export type MachineFile = {
  version: 1
  machineId: string
  machine: string
  updatedAt: number
  /** Its store entries, keyed as in the store (`day:<YYYY-MM-DD>:<sessionId>`). */
  entries: Record<string, DayEntry>
  /** Its estimates of other apps' usage, by `<kind>|<window>`; absent from older versions. */
  other?: Record<string, OtherEstimate>
}
/**
 * One rate-limit window as this machine saw it: its first and last readings, each with the
 * Claude Code cost recorded (all synced machines) at that moment.
 */
export type LimitWindow = {
  kind: string
  /** The window's reset time, rounded to ten minutes: the same window on every machine. */
  key: string
  /** Local day of the last reading. */
  day: string
  firstPct: number
  firstCc: number
  lastPct: number
  lastCc: number
  lastAt: number
}
/** Dollars of Claude Code cost per point of one limit kind, learned from readings minutes apart. */
export type Calibration = {
  costUsd: number
  points: number
  last?: { key: string; pct: number; cc: number; at: number }
}
/** Estimated usage outside Claude Code (claude.ai, desktop, mobile) within one limit window. */
export type OtherEstimate = { kind: string; day: string; usd: number }
/** Where the other-apps estimate stands, for the value section. */
export type OtherStatus =
  | { state: 'none' }
  | { state: 'calibrating'; points: number; needed: number }
  | { state: 'ok'; kind: string; usdPerPoint: number; usd: number }
/** One machine's line in the per-machine breakdown. */
export type MachineRow = {
  machineId: string
  machine: string
  isThis: boolean
  /** When its file was last written; absent for this machine (always current). */
  updatedAt?: number
  month: Totals
  all: Totals
}
/** Where sync stands: the folder, when it last ran, and what went wrong if it failed. */
export type SyncStatus = { folder: string; lastAt?: number; error?: string }
/** The history the pane draws, summed from $.store and the sync folder. */
export type History = {
  today: Totals
  week: Totals
  month: Totals
  all: Totals
  firstDay?: string
  recent: DayRow[]
  models30: Record<string, ModelTally>
  machines: MachineRow[]
  sync?: SyncStatus
  /** Claude Code cost of every retained entry, all machines: the running total limit readings are paired with. */
  ccTotalUsd: number
  /** API-equivalent cost this billing period (the calendar month without a billing day), against the plan when its price is set. */
  value?: SubscriptionValue
}
/**
 * The API-equivalent cost of recorded usage this billing period, set against the plan's
 * price when one is set (`priceUsd` 0 means none). Days are local `YYYY-MM-DD`.
 */
export type SubscriptionValue = {
  priceUsd: number
  periodStart: string
  /** The last day of the period, inclusive. */
  periodEnd: string
  periodDays: number
  /** Days of the period up to and including today. */
  daysElapsed: number
  /** True when no billing day is set, so the period is simply the calendar month. */
  isCalendarMonth: boolean
  /** API-equivalent cost recorded so far this period, all synced machines. */
  spendUsd: number
  /** spendUsd at this period's pace so far, carried to the period's end. */
  projectedUsd: number
  /** The first day history covers when that is after the period started; earlier days are unrecorded. */
  trackedFrom?: string
  /** The day spend reached the price, or at this pace will; absent when it won't this period. */
  breakEven?: { day: string; isProjected: boolean }
  /** Estimated usage outside Claude Code this period, from plan-limit movement. */
  other: OtherStatus
}
/** What this session has already written to history, so each turn adds only what is new. */
export type Ledger = { lastCostUsd: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-stats': {
      snapshot: Shaped<Snapshot | null>
      tokens: Shaped<Tokens>
      samples: Shaped<Record<string, Sample[]>>
      history: Shaped<History | null>
      ledger: Shaped<Ledger | null>
      /** Other machines' files as last read from the sync folder, by machine id. */
      remote: Shaped<Record<string, MachineFile>>
      sync: Shaped<SyncStatus | null>
      /** Which view of the pane is showing: now, value, history or machines. */
      tab: Shaped<string>
    }
  }
}
