import { configuration } from '@/configuration'

export function buildHubRequestHeaders(baseHeaders: Record<string, string>): Record<string, string> {
    return {
        ...configuration.extraHeaders,
        ...baseHeaders
    }
}

export function buildSocketIoExtraHeaderOptions(): {
    transportOptions?: {
        polling: { extraHeaders: Record<string, string> }
        websocket: { extraHeaders: Record<string, string> }
    }
} {
    if (Object.keys(configuration.extraHeaders).length === 0) {
        return {}
    }

    const extraHeaders = { ...configuration.extraHeaders }

    return {
        transportOptions: {
            polling: { extraHeaders },
            websocket: { extraHeaders }
        }
    }
}
