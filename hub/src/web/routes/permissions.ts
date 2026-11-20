import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { CODEX_ASYNC_QUESTION_REQUEST_PREFIX, CODEX_QUESTION_REISSUED } from '@hapi/protocol/rpcMethods'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { PermissionDecisionRejectedError, PermissionQuestionReissuedError, PermissionRequestNotFoundError } from '../../sync/rpcGateway'
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
    answers: answersSchema.optional(),
    instanceId: z.string().min(1).optional()
})

const denyBodySchema = z.object({
    decision: decisionSchema.optional(),
    instanceId: z.string().min(1).optional()
})

function permissionFailure(c: Context<WebAppEnv>, error: unknown): Response {
    if (error instanceof PermissionRequestNotFoundError) {
        const status = error.requestId.startsWith(CODEX_ASYNC_QUESTION_REQUEST_PREFIX) ? 404 : 409
        return c.json({ error: error.message }, status)
    }
    if (error instanceof PermissionQuestionReissuedError) {
        return c.json({ error: error.message, code: CODEX_QUESTION_REISSUED }, 409)
    }
    if (error instanceof PermissionDecisionRejectedError) {
        return c.json({ error: error.message }, 422)
    }
    throw error
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
        if (!requests || !requests[requestId]) {
            return c.json({ error: 'Request not found' }, 404)
        }

        const mode = parsed.data.mode
        if (mode !== undefined) {
            const flavor = session.metadata?.flavor ?? 'claude'
            if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
                return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
            }
        }
        const allowTools = parsed.data.allowTools
        const decision = parsed.data.decision
        const answers = parsed.data.answers
        try {
            const acknowledgement = await engine.approvePermission(sessionId, requestId, mode, allowTools, decision, answers, parsed.data.instanceId)
            return c.json({ ok: true, acknowledgement })
        } catch (error) {
            return permissionFailure(c, error)
        }
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

        const requests = session.agentState?.requests ?? null
        if (!requests || !requests[requestId]) {
            return c.json({ error: 'Request not found' }, 404)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = denyBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const acknowledgement = await engine.denyPermission(sessionId, requestId, parsed.data.decision, parsed.data.instanceId)
            return c.json({ ok: true, acknowledgement })
        } catch (error) {
            return permissionFailure(c, error)
        }
    })

    return app
}
