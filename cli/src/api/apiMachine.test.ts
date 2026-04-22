import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeSocket = {
    handlers: Map<string, (...args: any[]) => void>
    emitted: Array<{ event: string, payload: unknown }>
    on: (event: string, handler: (...args: any[]) => void) => FakeSocket
    emit: (event: string, payload: unknown) => void
    emitWithAck: (event: string, payload: unknown) => Promise<unknown>
    close: () => void
}

const listImportableCodexSessionsMock = vi.hoisted(() => vi.fn())
const listImportableClaudeSessionsMock = vi.hoisted(() => vi.fn())
const fakeSocket = vi.hoisted<FakeSocket>(() => ({
    handlers: new Map(),
    emitted: [],
    on(event, handler) {
        this.handlers.set(event, handler)
        return this
    },
    emit(event, payload) {
        this.emitted.push({ event, payload })
    },
    emitWithAck: vi.fn(async (event: string) => {
        if (event === 'machine-update-state') {
            return { result: 'success', version: 1, runnerState: null }
        }

        if (event === 'machine-update-metadata') {
            return { result: 'success', version: 1, metadata: null }
        }

        return { result: 'success', version: 1 }
    }),
    close() {}
}))

const importableSessionsResponse = {
    sessions: [
        {
            agent: 'codex',
            externalSessionId: 'codex-session-1',
            cwd: '/work/project',
            timestamp: 1712131200000,
            transcriptPath: '/sessions/codex-session-1.jsonl',
            previewTitle: 'Project draft',
            previewPrompt: 'Build the project'
        }
    ]
}

const importableClaudeSessionsResponse = {
    sessions: [
        {
            agent: 'claude',
            externalSessionId: 'claude-session-1',
            cwd: '/work/project',
            timestamp: 1712131200000,
            transcriptPath: '/sessions/claude-session-1.jsonl',
            previewTitle: 'Continue the refactor',
            previewPrompt: 'Continue the refactor'
        }
    ]
}

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => fakeSocket)
}))

vi.mock('@/codex/utils/listImportableCodexSessions', () => ({
    listImportableCodexSessions: listImportableCodexSessionsMock
}))

vi.mock('@/claude/utils/listImportableClaudeSessions', () => ({
    listImportableClaudeSessions: listImportableClaudeSessionsMock
}))

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}))

vi.mock('@/utils/invokedCwd', () => ({
    getInvokedCwd: vi.fn(() => '/workspace')
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}))

import { ApiMachineClient } from './apiMachine'

describe('ApiMachineClient list-importable-sessions RPC', () => {
    beforeEach(() => {
        fakeSocket.handlers.clear()
        fakeSocket.emitted.length = 0
        vi.mocked(fakeSocket.emitWithAck).mockClear()
        listImportableCodexSessionsMock.mockReset()
        listImportableClaudeSessionsMock.mockReset()
        listImportableCodexSessionsMock.mockResolvedValue(importableSessionsResponse)
        listImportableClaudeSessionsMock.mockResolvedValue(importableClaudeSessionsResponse)
    })

    it('registers the RPC during connect and returns scanner results by agent', async () => {
        const machine = {
            id: 'machine-1',
            metadata: null,
            metadataVersion: 0,
            runnerState: null,
            runnerStateVersion: 0
        } as never

        const client = new ApiMachineClient('token', machine)
        client.connect()

        const connectHandler = fakeSocket.handlers.get('connect')
        expect(connectHandler).toBeTypeOf('function')
        connectHandler?.()

        expect(fakeSocket.emitted).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    event: 'rpc-register',
                    payload: { method: 'machine-1:path-exists' }
                }),
                expect.objectContaining({
                    event: 'rpc-register',
                    payload: { method: 'machine-1:list-importable-sessions' }
                })
            ])
        )

        const rpcRequestHandler = fakeSocket.handlers.get('rpc-request')
        expect(rpcRequestHandler).toBeTypeOf('function')

        const codexResponse = await new Promise<string>((resolve) => {
            rpcRequestHandler?.(
                {
                    method: 'machine-1:list-importable-sessions',
                    params: JSON.stringify({ agent: 'codex' })
                },
                resolve
            )
        })

        expect(codexResponse).toBe(JSON.stringify(importableSessionsResponse))

        const missingAgentResponse = await new Promise<string>((resolve) => {
            rpcRequestHandler?.(
                {
                    method: 'machine-1:list-importable-sessions',
                    params: JSON.stringify({})
                },
                resolve
            )
        })

        expect(missingAgentResponse).toBe(JSON.stringify({ sessions: [] }))
        expect(listImportableCodexSessionsMock).toHaveBeenCalledTimes(1)

        const claudeResponse = await new Promise<string>((resolve) => {
            rpcRequestHandler?.(
                {
                    method: 'machine-1:list-importable-sessions',
                    params: JSON.stringify({ agent: 'claude' })
                },
                resolve
            )
        })

        expect(JSON.parse(claudeResponse)).toEqual(importableClaudeSessionsResponse)
        expect(listImportableClaudeSessionsMock).toHaveBeenCalledTimes(1)

        client.shutdown()
    })
})
