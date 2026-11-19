/**
 * Keepalive-idle reconciliation (tiann/hapi#1820).
 *
 * `sessionCache.expireInactive` only expires a session when its `activeAt`
 * goes stale, and `session-alive` refreshes `activeAt` every couple of
 * seconds for as long as the CLI socket lives. A session whose agent has done
 * nothing for days therefore stays `active: true` / `lifecycleState: running`
 * forever: socket pinging is being read as agent health.
 *
 * This module supplies the missing second signal. `active` keeps its existing
 * meaning (the CLI is reachable — flipping it would arm resume-respawn, dedup
 * merge and delete paths against a session whose process is very much alive);
 * `lifecycleState` moves `running` → `idle` once we have seen nothing but
 * keepalives for the configured window.
 */

import { SESSION_LIFECYCLE_IDLE, SESSION_LIFECYCLE_RUNNING, isLiveLifecycleState } from '@hapi/protocol'
import type { Session } from '@hapi/protocol/types'

/** Keepalive-only for this long ⇒ reconcile `running` → `idle`. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000

/**
 * `HAPI_SESSION_IDLE_TIMEOUT_MS` window, in ms. `0` disables reconciliation
 * entirely; an unset or unparseable value falls back to the default.
 */
export function resolveSessionIdleTimeoutMs(
    env: Record<string, string | undefined> = process.env
): number {
    const raw = env.HAPI_SESSION_IDLE_TIMEOUT_MS
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_SESSION_IDLE_TIMEOUT_MS
    }
    const parsed = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_SESSION_IDLE_TIMEOUT_MS
    }
    return parsed
}

/**
 * Hub-side work signals that do not live on the Session row itself. The
 * keepalive-idle reconciler passes none; hibernation passes all of them.
 */
export type LiveWorkSignals = {
    /** Queued-prompt thinking grace (`markMessageQueued`) still running. */
    pendingThinking?: boolean
    /** Attached session job currently running. */
    runningJob?: boolean
    /** Active team member or in-progress team task. */
    activeTeamWork?: boolean
    /** Open web terminals on this session. */
    openTerminals?: number
    /** Queued or scheduled messages not yet delivered. */
    undeliveredMessages?: number
    /** resume / archive / history action / pty or pi resume in flight. */
    operationInFlight?: boolean
}

/** Work the hub can see that must never be reconciled away as a zombie. */
export function hasLiveWork(session: Session, signals?: LiveWorkSignals): boolean {
    if (session.thinking) return true
    if (session.derivedToolWork === true) return true
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    // A permission / input request waiting on the operator is real state the
    // agent is blocked on, not an abandoned socket.
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) return true
    if (!signals) return false
    if (signals.pendingThinking) return true
    if (signals.runningJob) return true
    if (signals.activeTeamWork) return true
    if ((signals.openTerminals ?? 0) > 0) return true
    if ((signals.undeliveredMessages ?? 0) > 0) return true
    if (signals.operationInFlight) return true
    return false
}

/** Active sub-agent member or a team task still in progress. */
export function hasActiveTeamWork(session: Session): boolean {
    const team = session.teamState
    if (!team) return false
    if (team.members?.some((member) => member.status === 'active')) return true
    if (team.tasks?.some((task) => task.status === 'in_progress')) return true
    return false
}

/**
 * Should this session be reconciled `running` → `idle` right now?
 *
 * `agentProgressAt` is the last time the hub observed actual agent progress
 * (a message in either direction, a queued prompt, a background task), NOT
 * the last keepalive.
 */
export function shouldMarkKeepaliveIdle(
    session: Session,
    agentProgressAt: number,
    now: number,
    timeoutMs: number
): boolean {
    if (timeoutMs <= 0) return false
    // Only sessions the hub still believes are live. An inactive row is #842's
    // problem, not this one.
    if (!session.active) return false
    if (session.metadata?.lifecycleState !== SESSION_LIFECYCLE_RUNNING) return false
    if (session.metadata.idleReconcileExempt === true) return false
    if (hasLiveWork(session)) return false
    return now - agentProgressAt > timeoutMs
}

/**
 * Should an already-`idle` session be reconciled back to `running`?
 *
 * Only real progress wakes a session, never `thinking`. Cursor ACP emits
 * ambient idle/running churn on sessions that are doing nothing
 * (tiann/hapi#1553); waking on it would flap the lifecycle — and a DB write
 * plus a full-session broadcast — on every 5 s tick. A session that is
 * genuinely working emits messages, and those do wake it.
 */
export function shouldClearKeepaliveIdle(
    session: Session,
    agentProgressAt: number,
    now: number,
    timeoutMs: number
): boolean {
    if (session.metadata?.lifecycleState !== SESSION_LIFECYCLE_IDLE) return false
    // Opting out after the fact still lifts an existing mark.
    if (session.metadata.idleReconcileExempt === true) return true
    return timeoutMs > 0 && now - agentProgressAt <= timeoutMs
}

