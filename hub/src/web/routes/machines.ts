import {
    MACHINE_DISPLAY_NAME_MAX_LENGTH,
    MACHINE_CAPABILITIES,
    MachineListDirectoryRequestSchema,
    MachinePathsExistsRequestSchema,
    RenameMachineRequestSchema,
    SpawnSessionRequestSchema
} from '@hapi/protocol'
import { Hono, type Context } from 'hono'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'
import {
    QueryUsageRequestSchema,
    SaveUsageQuerySettingsRequestSchema,
    TestUsageQueryRequestSchema,
    UsageQueryAgentSchema
} from '@hapi/protocol/usageQuery'

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const requireUsageQueryCapability = (c: Context<WebAppEnv>, machine: Machine | Response): Response | null => {
        if (machine instanceof Response) return machine
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.UsageQuery)) {
            return c.json({
                error: 'This runner must be upgraded before querying agent quota',
                code: 'runner_upgrade_required'
            }, 409)
        }
        return null
    }

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = engine.getOnlineMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.get('/machines/:id/usage-query/settings', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        const capabilityError = requireUsageQueryCapability(c, machine)
        if (capabilityError) return capabilityError

        const parsed = UsageQueryAgentSchema.safeParse(c.req.query('agent'))
        if (!parsed.success) return c.json({ error: 'agent must be claude, codex, or kimi' }, 400)

        try {
            return c.json(await engine.getUsageQuerySettings(machineId, parsed.data))
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({ error: error.message, code: RPC_TARGET_MISSING_ERROR_CODE }, 503)
            }
            return c.json({ error: error instanceof Error ? error.message : 'Failed to read usage query settings' }, 500)
        }
    })

    app.put('/machines/:id/usage-query/settings', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        const capabilityError = requireUsageQueryCapability(c, machine)
        if (capabilityError) return capabilityError

        const body = await c.req.json().catch(() => null)
        const parsed = SaveUsageQuerySettingsRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid usage query settings' }, 400)

        try {
            return c.json(await engine.saveUsageQuerySettings(machineId, parsed.data.agent, {
                enabled: parsed.data.enabled,
                templateId: parsed.data.templateId,
                template: parsed.data.template
            }))
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({ error: error.message, code: RPC_TARGET_MISSING_ERROR_CODE }, 503)
            }
            return c.json({ error: error instanceof Error ? error.message : 'Failed to save usage query settings' }, 500)
        }
    })

    app.post('/machines/:id/usage-query/test', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        const capabilityError = requireUsageQueryCapability(c, machine)
        if (capabilityError) return capabilityError

        const body = await c.req.json().catch(() => null)
        const parsed = TestUsageQueryRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid usage query test request' }, 400)

        try {
            return c.json(await engine.testUsageQueryTemplate(machineId, parsed.data.agent, parsed.data.template))
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({ error: error.message, code: RPC_TARGET_MISSING_ERROR_CODE }, 503)
            }
            return c.json({ error: error instanceof Error ? error.message : 'Failed to test usage query' }, 500)
        }
    })

    app.post('/machines/:id/usage-query/query', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        const capabilityError = requireUsageQueryCapability(c, machine)
        if (capabilityError) return capabilityError

        const body = await c.req.json().catch(() => ({}))
        const parsed = QueryUsageRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid usage query request' }, 400)

        try {
            return c.json(await engine.queryUsage(machineId, parsed.data.agent, parsed.data.force === true))
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({ error: error.message, code: RPC_TARGET_MISSING_ERROR_CODE }, 503)
            }
            return c.json({ error: error instanceof Error ? error.message : 'Failed to query usage' }, 500)
        }
    })

    app.patch('/machines/:id', async (c) => {
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
        const parsed = RenameMachineRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: displayName is required' }, 400)
        }

        // Trim first: a name is stored trimmed, so the ceiling applies to what
        // actually gets stored. An empty result clears the custom name.
        const displayName = parsed.data.displayName.trim()
        if (displayName.length > MACHINE_DISPLAY_NAME_MAX_LENGTH) {
            return c.json({ error: `displayName must be at most ${MACHINE_DISPLAY_NAME_MAX_LENGTH} characters` }, 400)
        }

        try {
            await engine.renameMachine(machineId, displayName)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to rename machine'
            // Match the session rename contract: contention maps to 409.
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
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
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability)) {
            return c.json({
                type: 'error' as const,
                message: 'This runner must be upgraded before creating sessions',
                code: 'runner_upgrade_required' as const,
            })
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SpawnSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        if (
            (parsed.data.agent === 'agy' || parsed.data.agent === 'dsh')
            && parsed.data.startingMode
            && parsed.data.startingMode !== 'remote'
        ) {
            return c.json({ error: `${parsed.data.agent.toUpperCase()} only supports remote mode` }, 400)
        }
        const startingMode = parsed.data.startingMode

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.modelReasoningEffort,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined, // resumeSessionId
            parsed.data.effort,
            parsed.data.permissionMode,
            parsed.data.serviceTier,
            undefined,
            parsed.data.collaborationMode,
            parsed.data.copilotAgentMode,
            startingMode
        )
        return c.json(result)
    })

    app.get('/machines/:id/agent-availability', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability)) {
            return c.json({
                error: 'This runner must be upgraded before creating sessions',
                code: 'runner_upgrade_required',
            }, 409)
        }

        try {
            return c.json(await engine.getAgentAvailability(machineId))
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to inspect Agent availability',
            }, 500)
        }
    })

    app.post('/machines/:id/list-directory', async (c) => {
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
        const parsed = MachineListDirectoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listMachineDirectory(machineId, parsed.data.path, parsed.data.includeHidden)
            return c.json(result)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to list directory' }, 500)
        }
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
        const parsed = MachinePathsExistsRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            return c.json(await engine.checkPathsExist(machineId, uniquePaths))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    app.get('/machines/:id/agy-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listAgyModelsForMachine(machineId, {
                refresh: c.req.query('refresh') === 'true'
            })
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Agy models'
            }, 500)
        }
    })

    app.get('/machines/:id/pi-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listPiModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({
                    success: false,
                    error: error.message,
                    code: RPC_TARGET_MISSING_ERROR_CODE
                }, 503)
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Pi models'
            }, 500)
        }
    })

    app.get('/machines/:id/codex-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCodexModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({
                    success: false,
                    error: error.message,
                    code: RPC_TARGET_MISSING_ERROR_CODE
                }, 503)
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForCwd(machineId, cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-model-variants', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listOpencodeModelVariantsForMachine(machineId, c.req.query('cwd') || null)
            return c.json(result)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({
                    success: false,
                    error: error.message,
                    code: RPC_TARGET_MISSING_ERROR_CODE
                }, 503)
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode model variants'
            }, 500)
        }
    })

    app.get('/machines/:id/grok-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listGrokModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok models'
            }, 500)
        }
    })

    app.get('/machines/:id/copilot-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listCopilotModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Copilot models'
            }, 500)
        }
    })

    app.get('/machines/:id/cursor-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCursorModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    app.post('/machines/:id/restart-runner', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const result = await engine.restartMachineRunner(machineId, c.get('namespace'))
        if (result.type === 'error') {
            const status = result.code === 'machine_not_found' ? 404
                : result.code === 'machine_offline' ? 503
                    : 502
            return c.json({ error: result.message, code: result.code }, status)
        }
        return c.json({ message: result.message })
    })

    return app
}
