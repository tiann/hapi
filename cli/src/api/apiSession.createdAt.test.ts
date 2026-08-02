import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'
import type { RawJSONLines } from '@/claude/types'

// Transcript messages must forward the
// transcript entry's own `timestamp` (converted to epoch ms) as `createdAt` on
// the socket 'message' emit, but ONLY for the agent (non-external-user) path —
// see hub/src/store/messages.ts addMessage (Phase 1), which honors this value
// for created_at/invoked_at so display order follows jsonl order instead of
// hub-receive order.

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

describe('sendClaudeSessionMessage createdAt propagation', () => {
    const now = 1_710_000_000_000

    function makeClient() {
        const fakeSocket = {
            on: vi.fn(),
            connect: vi.fn(),
            emit: vi.fn(),
            volatile: { emit: vi.fn() }
        }
        ioMock.mockReturnValue(fakeSocket)
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
        return { client, fakeSocket }
    }

    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        ioMock.mockReset()
    })

    it('agent message: converts the transcript entry ISO timestamp to epoch ms createdAt', () => {
        const { client, fakeSocket } = makeClient()
        const body = {
            type: 'assistant',
            uuid: 'assistant-1',
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'assistant', content: 'hi' }
        } as unknown as RawJSONLines

        client.sendClaudeSessionMessage(body)

        expect(fakeSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
            sid: 'session-1',
            createdAt: Date.parse('2024-03-10T00:00:00.000Z')
        }))
    })

    it('external user message (echoed prompt): does not add createdAt — path is unchanged', () => {
        const { client, fakeSocket } = makeClient()
        const body = {
            type: 'user',
            uuid: 'user-1',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello' }
        } as unknown as RawJSONLines

        client.sendClaudeSessionMessage(body)

        expect(fakeSocket.emit).toHaveBeenCalledTimes(1)
        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload.sid).toBe('session-1')
        expect(payload).not.toHaveProperty('createdAt')
    })

    it('agent message without a parseable timestamp: omits createdAt (hub falls back to Date.now())', () => {
        const { client, fakeSocket } = makeClient()
        const body = {
            type: 'assistant',
            uuid: 'assistant-2',
            message: { role: 'assistant', content: 'hi' }
        } as unknown as RawJSONLines

        client.sendClaudeSessionMessage(body)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload).not.toHaveProperty('createdAt')
    })
})
