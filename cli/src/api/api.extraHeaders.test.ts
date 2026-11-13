import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

const axiosPostMock = vi.hoisted(() => vi.fn())
const ioMock = vi.hoisted(() => vi.fn())

vi.mock('@/utils/time', async (original) => ({
    ...await original<typeof import('@/utils/time')>(), monotonicTimeMs: () => Date.now()
}))

vi.mock('axios', () => ({
    default: {
        post: axiosPostMock,
        isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError)
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

    it('waits for confirmed shutdown preparation using CLI authentication and extra headers', async () => {
        configuration._setExtraHeaders({ Cookie: 'fixture' })
        let release!: () => void
        axiosPostMock.mockImplementation((_url, body) => new Promise((resolve) => {
            release = () => resolve({ data: { status: 'ready', preparationLease: body.preparationLease } })
        }))
        const client = await ApiClient.create()
        let done = false
        const request = client.prepareOpenCodeSessionStop('session/1', 'machine-1', 123, 'gen-a').then(() => { done = true })
        await Promise.resolve()
        expect(done).toBe(false)
        expect(axiosPostMock).toHaveBeenCalledWith('https://hapi.example.com/cli/sessions/session%2F1/prepare-stop',
            expect.objectContaining({ machineId: 'machine-1', pid: 123, processStartMarker: 'gen-a',
                preparationLease: expect.objectContaining({ id: expect.any(String), expiresAt: expect.any(Number) }) }),
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer cli-token', Cookie: 'fixture' }) }))
        release()
        await request
        expect(done).toBe(true)
    })

    it('propagates unconfirmed preparation but permits cleanup of a removed Hub row', async () => {
        const client = await ApiClient.create()
        axiosPostMock.mockResolvedValueOnce({ data: { error: 'drain failed' } })
        await expect(client.prepareOpenCodeSessionStop('session-1', 'machine-1', 123, 'gen-a')).rejects.toThrow('not confirmed')
        axiosPostMock.mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } })
        await expect(client.prepareOpenCodeSessionStop('session-1', 'machine-1', 123, 'gen-a')).rejects.toMatchObject({ response: { status: 503 } })
        axiosPostMock.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } })
        await expect(client.prepareOpenCodeSessionStop('session-1', 'machine-1', 123, 'gen-a')).resolves.toBeUndefined()
    })

    it('rejects a ready response received after its caller lease expired', async () => {
        vi.useFakeTimers()
        try {
            const client = await ApiClient.create()
            axiosPostMock.mockImplementation(async (_url, body) => {
                vi.advanceTimersByTime(30000)
                return { data: { status: 'ready', preparationLease: body.preparationLease } }
            })
            await expect(client.prepareOpenCodeSessionStop('session-1', 'machine-1', 123, 'gen-a')).rejects.toThrow('lease was not confirmed')
        } finally { vi.useRealTimers() }
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

    it('uses the CLI REST bridge to request a fresh OpenCode session after source cleanup', async () => {
        axiosPostMock.mockResolvedValue({ data: { ok: true, sessionId: 'fresh-session' } })

        const client = await ApiClient.create()
        await expect(client.clearOpenCodeSession('source-session')).resolves.toBe('fresh-session')

        expect(axiosPostMock).toHaveBeenCalledWith(
            'https://hapi.example.com/cli/sessions/source-session/clear-opencode',
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer cli-token' })
            })
        )
    })

    it('uses the CLI REST bridge to reserve before source cleanup', async () => {
        axiosPostMock.mockResolvedValue({ data: { ok: true, sessionId: 'fresh-session' } })
        const client = await ApiClient.create()
        await expect(client.reserveOpenCodeClearSession('source-session')).resolves.toBe('fresh-session')
        expect(axiosPostMock).toHaveBeenCalledWith(
            'https://hapi.example.com/cli/sessions/source-session/clear-opencode/reserve', {},
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer cli-token' }) })
        )
    })

    it.each(['confirmOpenCodeClearCleanup', 'abortOpenCodeClearSession'] as const)('sends reservation identity with %s', async (method) => {
        axiosPostMock.mockResolvedValue({ data: { ok: true, sessionId: 'fresh-session' } })
        const client = await ApiClient.create()
        await expect(client[method]('source-session', 'fresh-session')).resolves.toBe('fresh-session')
        expect(axiosPostMock).toHaveBeenCalledWith(
            expect.stringContaining('/clear-opencode/'),
            { replacementSessionId: 'fresh-session' },
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer cli-token' }) })
        )
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
            serviceTier: null,
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
