import type { DshModelsResponse } from '@hapi/protocol/apiTypes'
import { DshWebClient } from './dshWebClient'

function toResponse(catalog: Awaited<ReturnType<DshWebClient['getModels']>>): DshModelsResponse {
    return {
        success: true,
        current: {
            provider: catalog.current.provider,
            modelId: catalog.current.model,
            ...(catalog.current.reasoningEffort
                ? { reasoningEffort: catalog.current.reasoningEffort }
                : {})
        },
        availableModels: catalog.models.map((model) => ({
            provider: model.provider,
            providerName: model.providerName,
            modelId: model.model,
            name: model.name,
            reasoningEfforts: model.reasoningEfforts
        }))
    }
}

export async function getDshModelsForSession(
    client: DshWebClient,
    sessionId: string
): Promise<DshModelsResponse> {
    return toResponse(await client.getModels(sessionId))
}

export async function listDshModels(client = new DshWebClient()): Promise<DshModelsResponse> {
    const host = await client.describe()
    const sessions = await client.listSessions()
    const catalogSession = sessions.find((session) => session.running)
        ?? sessions.find((session) => !session.blank && session.origin !== 'subagent')
        ?? sessions.find((session) => session.origin !== 'subagent')

    if (catalogSession) {
        return await getDshModelsForSession(client, catalogSession.sessionId)
    }

    return {
        success: true,
        current: { provider: host.provider, modelId: host.model },
        availableModels: [{
            provider: host.provider,
            providerName: host.provider,
            modelId: host.model,
            name: host.model,
            reasoningEfforts: []
        }]
    }
}
