import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DEFAULT_CC_API_MODEL, DEFAULT_CLAUDE_DEEPSEEK_MODEL, getProviderSelectionIssue, isAgyModelPreset, isCcApiEffortAllowedForModel, isClaudeDeepSeekEffortAllowedForModel, isClaudeDeepSeekModelPreset, isHermesMoaPreset, isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { CodexServiceTierSchema, PermissionModeSchema } from '@hapi/protocol/schemas'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'

const spawnBodySchema = z.object({
    spawnRequestId: z.string().uuid().optional(),
    directory: z.string().min(1),
    agent: z.enum(['claude', 'claude-deepseek', 'claude-ark', 'cc-api', 'codex', 'cursor', 'agy', 'grok', 'opencode', 'hermes-moa']).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    serviceTier: CodexServiceTierSchema.optional(),
    yolo: z.boolean().optional(),
    permissionMode: PermissionModeSchema.optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional()
})

const pathsExistsSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const allMachines = engine.getMachinesByNamespace(namespace)
        const machines = engine.getOnlineMachinesByNamespace(namespace)
        return c.json({
            machines,
            knownMachinesCount: allMachines.length,
            offlineMachinesCount: Math.max(allMachines.length - machines.length, 0),
            serverTime: Date.now()
        })
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = spawnBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        if (parsed.data.agent === 'agy' && parsed.data.model !== undefined && !isAgyModelPreset(parsed.data.model)) {
            return c.json({ error: `Unknown Antigravity agy model: ${parsed.data.model}` }, 400)
        }
        if (parsed.data.agent === 'claude-deepseek' && parsed.data.model !== undefined && !isClaudeDeepSeekModelPreset(parsed.data.model)) {
            return c.json({ error: `Unknown CC-deepseek model: ${parsed.data.model}` }, 400)
        }
        if (parsed.data.agent === 'hermes-moa' && parsed.data.model !== undefined && !isHermesMoaPreset(parsed.data.model)) {
            return c.json({ error: `Unknown Hermes MoA preset: ${parsed.data.model}` }, 400)
        }
        const agent = parsed.data.agent ?? 'claude'
        if (parsed.data.permissionMode !== undefined && !isPermissionModeAllowedForFlavor(parsed.data.permissionMode, agent)) {
            return c.json({ error: `Unsupported permission mode for ${agent}: ${parsed.data.permissionMode}` }, 400)
        }
        if (
            parsed.data.agent === 'cc-api'
            && !isCcApiEffortAllowedForModel(parsed.data.model ?? DEFAULT_CC_API_MODEL, parsed.data.effort)
        ) {
            return c.json({ error: 'Effort selection is not supported for the current CC-api model' }, 400)
        }
        if (
            parsed.data.agent === 'claude-deepseek'
            && !isClaudeDeepSeekEffortAllowedForModel(parsed.data.model ?? DEFAULT_CLAUDE_DEEPSEEK_MODEL, parsed.data.effort)
        ) {
            return c.json({ error: 'Effort selection is not supported for the current CC-deepseek model' }, 400)
        }

        if (parsed.data.spawnRequestId) {
            const existing = await engine.querySpawnSession(machineId, parsed.data.spawnRequestId, {
                directory: parsed.data.directory,
                agent: parsed.data.agent,
                model: parsed.data.model,
                modelReasoningEffort: parsed.data.modelReasoningEffort,
                yolo: parsed.data.yolo,
                sessionType: parsed.data.sessionType,
                worktreeName: parsed.data.worktreeName,
                effort: parsed.data.effort,
                permissionMode: parsed.data.permissionMode,
                serviceTier: parsed.data.serviceTier,
            })
            if (existing.type !== 'not_found') {
                return c.json(existing)
            }
        }

        const readinessIssue = getProviderSelectionIssue(
            machine.metadata?.providerReadiness,
            agent,
            {
                model: parsed.data.model,
                effort: agent === 'codex' ? parsed.data.modelReasoningEffort : parsed.data.effort,
                mode: parsed.data.permissionMode,
                yolo: parsed.data.yolo
            }
        )
        if (readinessIssue) {
            return c.json({
                error: readinessIssue.message,
                code: readinessIssue.code,
                ...(readinessIssue.recoveryCommand
                    ? { recoveryCommand: readinessIssue.recoveryCommand }
                    : {})
            }, 409)
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.modelReasoningEffort,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined,
            parsed.data.effort,
            parsed.data.permissionMode,
            parsed.data.serviceTier,
            parsed.data.spawnRequestId ?? randomUUID()
        )
        return c.json(result)
    })

    app.get('/machines/:id/spawn/:spawnRequestId', async (c) => {
        c.header('Cache-Control', 'no-store')
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const parsedId = z.string().uuid().safeParse(c.req.param('spawnRequestId'))
        if (!parsedId.success) {
            return c.json({ error: 'Invalid spawn request ID' }, 400)
        }
        return c.json(await engine.querySpawnSession(machineId, parsedId.data))
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = pathsExistsSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            const exists = await engine.checkPathsExist(machineId, uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    return app
}
