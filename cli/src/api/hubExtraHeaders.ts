import { configuration } from '@/configuration'

export function buildHubRequestHeaders(baseHeaders: Record<string, string>): Record<string, string> {
    return {
        ...configuration.extraHeaders,
        ...baseHeaders
    }
}

export function buildSocketIoExtraHeaderOptions(): {
    extraHeaders?: Record<string, string>
} {
    if (Object.keys(configuration.extraHeaders).length === 0) {
        return {}
    }

    return {
        extraHeaders: { ...configuration.extraHeaders }
    }
}
