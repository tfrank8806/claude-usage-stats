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

declare module 'claude-code' {
  interface PluginState {
    'usage-stats': {
      snapshot: Shaped<Snapshot | null>
      tokens: Shaped<Tokens>
      samples: Shaped<Record<string, Sample[]>>
    }
  }
}
