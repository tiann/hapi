import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { ExitPlanImplementationModeSchema, PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const approveDecisionSchema = z.enum(['approved', 'approved_for_session'])
const denyDecisionSchema = z.enum(['denied', 'abort'])

// Flat format: Record<string, string[]> (AskUserQuestion)
// Nested format: Record<string, { answers: string[] }> (request_user_input)
const answersSchema = z.union([
    z.record(z.string(), z.array(z.string())),
    z.record(z.string(), z.object({ answers: z.array(z.string()) }))
])

const approveBodySchema = z.object({
    mode: PermissionModeSchema.optional(),
    implementationMode: ExitPlanImplementationModeSchema.optional(),
    allowTools: z.array(z.string()).optional(),
    decision: approveDecisionSchema.optional(),
    answers: answersSchema.optional()
})

const denyBodySchema = z.object({
    decision: denyDecisionSchema.optional()
})

function isExitPlanModeToolName(toolName: string): boolean {
    return toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode'
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

        const request = requests[requestId]
        const requestToolName = typeof request?.tool === 'string' ? request.tool : ''
        const isExitPlanModeRequest = isExitPlanModeToolName(requestToolName)

        const flavor = session.metadata?.flavor ?? 'claude'

        const mode = parsed.data.mode
        if (mode !== undefined) {
            if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
                return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
            }
            if (isExitPlanModeRequest && mode === 'plan') {
                return c.json({ error: 'Plan mode cannot be selected after exit_plan_mode approval' }, 400)
            }
        }
        const implementationMode = parsed.data.implementationMode
        if (implementationMode !== undefined) {
            if (!isExitPlanModeRequest) {
                return c.json({ error: 'Implementation mode is only supported for exit_plan_mode' }, 400)
            }
            if (flavor !== 'claude') {
                return c.json({ error: 'Implementation mode is only supported for Claude exit_plan_mode' }, 400)
            }
        }
        const allowTools = parsed.data.allowTools
        const decision = parsed.data.decision
        const answers = parsed.data.answers
        await engine.approvePermission(sessionId, requestId, mode, allowTools, decision, answers, implementationMode)
        return c.json({ ok: true })
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

        await engine.denyPermission(sessionId, requestId, parsed.data.decision)
        return c.json({ ok: true })
    })

    return app
}
