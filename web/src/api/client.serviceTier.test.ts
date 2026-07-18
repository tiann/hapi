import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'

describe('ApiClient Codex service tier requests', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends serviceTier when spawning a session', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: 'success', sessionId: 'session-1' }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const api = new ApiClient('token')
        await api.spawnSession(
            'machine-1',
            '/repo',
            'codex',
            undefined,
            undefined,
            true,
            undefined,
            'simple',
            undefined,
            undefined,
            'fast',
            '11111111-1111-4111-8111-111111111111'
        )

        expect(fetchMock).toHaveBeenCalledWith('/api/machines/machine-1/spawn', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                spawnRequestId: '11111111-1111-4111-8111-111111111111',
                directory: '/repo',
                agent: 'codex',
                model: undefined,
                modelReasoningEffort: undefined,
                yolo: true,
                sessionType: 'simple',
                worktreeName: undefined,
                effort: undefined,
                serviceTier: 'fast'
            })
        }))
    })

    it('queries pending spawn status by stable request ID', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            type: 'pending',
            spawnRequestId: '11111111-1111-4111-8111-111111111111'
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const api = new ApiClient('token')
        await api.querySpawnSession('machine-1', '11111111-1111-4111-8111-111111111111')

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/machines/machine-1/spawn/11111111-1111-4111-8111-111111111111',
            expect.any(Object)
        )
    })

    it('sends permissionMode when spawning an agy session', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: 'success', sessionId: 'session-agy' }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const api = new ApiClient('token')
        await api.spawnSession(
            'machine-1',
            '/repo',
            'agy',
            'Gemini 3.5 Flash (High)',
            undefined,
            undefined,
            'safe-yolo',
            'simple'
        )

        expect(fetchMock).toHaveBeenCalledWith('/api/machines/machine-1/spawn', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                directory: '/repo',
                agent: 'agy',
                model: 'Gemini 3.5 Flash (High)',
                modelReasoningEffort: undefined,
                yolo: undefined,
                permissionMode: 'safe-yolo',
                sessionType: 'simple',
                worktreeName: undefined,
                effort: undefined,
                serviceTier: undefined
            })
        }))
    })

    it('posts serviceTier session config updates', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const api = new ApiClient('token')
        await api.setServiceTier('session-1', 'fast')

        expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/service-tier', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ serviceTier: 'fast' })
        }))
    })
})
