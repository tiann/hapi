import { getClaudeModelLabel } from '@hapi/protocol'

type SessionModelSource = {
    model?: string | null
}

export type SessionModelLabel = {
    key: 'session.item.model'
    value: string
}

export function getSessionModelLabel(session: SessionModelSource): SessionModelLabel | null {
    const explicitModel = typeof session.model === 'string' ? session.model.trim() : ''
    if (explicitModel) {
        return {
            key: 'session.item.model',
            value: getClaudeModelLabel(explicitModel) ?? explicitModel
        }
    }

    return null
}