/** Keepalive-only with no agent progress for this long ⇒ hibernate. */
export const DEFAULT_SESSION_HIBERNATE_MS = 7_200_000
export const MIN_SESSION_HIBERNATE_MS = 60_000

/**
 * `HAPI_SESSION_HIBERNATE_MS` window, in ms. `0` disables hibernation; unset
 * or unparseable falls back to the default; 1..59999 is raised to 60000.
 */
export function resolveSessionHibernateMs(
    env: Record<string, string | undefined> = process.env
): number {
    const raw = env.HAPI_SESSION_HIBERNATE_MS
    if (raw === undefined) return DEFAULT_SESSION_HIBERNATE_MS
    const trimmed = raw.trim()
    if (!/^\d+$/.test(trimmed)) return DEFAULT_SESSION_HIBERNATE_MS
    const parsed = Number(trimmed)
    if (!Number.isSafeInteger(parsed)) return DEFAULT_SESSION_HIBERNATE_MS
    if (parsed === 0) return 0
    return Math.max(parsed, MIN_SESSION_HIBERNATE_MS)
}

export const HIBERNATE_ELIGIBLE_FLAVORS = ['claude', 'codex', 'opencode', 'pi'] as const

export type HibernateEligibleFlavor = typeof HIBERNATE_ELIGIBLE_FLAVORS[number]

export function isHibernateEligibleFlavor(flavor: unknown): flavor is HibernateEligibleFlavor {
    return typeof flavor === 'string' && (HIBERNATE_ELIGIBLE_FLAVORS as readonly string[]).includes(flavor)
}

/** Live-work signals plus the resolved native resume token (rule 9). */
export type HibernationSignals = LiveWorkSignals & {
    resumeId: string | null
}

/** Subset of `RunnerState.capabilities` hibernation reads. */
export type HibernationRunnerCapabilities = {
    sessionHibernation?: boolean
    piExistingSessionResume?: boolean
} | null | undefined

function isPtySession(session: Session): boolean {
    const agentStartingMode = (session.agentState as { startingMode?: unknown } | null)?.startingMode
    return agentStartingMode === 'pty' || session.metadata?.startingMode === 'pty'
}

function hasFlavorBlocker(
    session: Session,
    flavor: HibernateEligibleFlavor,
    runnerCapable: HibernationRunnerCapabilities
): boolean {
    const metadata = session.metadata
    if (!metadata) return true
    switch (flavor) {
        case 'codex':
            return metadata.codexRuntime?.kind === 'attached'
                || metadata.codexArchivedFork !== undefined
                || metadata.codexResumePending !== undefined
        case 'opencode':
            return ['reserved', 'prepared', 'unknown'].includes(metadata.opencodeRewind?.phase ?? '')
                || metadata.opencodeForkPending === true
                || (metadata.opencodeClearOperation !== undefined && metadata.opencodeClearOperation.state !== 'aborted')
        case 'pi':
            return runnerCapable?.piExistingSessionResume !== true
                || metadata.piResumeAttempt !== undefined
        case 'claude':
            return false
    }
}

/**
 * Should this session's wrapper and agent be stopped and the row marked
 * `hibernated` right now?
 *
 * `agentProgressAt` must already be `max(getAgentProgressAt, lifecycleStateSince)`.
 */
export function shouldHibernate(
    session: Session,
    signals: HibernationSignals | (() => HibernationSignals),
    agentProgressAt: number,
    now: number,
    hibernateMs: number,
    runnerCapable: HibernationRunnerCapabilities
): boolean {
    if (!(hibernateMs > 0)) return false
    if (!session.active) return false
    const metadata = session.metadata
    if (!metadata || !isLiveLifecycleState(metadata.lifecycleState)) return false
    if (metadata.capabilities?.concurrentClients === true || metadata.idleReconcileExempt === true) return false
    if (metadata.startedBy !== 'runner' && metadata.startedFromRunner !== true) return false
    if (session.agentState?.controlledByUser === true) return false
    if (isPtySession(session)) return false
    const flavor = metadata.flavor ?? 'claude'
    if (!isHibernateEligibleFlavor(flavor)) return false
    if (hasFlavorBlocker(session, flavor, runnerCapable)) return false
    if (runnerCapable?.sessionHibernation !== true) return false
    if (!(now - agentProgressAt > hibernateMs)) return false
    if (hasLiveWork(session)) return false
    const liveSignals = typeof signals === 'function' ? signals() : signals
    return Boolean(liveSignals.resumeId) && !hasLiveWork(session, liveSignals)
}
