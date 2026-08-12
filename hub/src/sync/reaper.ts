/**
 * Zombie-session reaper.
 *
 * A session is a "zombie" when the CLI connection has dropped (`active ===
 * false`) but the persisted `metadata.lifecycleState` is still `'running'` —
 * this happens when the CLI process is killed outright (SIGHUP/SIGKILL,
 * hub-restart cascades, crashes) with no chance to run its own
 * archive-on-exit path. Left alone these rows show as "still running"
 * forever in web UI.
 *
 * The reaper periodically sweeps for sessions disconnected past a
 * staleness threshold and archives them via the same hub-side metadata
 * path `archiveSession()` uses when the CLI is unreachable
 * (`SessionCache.markSessionArchivedFromHub`, versioned write +
 * `session-updated` broadcast) — just with a distinct `archivedBy` so the
 * two origins stay distinguishable in the UI/logs.
 *
 * Hub-downtime floor: disconnect duration is measured from the *later* of a
 * session's last heartbeat (`activeAt`) and the hub's own most recent
 * `start()` instant, never from `activeAt` alone. Without this, a hub that
 * was itself down (crash, redeploy, host reboot) for longer than `staleMs`
 * would find every session's heartbeat already stale the moment it comes
 * back up, and the startup sweep in `start()` would mass-archive live
 * sessions that simply haven't had a chance to reconnect yet. Anchoring the
 * floor at hub start instead gives every session a full fresh `staleMs`
 * reconnect window counted from when the hub actually became reachable
 * again — hub downtime itself is never charged against a session. One
 * accepted consequence: the startup sweep can no longer archive anything on
 * its own (every session's disconnect-since collapses to "hub start", i.e.
 * age zero); a genuine startup zombie (CLI never reconnects) still gets
 * caught, just by the first periodic sweep that lands after
 * `hub start + staleMs` has elapsed, not by the immediate one.
 *
 * Revival: reconnecting alone (`SessionCache.markSessionActive` /
 * `handleSessionAlive` flipping `active` back to `true`) is what excludes a
 * session from the next sweep's candidate set. But a session the reaper
 * itself archived also needs its persisted `metadata.lifecycleState` healed
 * back to `'running'` on reconnect, or it keeps showing "archived" in
 * the web UI forever despite being live again — see
 * `SessionCache`'s reconnect-heal helper (invoked from both of the entry
 * points above) for that half of the fix. Sessions archived by anything
 * other than this reaper (`archivedBy !== REAPER_ARCHIVED_BY`) are
 * deliberately left alone by that heal path — a human or the CLI's own
 * archive-on-exit meant it, and reconnecting must not silently undo it.
 */
import { REAPER_ARCHIVED_BY, type SessionCache } from './sessionCache'

export const REAPER_DEFAULT_INTERVAL_MS = 5 * 60_000
export const REAPER_DEFAULT_STALE_MS = 30 * 60_000
export const REAPER_ARCHIVE_REASON = 'Connection lost (reaped by hub)'

export interface SessionReaperOptions {
    /** Sweep period. Defaults to `HAPI_REAPER_INTERVAL_MS` env or `REAPER_DEFAULT_INTERVAL_MS`. */
    intervalMs?: number
    /** Disconnect-age threshold to archive. Defaults to `HAPI_REAPER_STALE_MS` env or `REAPER_DEFAULT_STALE_MS`. 0 disables the reaper entirely. */
    staleMs?: number
    now?: () => number
    /** Called once per session successfully archived by a sweep. */
    onReap?: (sessionId: string) => void
    /** Called when archiving a candidate throws (e.g. exhausted version-mismatch retries); the sweep continues with the next candidate. */
    onError?: (sessionId: string, error: unknown) => void
}

