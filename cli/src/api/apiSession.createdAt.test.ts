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

    function fireIncomingUserMessage(
        fakeSocket: { on: ReturnType<typeof vi.fn> },
        message: { seq: number; text: string; sentFrom: 'webapp' | 'telegram-bot' }
    ): void {
        const handler = fakeSocket.on.mock.calls.find((call) => call[0] === 'update')?.[1] as
            | ((data: unknown) => void)
            | undefined
        if (typeof handler !== 'function') {
            throw new Error('ApiSessionClient did not register an update handler')
        }
        handler({
            body: {
                t: 'new-message',
                message: {
                    id: `hub-${message.seq}`,
                    seq: message.seq,
                    localId: null,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: message.text },
                        meta: { sentFrom: message.sentFrom }
                    }
                }
            }
        })
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

    it('local Claude prompt: does not add createdAt and does not stamp isTranscriptEcho', () => {
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
        expect(payload.message).toMatchObject({
            role: 'user',
            meta: { sentFrom: 'cli' }
        })
        expect((payload.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
    })

    it('remote hub prompt: matching Claude transcript row stamps isTranscriptEcho', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('hello from web', 'local-1')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-echo-1',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello from web' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload.message).toMatchObject({
            role: 'user',
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        })
    })

    it('batched same-mode prompts match the joined Claude transcript row', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('one\ntwo')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-batch-1',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'one\ntwo' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload.message).toMatchObject({
            role: 'user',
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        })
    })

    it('formatted Claude prompt (attachments/plan) matches the queue-boundary text, not raw hub text', () => {
        const { client, fakeSocket } = makeClient()
        fireIncomingUserMessage(fakeSocket, { seq: 1, text: 'hello from web', sentFrom: 'webapp' })
        client.notePendingHubPromptEcho('/path/to/file.ts\nhello from web', 'local-1')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-echo-fmt',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: '/path/to/file.ts\nhello from web' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload.message).toMatchObject({
            role: 'user',
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        })
    })

    it('raw hub delivery alone does not stamp isTranscriptEcho', () => {
        const { client, fakeSocket } = makeClient()
        fireIncomingUserMessage(fakeSocket, { seq: 1, text: 'hello from web', sentFrom: 'webapp' })

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-raw-1',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello from web' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect((payload.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
    })

    it('cancelled queued prompt does not misclassify a later matching local prompt', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('hello from web', ['local-1', 'local-2'])
        client.discardPendingHubPromptEcho('local-2')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-local-cancel',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello from web' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect((payload.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
    })

    it('rebatched restored prompt replaces the original echo marker', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('hello from web', 'local-1')
        client.notePendingHubPromptEcho('hello from web\nqueued while retrying', ['local-1', 'local-2'])

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-rebatch-combined',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello from web\nqueued while retrying' }
        } as unknown as RawJSONLines)

        const [, combined] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(combined.message).toMatchObject({
            role: 'user',
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        })

        fakeSocket.emit.mockClear()
        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-local-after-rebatch',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:01.000Z',
            message: { role: 'user', content: 'hello from web' }
        } as unknown as RawJSONLines)

        const [, local] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect((local.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
    })

    it('id-less rebatch replaces the previous id-less echo marker', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('hello from web')
        client.notePendingHubPromptEcho('hello from web\nqueued while retrying')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-idless-combined',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello from web\nqueued while retrying' }
        } as unknown as RawJSONLines)

        const [, combined] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect(combined.message).toMatchObject({
            role: 'user',
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        })

        fakeSocket.emit.mockClear()
        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-local-after-idless',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:01.000Z',
            message: { role: 'user', content: 'hello from web' }
        } as unknown as RawJSONLines)

        const [, local] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect((local.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
    })

    it('id-less dropped marker does not misclassify a later matching local prompt', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('hello from web')
        client.discardPendingHubPromptEchoText('hello from web')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-local-after-idless-drop',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'hello from web' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect((payload.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
    })

    it('unmatched local Claude prompt stays unmarked when a different hub prompt is pending', () => {
        const { client, fakeSocket } = makeClient()
        client.notePendingHubPromptEcho('hello from web', 'local-1')

        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'user-local-1',
            userType: 'external',
            isSidechain: false,
            timestamp: '2024-03-10T00:00:00.000Z',
            message: { role: 'user', content: 'typed in the TTY' }
        } as unknown as RawJSONLines)

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, Record<string, unknown>]
        expect((payload.message as { meta?: { isTranscriptEcho?: boolean } }).meta?.isTranscriptEcho)
            .not.toBe(true)
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

    it('adds an explicit native transcript local id only when supplied by the scanner', () => {
        const { client, fakeSocket } = makeClient()
        const body = {
            type: 'assistant',
            uuid: 'assistant-native',
            message: { role: 'assistant', content: 'hi' }
        } as unknown as RawJSONLines

        client.sendClaudeSessionMessage(body, {
            claudeTranscriptLocalId: 'claude:native-session:assistant-native'
        })

        const [, payload] = fakeSocket.emit.mock.calls[0] as [string, {
            message: { meta: { claudeTranscriptLocalId?: string } }
        }]
        expect(payload.message.meta.claudeTranscriptLocalId).toBe('claude:native-session:assistant-native')
    })
})
