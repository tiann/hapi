/**
 * Parses the ISO-8601 `timestamp` field emitted by the Claude CLI's
 * sdkToLogConverter (e.g. `"2026-07-13T14:37:57.372Z"`) into epoch
 * milliseconds. This is the execution-machine wall clock at the moment the
 * CLI stamped the SDK message, as opposed to the hub's receive time.
 *
 * Returns null for missing/non-string/unparseable values so callers can
 * fall back to the hub-received `createdAt` instead.
 */
export function parseAgentTimestampMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}