function parseNonNegativeIntEnv(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export class SessionReaper {
    readonly intervalMs: number
    readonly staleMs: number
    private readonly now: () => number
    private readonly onReap?: (sessionId: string) => void
    private readonly onError?: (sessionId: string, error: unknown) => void
    private timer: ReturnType<typeof setInterval> | null = null
    /**
     * Captured by `start()`, `null` until then. `null` also covers every
     * test/caller that drives `sweep()` directly without ever calling
     * `start()` — in that case there is no hub-start floor to apply and
     * staleness falls back to `activeAt` alone (pre-fix behavior). Reset on
     * every `start()` call so repeated start/stop cycles (e.g. hub
     * reconfiguration) always key off the *most recent* start.
     */
    private hubStartedAt: number | null = null

    constructor(
        private readonly cache: SessionCache,
        options: SessionReaperOptions = {}
    ) {
        this.intervalMs = options.intervalMs ?? parseNonNegativeIntEnv(process.env.HAPI_REAPER_INTERVAL_MS, REAPER_DEFAULT_INTERVAL_MS)
        this.staleMs = options.staleMs ?? parseNonNegativeIntEnv(process.env.HAPI_REAPER_STALE_MS, REAPER_DEFAULT_STALE_MS)
        this.now = options.now ?? Date.now
        this.onReap = options.onReap
        this.onError = options.onError
    }

    /** Either knob set to 0 disables the reaper. */
    get enabled(): boolean {
        return this.intervalMs > 0 && this.staleMs > 0
    }

    /**
     * Runs one sweep immediately, then arms the periodic timer. No-op when
     * disabled. Per the hub-downtime floor (see class doc comment above),
     * this immediate sweep can never archive anything on its own - every
     * session's disconnect-since collapses to "hub start" (age zero) the
     * instant `hubStartedAt` is captured, a few lines up. A genuine startup
     * zombie is still caught, just by the first periodic sweep landing after
     * `hub start + staleMs`, not by this one.
     */
    start(): void {
        if (!this.enabled) return
        this.hubStartedAt = this.now()
        this.sweep()
        this.timer = setInterval(() => this.sweep(), this.intervalMs)
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    /**
     * One reaping pass. Public (not just timer-driven) so callers/tests can
     * trigger it deterministically. Returns the ids of sessions archived.
     */
    sweep(): string[] {
        if (!this.enabled) return []
        const cutoff = this.now()
        const reaped: string[] = []
        for (const session of this.cache.getSessions()) {
            if (session.active) continue
            if (session.metadata?.lifecycleState !== 'running') continue
            // Staleness is disconnect duration, nothing else. `activeAt`
            // (last heartbeat) is the only clock that tracks the CLI
            // connection - `active === false` is *produced* by
            // `SessionCache.expireInactive` purely off `activeAt`
            // (now - activeAt > 30s), so activeAt is already the hub's own
            // definition of "how long has this session been disconnected".
            // `updatedAt` (last message/metadata write) must NOT factor in
            // here: any hub-side touch on a dead session's row after it goes
            // inactive (e.g. `recordSessionActivity` from a web client still
            // sending a message into the void) would otherwise push
            // `updatedAt` forward and indefinitely postpone reaping a
            // genuinely dead session - see reaper.test.ts's "reaps a dead
            // session even while hub-side writes keep updatedAt fresh"
            // regression case (the fixture where only activeAt-only reaps).
            // Hub-downtime floor (see class doc comment): a session that
            // reconnected, or simply hasn't had the chance to yet, since the
            // hub's own most recent start must never be judged stale off
            // wall-clock alone - `hubStartedAt` (null when `sweep()` runs
            // without ever going through `start()`) raises the floor so hub
            // outages are never charged against a session's staleness
            // budget.
            const disconnectSince = this.hubStartedAt === null
                ? session.activeAt
                : Math.max(session.activeAt, this.hubStartedAt)
            if (cutoff - disconnectSince < this.staleMs) continue
            try {
                this.cache.markSessionArchivedFromHub(session.id, REAPER_ARCHIVE_REASON, REAPER_ARCHIVED_BY)
                reaped.push(session.id)
                this.onReap?.(session.id)
            } catch (error) {
                this.onError?.(session.id, error)
            }
        }
        return reaped
    }
}
