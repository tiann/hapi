import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProviderHealth } from './providerHealth'
import type { ResolvedProviderProfile } from './providerRegistry'

const originalFetch = globalThis.fetch

function profile(overrides: Partial<ResolvedProviderProfile> = {}): ResolvedProviderProfile {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Test provider',
        agent: 'codex',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://proxy.example/v1',
        credentialType: 'api-key',
        apiKey: 'secret-value',
        models: [],
        health: { status: 'unverified' },
        enabled: true,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('checkProviderHealth', () => {
    it('uses the selected protocol model endpoint and normalizes discovered models', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: [{ id: 'glm-5.2' }, { id: 'qwen-coder' }]
        }), { status: 200 }))
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const result = await checkProviderHealth(profile())

        expect(result).toMatchObject({ success: true, status: 'healthy' })
        expect(result.models).toEqual([
            { id: 'glm-5.2', contextWindow: 200_000, source: 'provider' },
            { id: 'qwen-coder', contextWindow: 200_000, source: 'provider' }
        ])
        expect(fetchMock).toHaveBeenCalledWith(
            'https://proxy.example/v1/models',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-value' }) })
        )
    })

    it('reports a failed health check without echoing the credential', async () => {
        globalThis.fetch = vi.fn(async () => new Response('invalid credential', { status: 401 })) as unknown as typeof fetch

        const result = await checkProviderHealth(profile())

        expect(result.success).toBe(false)
        expect(result.status).toBe('unhealthy')
        expect(JSON.stringify(result)).not.toContain('secret-value')
    })

    it('uses Anthropic headers and endpoint for Claude profiles', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: [{ id: 'claude-sonnet-4-5' }]
        }), { status: 200 }))
        globalThis.fetch = fetchMock as unknown as typeof fetch

        await checkProviderHealth(profile({
            agent: 'claude',
            protocol: 'anthropic-messages',
            baseUrl: 'https://anthropic.example'
        }))

        expect(fetchMock).toHaveBeenCalledWith(
            'https://anthropic.example/v1/models',
            expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'secret-value' }) })
        )
    })
})
