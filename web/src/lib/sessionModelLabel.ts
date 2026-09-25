import { getAgyModelLabel, getClaudeModelLabel, getFlavorLabel, isKnownFlavor } from '@hapi/protocol'

type SessionModelSource = {
    model?: string | null
    metadata?: {
        flavor?: string | null
    } | null
}

export type SessionModelLabel = {
    key: 'session.item.model'
    value: string
}

function getModelLabel(model: string): string | null {
    return getAgyModelLabel(model) ?? getClaudeModelLabel(model)
}

export function getSessionAgentLabel(session: SessionModelSource): string {
    const flavor = session.metadata?.flavor?.trim()
    if (!flavor) return 'unknown'
    return isKnownFlavor(flavor) ? getFlavorLabel(flavor) : flavor
}

function formatCodexModelId(model: string): string {
    const match = model.match(/^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i)
    if (!match) return model

    const [, version, variant] = match
    if (!variant) return `GPT-${version}`

    const formattedVariant = variant
        .split('-')
        .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
        .join('-')
    return `GPT-${version}-${formattedVariant}`
}

export function getSessionModelLabel(
    session: SessionModelSource,
    displayName?: string | null
): SessionModelLabel | null {
    const explicitModel = typeof session.model === 'string' ? session.model.trim() : ''
    if (explicitModel) {
        const fallbackLabel = session.metadata?.flavor === 'codex'
            ? formatCodexModelId(explicitModel)
            : explicitModel
        return {
            key: 'session.item.model',
            value: displayName?.trim() || getModelLabel(explicitModel) || fallbackLabel
        }
    }

    return null
}
