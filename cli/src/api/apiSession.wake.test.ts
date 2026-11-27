import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

// wake() forces an immediate socket reconnect when the runner daemon relays
// the hub's 'session-wake' (queued messages, session socket down). It must
// bypass the socket.io reconnection backoff, stay a no-op while connected,
// and throttle bursts of wakes for the same message queue.

const ioMock = vi.hoisted(() => vi.fn())

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

import { ApiSessionClient } from './apiSession'

function makeClient(connected = false) {
    const fakeSocket = {
        connected,
        on: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        emit: vi.fn(),
        volatile: { emit: vi.fn() }
    }
    ioMock.mockReturnValue(fakeSocket)
    const now = 1_710_000_000_000
    const client = new ApiSessionClient('cli-token', {
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
    // The constructor auto-connects once for active sessions; clear the
    // counters so tests observe only post-construction wake() calls.
    fakeSocket.connect.mockClear()
    fakeSocket.disconnect.mockClear()
    return { client, fakeSocket }
}

describe('ApiSessionClient.wake', () => {
    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        ioMock.mockReset()
    })

    it('forces an immediate reconnect attempt when disconnected', () => {
        const { client, fakeSocket } = makeClient(false)

        client.wake()

        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1)
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1)
    })

    it('is a no-op while the socket is connected', () => {
        const { client, fakeSocket } = makeClient(true)

        client.wake()

        expect(fakeSocket.disconnect).not.toHaveBeenCalled()
        expect(fakeSocket.connect).not.toHaveBeenCalled()
    })

    it('throttles repeated wakes but recovers after the window passes', () => {
        vi.useFakeTimers()
        try {
            const { client, fakeSocket } = makeClient(false)

            client.wake()
            client.wake()

            expect(fakeSocket.connect).toHaveBeenCalledTimes(1)

            vi.advanceTimersByTime(2_500)
            client.wake()

            expect(fakeSocket.connect).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })
})
