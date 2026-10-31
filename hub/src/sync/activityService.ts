import { classifyKind, toSessionSummaryMetadata } from '@hapi/protocol'
import type { AgentActivityResponse, AgentActivitySession, AgentActivityWait } from '@hapi/protocol/apiTypes'
import { AgentStateSchema, MachineMetadataSchema, MetadataSchema } from '@hapi/protocol/schemas'
import type { SessionTurn, Store } from '../store'

export const ACTIVITY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
export const ACTIVITY_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
const TITLE_MAX_LENGTH = 120

/**
 * When agents in `namespace` were working between `since` and `until`: each
 * session's turns, plus the permission prompts and questions it waited on
 * the user for, so a client can leave those out.
 */
export function getAgentActivity(
    store: Store,
    namespace: string,
    since: number,
    until: number,
    now: number = Date.now()
): AgentActivityResponse {
    const turnsBySession = new Map<string, SessionTurn[]>()
    for (const turn of store.turns.list(namespace, since, until)) {
        const turns = turnsBySession.get(turn.sessionId) ?? []
        turns.push(turn)
        turnsBySession.set(turn.sessionId, turns)
    }

    const machineNames = new Map<string, string | null>()
    const machineName = (machineId: string): string | null => {
        if (!machineNames.has(machineId)) {
            const stored = store.machines.getMachineByNamespace(machineId, namespace)
            const parsed = MachineMetadataSchema.safeParse(stored?.metadata)
            machineNames.set(machineId, parsed.success ? (parsed.data.displayName ?? parsed.data.host) : null)
        }
        return machineNames.get(machineId) ?? null
    }

    const sessions: AgentActivitySession[] = []
    for (const [sessionId, turns] of turnsBySession) {
        const stored = store.sessions.getSessionByNamespace(sessionId, namespace)
        if (!stored) continue
        const parsedMetadata = MetadataSchema.safeParse(stored.metadata)
        const metadata = parsedMetadata.success ? parsedMetadata.data : null
        const summary = toSessionSummaryMetadata(metadata)
        const machineId = summary?.machineId ?? stored.machineId ?? null
        const title = (summary?.name ?? summary?.summary?.text)?.trim()

        sessions.push({
            id: sessionId,
            flavor: summary?.flavor ?? null,
            agentSessionId: summary?.agentSessionId ?? null,
            machineId,
            host: metadata?.host ?? null,
            machineName: machineId ? machineName(machineId) : null,
            path: summary?.path ?? null,
            title: title ? title.slice(0, TITLE_MAX_LENGTH) : null,
            turns: turns.map((turn) => ({
                start: turn.startedAt,
                end: turn.endedAt,
                endReason: turn.endReason,
                startedBy: turn.trigger
            })),
            waits: collectWaits(stored.agentState, turns, now)
        })
    }

    return { since, until, generatedAt: now, sessions }
}

/** Permission prompts and questions raised during one of `turns`. */
function collectWaits(agentState: unknown, turns: SessionTurn[], now: number): AgentActivityWait[] {
    const parsed = AgentStateSchema.safeParse(agentState)
    if (!parsed.success) return []
    const overlapsTurn = (start: number, end: number) =>
        turns.some((turn) => start < (turn.endedAt ?? now) && end > turn.startedAt)

    const waits: AgentActivityWait[] = []
    for (const request of Object.values(parsed.data.requests ?? {})) {
        // Requests stored before createdAt existed can't be placed in time.
        if (request.createdAt == null || !overlapsTurn(request.createdAt, now)) continue
        waits.push({ start: request.createdAt, end: null, kind: classifyKind(request.tool), tool: request.tool })
    }
    for (const request of Object.values(parsed.data.completedRequests ?? {})) {
        if (request.createdAt == null || request.completedAt == null) continue
        if (request.completedAt <= request.createdAt || !overlapsTurn(request.createdAt, request.completedAt)) continue
        waits.push({ start: request.createdAt, end: request.completedAt, kind: classifyKind(request.tool), tool: request.tool })
    }
    return waits.sort((a, b) => a.start - b.start)
}
