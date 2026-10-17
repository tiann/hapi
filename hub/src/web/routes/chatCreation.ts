import { Hono } from 'hono'
import {
    ChatCreationOverridesSchema, ChatCreationPreferencesSchema, MACHINE_CAPABILITIES,
    rememberChatCreation, resolveChatCreation, type ChatCreationPreferences
} from '@hapi/protocol'
import { getSettingsFile, readSettingsOrThrow, updateSettings } from '../../config/settings'
import { validateChatCreation } from '../../sync/validateChatCreation'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const requestSchema = ChatCreationOverridesSchema

export function createChatCreationRoutes(getEngine: () => SyncEngine | null, dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const settingsFile = getSettingsFile(dataDir)
    const readPreferences = async (namespace: string): Promise<ChatCreationPreferences> => {
        const settings = await readSettingsOrThrow(settingsFile)
        return ChatCreationPreferencesSchema.parse(Object.hasOwn(settings.newChatPreferences ?? {}, namespace)
            ? settings.newChatPreferences![namespace] : { machines: {} })
    }
    app.get('/new-chat-preferences', async (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json(await readPreferences(c.get('namespace')))
    })
    // One-way browser migration. Existing shared scopes always win, including
    // explicit native-default selections. Repeat imports cannot reset defaults.
    app.post('/new-chat-preferences/import', async (c) => {
        const parsed = ChatCreationPreferencesSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid creation preferences' }, 400)
        const namespace = c.get('namespace')
        const preferences = await updateSettings(settingsFile, (settings) => {
            const prior = settings.newChatPreferences?.[namespace]
            const incoming = parsed.data
            const machines = { ...incoming.machines, ...prior?.machines }
            for (const [id, machine] of Object.entries(incoming.machines)) {
                const saved = prior?.machines[id]
                machines[id] = { ...machine, ...saved, agents: { ...machine.agents, ...saved?.agents } }
            }
            const result: ChatCreationPreferences = { ...incoming, ...prior, machines }
            return { settings: { ...settings, newChatPreferences: { ...settings.newChatPreferences, [namespace]: result } }, result }
        })
        return c.json(preferences)
    })

    const create = (agentLaunched: boolean) => async (c: import('hono').Context<WebAppEnv>) => {
        const engine = requireSyncEngine(c, getEngine)
        if (engine instanceof Response) return engine
        const parent = agentLaunched ? requireSessionFromParam(c, engine) : null
        if (parent instanceof Response) return parent
        const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid creation options', issues: parsed.error.flatten() }, 400)
        const namespace = c.get('namespace')
        let resolved
        try {
            resolved = resolveChatCreation(parsed.data, await readPreferences(namespace), engine.getOnlineMachinesByNamespace(namespace).map(m => m.id))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Invalid creation options' }, 400)
        }
        const machine = engine.getMachineByNamespace(resolved.machineId, namespace)
        if (!machine?.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability)) {
            return c.json({ error: 'Runner upgrade required', code: 'runner_upgrade_required' }, 409)
        }
        try {
            await validateChatCreation(engine, resolved)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Cannot validate launch options' }, 400)
        }
        const launchOrigin = parent ? { kind: 'agent' as const, parentSessionId: parent.sessionId, createdAt: Date.now() } : undefined
        const result = await engine.spawnSession(
            resolved.machineId, resolved.directory, resolved.agent,
            resolved.model ?? undefined, resolved.modelReasoningEffort ?? undefined,
            resolved.yolo ?? undefined, resolved.sessionType, resolved.worktreeName ?? undefined,
            undefined, resolved.effort ?? undefined, resolved.permissionMode ?? undefined,
            resolved.serviceTier ?? undefined, undefined, resolved.collaborationMode ?? undefined,
            resolved.copilotAgentMode ?? undefined, resolved.startingMode ?? undefined,
            namespace, { launchOrigin }
        )
        if (result.type !== 'success') return c.json(result)
        // A settings write failure must never masquerade as a failed spawn and
        // cause an agent to retry a mutation that already created a child.
        try {
            await updateSettings(settingsFile, settings => ({
                settings: {
                    ...settings,
                    newChatPreferences: {
                        ...settings.newChatPreferences,
                        [namespace]: rememberChatCreation(settings.newChatPreferences?.[namespace] ?? { machines: {} }, resolved)
                    }
                }, result: undefined
            }))
            return c.json(result)
        } catch {
            return c.json({ ...result, preferencesWarning: 'Chat created, but its launch preferences could not be saved' })
        }
    }
    app.post('/sessions/create', create(false))
    app.post('/sessions/:id/create-peer', create(true))
    return app
}
