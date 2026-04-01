import type { SessionModel } from '@/api/types'

export function normalizeClaudeSessionModel(model?: string | null): SessionModel {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}
