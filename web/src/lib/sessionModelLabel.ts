import { getAgyModelLabel, getClaudeModelLabel } from '@hapi/protocol'

type SessionModelSource = {
    model?: string | null
}

export type SessionModelLabel = {
    key: 'session.item.model'
    value: string
}

function getModelLabel(model: string): string | null {
    return getAgyModelLabel(model) ?? getClaudeModelLabel(model)
}

export function getSessionModelLabel(session: SessionModelSource): SessionModelLabel | null {
    const explicitModel = typeof session.model === 'string' ? session.model.trim() : ''
    if (explicitModel) {
        return {
            key: 'session.item.model',
            value: getModelLabel(explicitModel) ?? explicitModel
        }
    }

    return null
}
