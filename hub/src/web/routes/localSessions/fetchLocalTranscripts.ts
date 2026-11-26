import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import { machineSupportsLocalSessionImport, type HubLocalSessionSource } from './sources'

export type FetchLocalSessionsResult =
    | { success: true; sessions: Array<LocalTranscriptSummary | LocalTranscript>; machineId: string }
    | { success: false; error: string; machineId?: string }

/**
 * Fetch local-session lists for one source through the machine.
 *
 * - Runners advertising `local-session-import` answer the single
 *   ListLocalSessions RPC with normalized transcripts.
 * - Older runners fall back to the source's legacy per-flavor RPC; raw rows
 *   are converted with the descriptor's toTranscript so both paths converge
 *   on the same normalized shape.
 */
export async function fetchLocalSessions(options: {
    source: HubLocalSessionSource
    engine: SyncEngine
    machine: Machine
    cwd?: string | null
    /** Null -> summaries; otherwise transcripts for exactly these ids. */
    sessionIds?: string[] | null
}): Promise<FetchLocalSessionsResult> {
    const { source, engine, machine } = options
    if (machineSupportsLocalSessionImport(source, machine)) {
        const result = await engine.listLocalSessionsForMachine(machine.id, {
            flavor: source.flavor,
            cwd: options.cwd ?? null,
            sessionIds: options.sessionIds ?? null
        })
        if (!result.success) {
            return { success: false, error: result.error, machineId: machine.id }
        }
        return { success: true, sessions: [...result.sessions], machineId: machine.id }
    }

    const legacy = source.legacy
    if (!legacy) {
        return {
            success: false,
            error: `${source.displayName} runner does not support local history import`,
            machineId: machine.id
        }
    }
    const result = await legacy.fetch({
        engine,
        machineId: machine.id,
        cwd: options.cwd ?? null,
        sessionIds: options.sessionIds ?? null
    })
    if (!result.success) {
        return { success: false, error: result.error, machineId: machine.id }
    }
    return {
        success: true,
        sessions: result.sessions.map((raw) => legacy.toTranscript(raw)),
        machineId: machine.id
    }
}

/** Summaries for import list routes. */
export async function fetchLocalTranscriptSummaries(options: {
    source: HubLocalSessionSource
    engine: SyncEngine
    machine: Machine
    cwd?: string | null
}): Promise<FetchLocalSessionsResult> {
    const result = await fetchLocalSessions({ ...options, sessionIds: null })
    if (!result.success) return result
    return {
        ...result,
        sessions: result.sessions.filter((session): session is LocalTranscriptSummary => !('messages' in session))
    }
}

/**
 * Full transcripts for the ids an import is about to persist.
 *
 * Every requested transcript travels in ONE runner RPC answer, and the runner
 * answers through a single socket frame the hub caps at 48MB — so sources
 * whose transcripts can be large (DSH folds whole tool-heavy logs) opt into
 * `chunkedTranscriptFetch`: one RPC per session, so a batch never adds up past
 * the frame limit.
 *
 * A listed session that cannot be handed over as a transcript comes back as a
 * summary carrying `importError` (too large for one frame, log unreadable);
 * those are kept so the route can report them per session instead of a
 * misleading not_found.
 */
export async function fetchLocalTranscriptsByIds(options: {
    source: HubLocalSessionSource
    engine: SyncEngine
    machine: Machine
    cwd?: string | null
    sessionIds: string[]
}): Promise<FetchLocalSessionsResult> {
    const { source } = options
    if (source.chunkedTranscriptFetch) {
        const sessions: Array<LocalTranscriptSummary | LocalTranscript> = []
        for (const sessionId of options.sessionIds) {
            const result = await fetchLocalSessions({ ...options, sessionIds: [sessionId] })
            if (!result.success) return result
            sessions.push(...keepTranscriptsAndRejections(result.sessions))
        }
        return { success: true, sessions, machineId: options.machine.id }
    }
    const result = await fetchLocalSessions({ ...options })
    if (!result.success) return result
    return {
        ...result,
        sessions: keepTranscriptsAndRejections(result.sessions)
    }
}

function keepTranscriptsAndRejections(sessions: Array<LocalTranscriptSummary | LocalTranscript>): Array<LocalTranscriptSummary | LocalTranscript> {
    return sessions.filter((session) => 'messages' in session || session.importError !== undefined)
}
