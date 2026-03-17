import { isPermissionModeAllowedForFlavor, isObject } from '@hapi/protocol'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import type { TeamPermission, TeamState } from '@hapi/protocol/types'
import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const decisionSchema = z.enum(['approved', 'approved_for_session', 'denied', 'abort'])

// Flat format: Record<string, string[]> (AskUserQuestion)
// Nested format: Record<string, { answers: string[] }> (request_user_input)
const answersSchema = z.union([
    z.record(z.string(), z.array(z.string())),
    z.record(z.string(), z.object({ answers: z.array(z.string()) }))
])

const approveBodySchema = z.object({
    mode: PermissionModeSchema.optional(),
    allowTools: z.array(z.string()).optional(),
    decision: decisionSchema.optional(),
    answers: answersSchema.optional()
})

const denyBodySchema = z.object({
    decision: decisionSchema.optional()
})

/**
 * Update the teamState.pendingPermissions status for a given requestId (toolUseId).
 * This keeps the TeamPanel UI in sync after API-based approval/denial.
 */
function updateTeamPermissionStatus(
    engine: SyncEngine,
    sessionId: string,
    session: { teamState?: TeamState | null; namespace: string },
    requestId: string,
    status: 'approved' | 'denied'
): void {
    const teamState = session.teamState as TeamState | null | undefined
    if (!teamState?.pendingPermissions?.length) return

    const updated = teamState.pendingPermissions.map(p =>
        (p.requestId === requestId || p.toolUseId === requestId)
            ? { ...p, status: status as 'approved' | 'denied' }
            : p
    )

    // Only persist if something actually changed
    if (updated.every((p, i) => p === teamState.pendingPermissions![i])) return

    const newTeamState = { ...teamState, pendingPermissions: updated, updatedAt: Date.now() }
    engine.updateSessionTeamState(sessionId, newTeamState, session.namespace)
}

/**
 * Resolve the correct agentState.requests key for a permission request.
 *
 * The requestId from the web UI may be a teammate message ID ("perm-...") or
 * SDK tool_use_id ("toolu_...") that doesn't match the agentState.requests key.
 * Try to resolve via teamState.pendingPermissions.toolUseId, which is updated
 * by syncAgentPermissionsToTeamState to point to the agentState.requests key.
 */
function resolveAgentRequestId(
    requestId: string,
    requests: Record<string, unknown> | null,
    teamState: TeamState | null | undefined
): { agentRequestId: string | null; teamPerm: TeamPermission | null } {
    // Direct match
    if (requests && requests[requestId]) {
        return { agentRequestId: requestId, teamPerm: null }
    }

    // Try resolving via teamState
    const teamPerm = teamState?.pendingPermissions?.find(
        p => p.requestId === requestId || p.toolUseId === requestId
    ) ?? null

    if (teamPerm) {
        if (teamPerm.toolUseId && requests?.[teamPerm.toolUseId]) {
            return { agentRequestId: teamPerm.toolUseId, teamPerm }
        }
        if (teamPerm.requestId && requests?.[teamPerm.requestId]) {
            return { agentRequestId: teamPerm.requestId, teamPerm }
        }
        // Last resort: find by tool name match in agentState.requests
        for (const [key, req] of Object.entries(requests ?? {})) {
            if (isObject(req) && req.tool === teamPerm.toolName) {
                return { agentRequestId: key, teamPerm }
            }
        }
    }

    return { agentRequestId: null, teamPerm }
}

export function createPermissionsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/permissions/:requestId/approve', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const json = await c.req.json().catch(() => null)
        const parsed = approveBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const requests = session.agentState?.requests ?? null
        const teamState = session.teamState as TeamState | null | undefined
        const { agentRequestId, teamPerm } = resolveAgentRequestId(requestId, requests, teamState)

        if (agentRequestId) {
            // RPC path: send approval directly to the CLI agent via RPC
            const mode = parsed.data.mode
            if (mode !== undefined) {
                const flavor = session.metadata?.flavor ?? 'claude'
                if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
                    return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
                }
            }
            await engine.approvePermission(sessionId, agentRequestId, mode, parsed.data.allowTools, parsed.data.decision, parsed.data.answers)
            updateTeamPermissionStatus(engine, sessionId, session, requestId, 'approved')
            return c.json({ ok: true })
        }

        // Team permissions are resolved internally by the team lead agent.
        // No external approval path exists.

        return c.json({ error: 'Request not found' }, 404)
    })

    app.post('/sessions/:id/permissions/:requestId/deny', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const json = await c.req.json().catch(() => null)
        const parsed = denyBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const requests = session.agentState?.requests ?? null
        const teamState = session.teamState as TeamState | null | undefined
        const { agentRequestId, teamPerm } = resolveAgentRequestId(requestId, requests, teamState)

        if (agentRequestId) {
            await engine.denyPermission(sessionId, agentRequestId, parsed.data.decision)
            updateTeamPermissionStatus(engine, sessionId, session, requestId, 'denied')
            return c.json({ ok: true })
        }

        // Team permissions are resolved internally by the team lead agent.

        return c.json({ error: 'Request not found' }, 404)
    })

    return app
}
