import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

const axiosPostMock = vi.hoisted(() => vi.fn())
const ioMock = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
    default: {
        post: axiosPostMock
    }
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect(): void { }
        onSocketDisconnect(): void { }
        registerHandler(): void { }
        handleRequest(): Promise<string> {
            return Promise.resolve('{}')
        }
    }
}))

vi.mock('../modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: () => { }
}))

vi.mock('@/terminal/TerminalManager', () => ({
    TerminalManager: class {
        closeAll(): void { }
    }
}))

import { ApiClient } from './api'
import { ApiSessionClient } from './apiSession'

describe('API extra headers integration', () => {
    const now = 1_710_000_000_000

    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        configuration._setExtraHeaders({})
        axiosPostMock.mockReset()
        ioMock.mockReset()
    })

    it('adds extra headers to REST requests', async () => {
        configuration._setExtraHeaders({
            Cookie: 'CF_Authorization=token'
        })

        axiosPostMock.mockResolvedValue({
            data: {
                session: {
                    id: 'session-1',
                    namespace: 'default',
                    seq: 1,
                    createdAt: now,
                    updatedAt: now,
                    active: true,
                    activeAt: now,
                    metadata: {
                        path: '/tmp/project',
                        host: 'test-host'
                    },
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: now,
                    todos: [],
                    model: null,
                    modelReasoningEffort: null,
                    effort: null,
                    permissionMode: undefined,
                    collaborationMode: undefined
                }
            }
        })

        const client = await ApiClient.create()
        await client.getOrCreateSession({
            tag: 'test',
            metadata: {
                path: '/tmp/project',
                host: 'test-host'
            },
            state: null
        })

        expect(axiosPostMock).toHaveBeenCalledOnce()
        expect(axiosPostMock.mock.calls[0]?.[2]).toMatchObject({
            headers: {
                Cookie: 'CF_Authorization=token',
                Authorization: 'Bearer cli-token',
                'Content-Type': 'application/json'
            }
        })
    })

    it('adds extra headers to socket transport options', () => {
        configuration._setExtraHeaders({
            Cookie: 'CF_Authorization=token'
        })

        const fakeSocket = {
            on: vi.fn(),
            connect: vi.fn(),
            emit: vi.fn(),
            volatile: { emit: vi.fn() }
        }
        ioMock.mockReturnValue(fakeSocket)

        new ApiSessionClient('cli-token', {
            id: 'session-1',
            namespace: 'default',
            seq: 1,
            createdAt: now,
            updatedAt: now,
            active: true,
            activeAt: now,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: now,
            todos: [],
            model: null,
            modelReasoningEffort: null,
            effort: null,
            permissionMode: undefined,
            collaborationMode: undefined
        })

        expect(ioMock).toHaveBeenCalledOnce()
        expect(ioMock.mock.calls[0]?.[1]).toMatchObject({
            extraHeaders: {
                Cookie: 'CF_Authorization=token'
            }
        })
    })
})
