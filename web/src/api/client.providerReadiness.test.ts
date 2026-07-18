import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatProviderIssue } from '@/components/NewSession/providerAvailability'
import { ApiClient, ApiError } from './client'

describe('ApiClient provider readiness spawn conflicts', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('maps a Hub readiness 409 into the localized structured spawn error path', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            error: 'grok is not authenticated on this machine.',
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code'
        }), { status: 409, statusText: 'Conflict' }))
        vi.stubGlobal('fetch', fetchMock)

        const api = new ApiClient('token')
        const result = await api.spawnSession('machine-1', '/repo', 'grok')

        expect(result).toEqual({
            type: 'error',
            message: 'grok is not authenticated on this machine.',
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code'
        })
        expect(result.type).toBe('error')
        if (result.type !== 'error' || !result.code) throw new Error('expected structured readiness error')

        const messages: Record<string, string> = {
            'newSession.provider.notAuthenticated': '{agent} is not authenticated.',
            'newSession.provider.recovery': 'Run: {command}'
        }
        const localized = formatProviderIssue({
            ok: false,
            code: result.code,
            message: result.message,
            recoveryCommand: result.recoveryCommand
        }, 'Grok', (key, params) => (
            (messages[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        ))

        expect(localized).toBe('Grok is not authenticated. Run: grok login --device-code')
    })

    it('does not reinterpret an unrelated 409 as provider readiness', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            error: 'Spawn request already exists.',
            code: 'spawn-conflict'
        }), { status: 409, statusText: 'Conflict' })))

        const api = new ApiClient('token')
        const result = api.spawnSession('machine-1', '/repo', 'grok')

        await expect(result).rejects.toBeInstanceOf(ApiError)
        await expect(result).rejects.toMatchObject({ status: 409 })
    })

    it('does not reinterpret a readiness-shaped non-409 response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            error: 'grok readiness could not be checked.',
            code: 'provider-probe-failed'
        }), { status: 503, statusText: 'Service Unavailable' })))

        const api = new ApiClient('token')
        const result = api.spawnSession('machine-1', '/repo', 'grok')

        await expect(result).rejects.toBeInstanceOf(ApiError)
        await expect(result).rejects.toMatchObject({ status: 503 })
    })
})
