import { describe, expect, it, vi } from 'vitest'

const probeState = vi.hoisted(() => ({
    backend: null as {
        initialize: ReturnType<typeof vi.fn>
        newSession: ReturnType<typeof vi.fn>
        getSessionModelsMetadata: ReturnType<typeof vi.fn>
        getConfigOptionByCategory: ReturnType<typeof vi.fn>
        setConfigOption: ReturnType<typeof vi.fn>
        sendExtensionRequest: ReturnType<typeof vi.fn>
        disconnect: ReturnType<typeof vi.fn>
    } | null,
    events: [] as string[]
}))

vi.mock('@/dsh/utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        // Simulates the stock deepseek adapter: the thought_level option is
        // re-advertised after every model switch. deepseek-flash keeps the
        // full off/high space; the second model (a gateway-patched entry)
        // exposes a different off/max space, so the probe's per-model
        // switch-and-read must capture them independently.
        let currentEffort = 'high'
        const backend = {
            initialize: vi.fn(async () => {
                probeState.events.push('initialize')
            }),
            newSession: vi.fn(async () => {
                probeState.events.push('newSession')
                return 'probe-session-1'
            }),
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [
                    { modelId: '["deepseek-official","deepseek-flash"]' },
                    { modelId: '["deepseek-official","glm-5.4"]' }
                ],
                currentModelId: '["deepseek-official","deepseek-flash"]'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'thought_level') {
                    return {
                        id: 'reasoning_effort',
                        category: 'thought_level',
                        currentValue: currentEffort,
                        options: currentEffort === 'max'
                            ? [{ value: 'off', name: 'Off' }, { value: 'max', name: 'Max' }]
                            : [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }]
                    }
                }
                if (category === 'model') {
                    return { id: 'model', category: 'model', currentValue: '', options: [] }
                }
                return undefined
            }),
            setConfigOption: vi.fn(async (_sessionId: string, _configId: string, value: string) => {
                probeState.events.push(`switch:${value}`)
                if (value.includes('glm-5.4')) currentEffort = 'max'
            }),
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
    it('closes the throwaway probe session before disconnecting and enumerates per-model efforts', async () => {
        // dsh sessions are durable on disk: a bare disconnect would leave one
        // durable session behind per probe. The advertised session/close must
        // dispose it server-side first.
        const response = await listDshModelsForMachine()

        expect(response.success).toBe(true)
        expect(probeState.events).toEqual([
            'initialize',
            'newSession',
            'switch:["deepseek-official","glm-5.4"]',
            'session/close',
            'disconnect'
        ])
        expect(probeState.backend?.sendExtensionRequest).toHaveBeenCalledWith(
            'session/close',
            { sessionId: 'probe-session-1' },
            { timeoutMs: 5000 }
        )
        // The current model's efforts come from the session's own
        // thought_level option; the second model's from the switch response.
        expect(response.availableModels?.[0]).toMatchObject({
            modelId: '["deepseek-official","deepseek-flash"]',
            reasoningEfforts: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }]
        })
        expect(response.availableModels?.[1]).toMatchObject({
            modelId: '["deepseek-official","glm-5.4"]',
            reasoningEfforts: [{ value: 'off', name: 'Off' }, { value: 'max', name: 'Max' }]
        })
    })
})
