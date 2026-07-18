import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => void>(),
    ioMock: vi.fn()
}))

vi.mock('socket.io-client', () => ({
    io: harness.ioMock
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
        create(): void { }
        write(): void { }
        resize(): void { }
        close(): void { }
        closeAll(): void { }
    }
}))

import { configuration } from '@/configuration'
import { ApiSessionClient } from './apiSession'
import type { Session } from './types'

const now = 1_710_000_000_000

function createSession(metadata: Session['metadata'] = null): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata,
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

function createClient(metadata: Session['metadata'] = null) {
    harness.handlers.clear()
    const fakeSocket = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            harness.handlers.set(event, handler)
        }),
        connect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn().mockImplementation((_event: string, payload: { metadata?: unknown }) => Promise.resolve({
            result: 'success',
            version: 1,
            metadata: payload?.metadata ?? metadata
        })),
        volatile: { emit: vi.fn() }
    }
    harness.ioMock.mockReturnValue(fakeSocket)

    const client = new ApiSessionClient('cli-token', createSession(metadata))
    return { client, fakeSocket }
}

function emitUpdate(content: unknown, seq = 1, localId: string | null = null) {
    const updateHandler = harness.handlers.get('update')
    if (!updateHandler) {
        throw new Error('update handler was not registered')
    }
    updateHandler({
        body: {
            t: 'new-message',
            sid: 'session-1',
            message: {
                id: `message-${seq}`,
                seq,
                createdAt: now + seq,
                localId,
                content
            }
        }
    })
}

describe('ApiSessionClient incoming user messages', () => {
    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        configuration._setExtraHeaders({})
        harness.ioMock.mockReset()
        harness.handlers.clear()
    })

    it('enqueues webapp-origin user messages for the local agent', () => {
        const { client } = createClient()
        const received: unknown[] = []
        client.onUserMessage((message) => {
            received.push(message)
        })

        emitUpdate({
            role: 'user',
            content: {
                type: 'text',
                text: 'run this from the phone'
            },
            meta: {
                sentFrom: 'webapp'
            }
        })

        expect(received).toHaveLength(1)
        expect(received[0]).toMatchObject({
            content: {
                text: 'run this from the phone'
            },
            meta: {
                sentFrom: 'webapp'
            }
        })
    })

    it('does not re-enqueue cli-origin synced transcript messages', () => {
        const { client } = createClient()
        const received: unknown[] = []
        client.onUserMessage((message) => {
            received.push(message)
        })

        emitUpdate({
            role: 'user',
            content: {
                type: 'text',
                text: 'message typed in Codex desktop'
            },
            meta: {
                sentFrom: 'cli'
            }
        })

        expect(received).toEqual([])
    })

    it('does not re-enqueue passive Codex desktop sync messages if they are ever replayed', () => {
        const { client } = createClient()
        const received: unknown[] = []
        client.onUserMessage((message) => {
            received.push(message)
        })

        emitUpdate({
            role: 'user',
            content: {
                type: 'text',
                text: 'desktop sync replay'
            },
            meta: {
                sentFrom: 'codex-desktop-sync'
            }
        })

        expect(received).toEqual([])
    })

    it('does not re-enqueue passive Codex desktop sync messages identified only by codex localId', () => {
        const { client } = createClient()
        const received: unknown[] = []
        client.onUserMessage((message) => {
            received.push(message)
        })

        emitUpdate({
            role: 'user',
            content: {
                type: 'text',
                text: 'desktop sync replay without meta'
            }
        }, 1, 'codex:thread-1:12:abc123')

        expect(received).toEqual([])
    })

    it('skips socket metadata updates when the handler returns the current metadata object unchanged', async () => {
        const metadata = {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            title: 'Same title',
            titleUpdatedAt: now
        }
        const { client, fakeSocket } = createClient(metadata)

        client.updateMetadata((current) => current)
        await Promise.resolve()
        await Promise.resolve()

        expect(fakeSocket.emitWithAck).not.toHaveBeenCalled()
    })

    it('skips socket metadata updates when the handler returns a deep-equal metadata clone', async () => {
        const metadata = {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            title: 'Same title',
            titleUpdatedAt: now
        }
        const { client, fakeSocket } = createClient(metadata)

        client.updateMetadata((current) => ({ ...current }))
        await Promise.resolve()
        await Promise.resolve()

        expect(fakeSocket.emitWithAck).not.toHaveBeenCalled()
    })

    it('sends socket metadata updates when the handler mutates the working metadata object', async () => {
        const metadata = {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            title: 'Old title',
            titleUpdatedAt: now
        }
        const { client, fakeSocket } = createClient(metadata)

        client.updateMetadata((current) => {
            current.title = 'New title'
            return current
        })
        await Promise.resolve()
        await Promise.resolve()

        expect(fakeSocket.emitWithAck).toHaveBeenCalledTimes(1)
        expect(fakeSocket.emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            metadata: expect.objectContaining({
                title: 'New title'
            })
        }))
        expect(metadata.title).toBe('Old title')
    })
})
