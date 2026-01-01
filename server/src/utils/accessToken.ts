export const DEFAULT_NAMESPACE = 'default'

export type ParsedAccessToken = {
    baseToken: string
    namespace: string
}

export function parseAccessToken(raw: string): ParsedAccessToken | null {
    if (!raw) {
        return null
    }

    const trimmed = raw.trim()
    if (!trimmed) {
        return null
    }

    const separatorIndex = trimmed.lastIndexOf(':')
    if (separatorIndex === -1) {
        return { baseToken: trimmed, namespace: DEFAULT_NAMESPACE }
    }

    const baseToken = trimmed.slice(0, separatorIndex)
    const namespace = trimmed.slice(separatorIndex + 1)
    if (!baseToken || !namespace) {
        return null
    }

    if (baseToken.trim() !== baseToken || namespace.trim() !== namespace) {
        return null
    }

    return { baseToken, namespace }
}
