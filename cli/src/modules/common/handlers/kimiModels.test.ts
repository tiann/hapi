import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))
vi.mock('@/kimi/utils/config', () => ({
    readKimiLocalConfig: () => ({ model: 'GLM-5.3-flash' })
}))

import { _resetKimiModelsCacheForTests } from '../kimiModels'
import { registerKimiSessionModelHandlers } from './kimiModels'

class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    kill = vi.fn()
}

/** Real `kimi provider list --json` shape, including fields HAPI must strip. */
const PROVIDER_PAYLOAD = JSON.stringify({
    providers: {
        thehive: {
            baseUrl: 'https://api.thehive.example/v1',
            type: 'openai',
            apiKey: 'sk-secret-thehive-key'
        }
    },
    models: {
        'GLM-5.3-flash': {
            provider: 'thehive',
            model: 'zai-org/glm-5.3-flash',
            displayName: 'thehive / GLM-5.3-flash',
            capabilities: ['tool_use']
        }
    }
})

function registerSessionHandlers(cwd: string): (params: unknown) => Promise<unknown> {
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>()
    const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => {
            handlers.set(method, handler)
        }
    } as unknown as RpcHandlerManager

    registerKimiSessionModelHandlers(rpcHandlerManager, () => cwd)

    const handler = handlers.get(RPC_METHODS.ListKimiModels)
    if (!handler) {
        throw new Error(`session handler ${RPC_METHODS.ListKimiModels} was not registered`)
    }
    return handler
}

beforeEach(() => {
    spawnMock.mockReset()
    _resetKimiModelsCacheForTests()
})

describe('registerKimiSessionModelHandlers', () => {
    it('answers the catalog over the session connection without a runner', async () => {
        const handler = registerSessionHandlers('/work/project')
        const child = new FakeChild()
        spawnMock.mockImplementation(() => child)

        const pending = handler(undefined)
        child.stdout.emit('data', PROVIDER_PAYLOAD)
        child.emit('close', 0, null)

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{
                modelId: 'GLM-5.3-flash',
                name: 'thehive / GLM-5.3-flash',
                provider: 'thehive'
            }],
            currentModelId: 'GLM-5.3-flash'
        })
        expect(spawnMock).toHaveBeenCalledWith(
            'kimi',
            ['provider', 'list', '--json'],
            expect.any(Object)
        )
    })

    it('returns only modelId, name and provider — never provider credentials', async () => {
        const handler = registerSessionHandlers('/work/project')
        const child = new FakeChild()
        spawnMock.mockImplementation(() => child)

        const pending = handler(undefined)
        child.stdout.emit('data', PROVIDER_PAYLOAD)
        child.emit('close', 0, null)

        const response = await pending
        const serialized = JSON.stringify(response)
        expect(serialized).not.toContain('sk-secret-thehive-key')
        expect(serialized).not.toContain('api.thehive.example')
        expect(serialized).not.toContain('baseUrl')
        expect(serialized).not.toContain('capabilities')
        expect(serialized).not.toContain('zai-org/glm-5.3-flash')
        expect(Object.keys((response as { availableModels: Array<object> }).availableModels[0]!).sort())
            .toEqual(['modelId', 'name', 'provider'])
    })

    it('reports a malformed probe as a failed response instead of throwing', async () => {
        const handler = registerSessionHandlers('/work/project')
        const child = new FakeChild()
        spawnMock.mockImplementation(() => child)

        const pending = handler(undefined)
        child.stdout.emit('data', '{"models":')
        child.emit('close', 0, null)
        await expect(pending).resolves.toEqual({
            success: false,
            error: 'kimi provider list produced invalid JSON output'
        })
    })

    it('scopes the probe to the session cwd and ignores cwd sent by the caller', async () => {
        const handler = registerSessionHandlers('')

        await expect(handler({ cwd: '/etc' })).resolves.toEqual({
            success: false,
            error: 'cwd is required'
        })
        expect(spawnMock).not.toHaveBeenCalled()
    })
})
