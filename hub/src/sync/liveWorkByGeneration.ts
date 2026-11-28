/**
 * Generation-keyed durable live-work (#2658).
 *
 * One record per worker generation (`hostStartMarker`). Any entry with work
 * blocks destroy-state callers. Clear of a prior generation on runner-owned
 * sessions requires PID+marker ProbeSessionExit `already_gone` first.
 *
 * Acceptance: the archive / live-work coverage tables (prior-gen still_alive
 * refuse; PID+marker already_gone clear; runner-owned hostPid scope; legacy
 * read-path project) are criteria, not decoration — #2021 must not regress
 * them when it rebases onto this keyed model.
 */

import type { BackgroundTask, Session } from '@hapi/protocol/types'

export type LiveWorkGenerationEntry = {
    machineId: string
    hostPid?: number
    since: number
    unresolvedTurn?: boolean
    backgroundTasks?: BackgroundTask[]
}

export type LiveWorkByGeneration = Record<string, LiveWorkGenerationEntry>

/** Reserved key when the reporting worker has no hostStartMarker (fail closed). */
export const UNKNOWN_GENERATION_KEY = '__unknown__'

export function isRunnerOwnedSession(session: Session | { metadata?: Session['metadata'] } | null | undefined): boolean {
    const meta = session?.metadata
    return Boolean(meta?.codexResumePending)
        || meta?.startedBy === 'runner'
        || meta?.startedFromRunner === true
}

export function generationEntryHasWork(entry: LiveWorkGenerationEntry | null | undefined): boolean {
    if (!entry) return false
    if (entry.unresolvedTurn === true) return true
    return Array.isArray(entry.backgroundTasks) && entry.backgroundTasks.length > 0
}

export function liveWorkByGenerationHasWork(map: LiveWorkByGeneration | null | undefined): boolean {
    if (!map) return false
    for (const entry of Object.values(map)) {
        if (generationEntryHasWork(entry)) return true
    }
    return false
}

/**
 * Project legacy single-slot `unresolvedTurn` / `backgroundWork` into the keyed
 * map when the keyed field is absent (read-path only; no backfill job).
 */
export function projectLegacyLiveWork(
    metadata: Session['metadata'] | null | undefined,
): LiveWorkByGeneration {
    if (!metadata) return {}
    const keyed = metadata.liveWorkByGeneration
    if (keyed && typeof keyed === 'object' && !Array.isArray(keyed)) {
        return { ...keyed }
    }

    const out: LiveWorkByGeneration = {}
    const legacyTurn = metadata.unresolvedTurn
    const legacyBg = metadata.backgroundWork
    const turnMarker = legacyTurn && typeof legacyTurn === 'object'
        ? legacyTurn.hostStartMarker
        : undefined
    const bgMarker = legacyBg && typeof legacyBg === 'object'
        ? legacyBg.hostStartMarker
        : undefined
    const marker = (typeof turnMarker === 'string' && turnMarker.length > 0)
        ? turnMarker
        : (typeof bgMarker === 'string' && bgMarker.length > 0)
            ? bgMarker
            : (typeof metadata.hostStartMarker === 'string' && metadata.hostStartMarker.length > 0)
                ? metadata.hostStartMarker
                : UNKNOWN_GENERATION_KEY

    const hasTurn = Boolean(legacyTurn && typeof legacyTurn === 'object')
    const tasks = legacyBg && typeof legacyBg === 'object' && Array.isArray(legacyBg.tasks)
        ? legacyBg.tasks
        : []
    if (!hasTurn && tasks.length === 0) return out

    const machineId = typeof metadata.machineId === 'string' ? metadata.machineId : ''
    out[marker] = {
        machineId,
        ...(typeof metadata.hostPid === 'number' && metadata.hostPid > 0
            ? { hostPid: metadata.hostPid }
            : {}),
        since: (legacyTurn && typeof legacyTurn === 'object' && typeof legacyTurn.since === 'number')
            ? legacyTurn.since
            : Date.now(),
        ...(hasTurn ? { unresolvedTurn: true } : {}),
        ...(tasks.length > 0 ? { backgroundTasks: tasks as BackgroundTask[] } : {}),
    }
    return out
}

export function resolveLiveWorkByGeneration(session: Session): LiveWorkByGeneration {
    return projectLegacyLiveWork(session.metadata)
}

/** Entry can be cleared via existing PID+marker ProbeSessionExit (runner-owned only). */
export function generationEntryProbeClearable(
    session: Session,
    marker: string,
    entry: LiveWorkGenerationEntry,
): boolean {
    if (!isRunnerOwnedSession(session)) return false
    if (marker === UNKNOWN_GENERATION_KEY || marker.length === 0) return false
    if (typeof entry.machineId !== 'string' || entry.machineId.length === 0) return false
    if (typeof entry.hostPid !== 'number' || entry.hostPid <= 0) return false
    return generationEntryHasWork(entry)
}
