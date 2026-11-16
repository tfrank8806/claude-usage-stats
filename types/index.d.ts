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
/** The history the pane draws, summed from $.store. */
export type History = {
  today: Totals
  week: Totals
  month: Totals
  all: Totals
  firstDay?: string
  recent: DayRow[]
  models30: Record<string, ModelTally>
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
    }
  }
}
