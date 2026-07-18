export const RUNNER_TIMING = {
  drainMs: 1_000,
  intentFlushMs: 1_000,
  termGraceMs: 6_000,
  killSettlementMs: 2_000,
  finalFlushMs: 2_000,
  watchdogMs: 15_000,
  externalEscalationMs: 16_000,
  lockDeadlineMs: 18_000,
  launchdExitTimeoutSeconds: 20,
  reconciliationMs: 10_000
} as const;

export const RECONCILIATION_DEFAULTS = {
  mode: 'report' as const,
  killSwitch: false,
  killCap: 4,
  failureThreshold: 3,
  failureWindowMs: 10 * 60_000,
  healthyResetMs: 30 * 60_000
} as const;

export type ReconciliationMode = 'off' | 'report' | 'enforce';
