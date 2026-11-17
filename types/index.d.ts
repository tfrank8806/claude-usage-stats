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
}
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
  /** Subscription value for the current billing period; absent until a plan price is set. */
  value?: SubscriptionValue
}
/**
 * What the subscription is worth this billing period: the API-equivalent cost of the
 * recorded usage set against the plan's price. Days are local `YYYY-MM-DD`.
 */
export type SubscriptionValue = {
  priceUsd: number
  periodStart: string
  /** The last day of the period, inclusive. */
  periodEnd: string
  periodDays: number
  /** Days of the period up to and including today. */
  daysElapsed: number
  /** API-equivalent cost recorded so far this period, all synced machines. */
  spendUsd: number
  /** spendUsd at this period's pace so far, carried to the period's end. */
  projectedUsd: number
  /** The first day history covers when that is after the period started; earlier days are unrecorded. */
  trackedFrom?: string
  /** The day spend reached the price, or at this pace will; absent when it won't this period. */
  breakEven?: { day: string; isProjected: boolean }
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
    }
  }
}
