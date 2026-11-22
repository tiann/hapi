/**
 * Interval between periodic session keep-alive heartbeats.
 * Kept in a zero-side-effect module so lightweight agent wrappers can share
 * the constant without pulling in socket/child_process imports at module load.
 */
export const SESSION_KEEP_ALIVE_INTERVAL_MS = 10_000
