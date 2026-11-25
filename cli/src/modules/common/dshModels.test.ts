import { describe, expect, it, vi } from 'vitest'

const probeState = vi.hoisted(() => ({
    backend: null as {
        initialize: ReturnType<typeof vi.fn>
        newSession: ReturnType<typeof vi.fn>
        getSessionModelsMetadata: ReturnType<typeof vi.fn>
        sendExtensionRequest: ReturnType<typeof vi.fn>
        disconnect: ReturnType<typeof vi.fn>
    } | null,
    events: [] as string[]
}))

vi.mock('@/dsh/utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {
                probeState.events.push('initialize')
            }),
            newSession: vi.fn(async () => {
                probeState.events.push('newSession')
                return 'probe-session-1'
            }),
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: '["deepseek-official","deepseek-flash"]' }],
                currentModelId: '["deepseek-official","deepseek-flash"]'
            })),
            sendExtensionRequest: vi.fn(async (method: string) => {
                probeState.events.push(method)
            }),
            disconnect: vi.fn(async () => {
                probeState.events.push('disconnect')
            })
        }
        probeState.backend = backend
        return backend
    })
}))

import { listDshModelsForMachine } from './dshModels'

describe('listDshModelsForMachine probe', () => {
    it('closes the throwaway probe session before disconnecting', async () => {
        // dsh sessions are durable on disk: a bare disconnect would leave one
        // durable session behind per probe. The advertised session/close must
        // dispose it server-side first.
        const response = await listDshModelsForMachine()

        expect(response.success).toBe(true)
        expect(probeState.events).toEqual(['initialize', 'newSession', 'session/close', 'disconnect'])
        expect(probeState.backend?.sendExtensionRequest).toHaveBeenCalledWith(
            'session/close',
            { sessionId: 'probe-session-1' },
            { timeoutMs: 5000 }
        )
    })
})
