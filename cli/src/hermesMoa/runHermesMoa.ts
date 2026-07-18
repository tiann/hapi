import { AgentRegistry } from '@/agent/AgentRegistry'
import { runAgentSession } from '@/agent/runners/runAgentSession'
import { createHermesMoaBackend } from './hermesMoaBackend'
import type { HermesMoaPermissionMode } from '@hapi/protocol/types'
import { DEFAULT_HERMES_MOA_PRESET } from '@hapi/protocol'

export async function runHermesMoa(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: HermesMoaPermissionMode
    model?: string
    resumeSessionId?: string
} = {}): Promise<void> {
    const model = opts.model ?? DEFAULT_HERMES_MOA_PRESET
    const permissionMode = opts.permissionMode ?? 'default'
    AgentRegistry.register('hermes-moa', () => createHermesMoaBackend({
        model,
        permissionMode
    }))
    await runAgentSession({
        agentType: 'hermes-moa',
        startedBy: opts.startedBy,
        permissionMode,
        model,
        resumeSessionId: opts.resumeSessionId,
        agentSessionIdMetadataField: 'hermesSessionId'
    })
}
