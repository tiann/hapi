import type { ProviderHealthCheckResponse, ProviderModel, ProviderProtocol } from '@hapi/protocol'
import type { ResolvedProviderProfile } from './providerRegistry'

const DEFAULT_ENDPOINTS: Record<ProviderProtocol, string> = {
    'anthropic-messages': 'https://api.anthropic.com',
    'openai-responses': 'https://api.openai.com',
    'openai-chat-completions': 'https://api.openai.com',
    'gemini-generative-ai': 'https://generativelanguage.googleapis.com'
}

function modelsUrl(profile: ResolvedProviderProfile): URL {
    const base = new URL(profile.baseUrl ?? DEFAULT_ENDPOINTS[profile.protocol])
    const normalizedPath = base.pathname.replace(/\/+$/, '')
    if (profile.protocol === 'gemini-generative-ai') {
        base.pathname = `${normalizedPath || ''}/v1beta/models`.replace(/\/+/g, '/')
        base.searchParams.set('key', profile.apiKey)
        return base
    }
    const hasVersionPath = /\/v\d+(?:\.\d+)?$/i.test(normalizedPath)
    base.pathname = `${normalizedPath || ''}/${hasVersionPath ? 'models' : 'v1/models'}`.replace(/\/+/g, '/')
    return base
}

function headersFor(profile: ResolvedProviderProfile): Record<string, string> {
    if (profile.protocol === 'anthropic-messages') {
        return {
            'x-api-key': profile.apiKey,
            'anthropic-version': '2023-06-01'
        }
    }
    return { Authorization: `Bearer ${profile.apiKey}` }
}

function readModelIds(protocol: ProviderProtocol, payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') return []
    if (protocol === 'gemini-generative-ai') {
        const models = (payload as { models?: unknown }).models
        if (!Array.isArray(models)) return []
        return models.flatMap((model) => {
            if (!model || typeof model !== 'object') return []
            const name = (model as { name?: unknown }).name
            if (typeof name !== 'string' || !name.trim()) return []
            return [name.replace(/^models\//, '')]
        })
    }
    const data = (payload as { data?: unknown }).data
    if (!Array.isArray(data)) return []
    return data.flatMap((model) => {
        if (!model || typeof model !== 'object') return []
        const id = (model as { id?: unknown }).id
        return typeof id === 'string' && id.trim() ? [id.trim()] : []
    })
}

function toProviderModels(ids: string[]): ProviderModel[] {
    return Array.from(new Set(ids)).sort((left, right) => left.localeCompare(right)).map((id) => ({
        id,
        contextWindow: 200_000,
        source: 'provider'
    }))
}

function errorMessage(response: Response): string {
    if (response.status === 401 || response.status === 403) return 'Provider rejected the configured credential'
    return `Provider health check failed with HTTP ${response.status}`
}

export async function checkProviderHealth(profile: ResolvedProviderProfile): Promise<ProviderHealthCheckResponse> {
    const checkedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
        const response = await fetch(modelsUrl(profile).toString(), {
            headers: headersFor(profile),
            signal: controller.signal
        })
        if (!response.ok) {
            return { success: false, status: 'unhealthy', checkedAt, error: errorMessage(response) }
        }
        const payload = await response.json().catch(() => null)
        return {
            success: true,
            status: 'healthy',
            checkedAt,
            models: toProviderModels(readModelIds(profile.protocol, payload))
        }
    } catch (error) {
        const message = error instanceof Error && error.name === 'AbortError'
            ? 'Provider health check timed out'
            : 'Unable to connect to provider'
        return { success: false, status: 'unhealthy', checkedAt, error: message }
    } finally {
        clearTimeout(timeout)
    }
}
