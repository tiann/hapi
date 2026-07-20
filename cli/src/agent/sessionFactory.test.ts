import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/api/types'

const {
    getSessionMock,
    getOrCreateSessionMock,
    getOrCreateMachineMock,
    sessionSyncClientMock,
    notifyRunnerSessionStartedMock,
    readSettingsMock
} = vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    getOrCreateSessionMock: vi.fn(),
    getOrCreateMachineMock: vi.fn(),
    sessionSyncClientMock: vi.fn(),
    notifyRunnerSessionStartedMock: vi.fn(async () => ({})),
    readSettingsMock: vi.fn()
}))

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getSession: getSessionMock,
            getOrCreateSession: getOrCreateSessionMock,
            getOrCreateMachine: getOrCreateMachineMock,
            sessionSyncClient: sessionSyncClientMock
        })
    }
}))

vi.mock('@/runner/controlClient', () => ({
    notifyRunnerSessionStarted: notifyRunnerSessionStartedMock
}))

vi.mock('@/persistence', () => ({
    readSettings: readSettingsMock
}))

vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: '/tmp/.hapi',
        logsDir: '/tmp/.hapi/logs',
        isRunnerProcess: false
    }
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}))

import { bootstrapExistingSession, bootstrapLazySession, buildSessionMetadata } from './sessionFactory'

function createSession(): Session {
    return {
        id: 'hapi-session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            machineId: 'machine-1',
            flavor: 'codex',
            codexSessionId: 'codex-thread-1'
        },
        metadataVersion: 1,
        agentState: { controlledByUser: false },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined
    }
}

describe('bootstrapExistingSession', () => {
    beforeEach(() => {
        getSessionMock.mockReset()
        getOrCreateSessionMock.mockReset()
        getOrCreateMachineMock.mockReset()
        sessionSyncClientMock.mockReset()
        notifyRunnerSessionStartedMock.mockClear()
        readSettingsMock.mockReset()
    })

    it('loads an existing HAPI session and reports it to the runner', async () => {
        const session = createSession()
        const sessionClient = {
            updateMetadata: vi.fn()
        }
        getSessionMock.mockResolvedValue(session)
        getOrCreateMachineMock.mockResolvedValue({ id: 'machine-1' })
        sessionSyncClientMock.mockReturnValue(sessionClient)
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' })

        const result = await bootstrapExistingSession({
            sessionId: 'hapi-session-1',
            flavor: 'codex',
            workingDirectory: '/tmp/project'
        })

        expect(result.sessionInfo.id).toBe('hapi-session-1')
        expect(result.workingDirectory).toBe('/tmp/project')
        expect(sessionSyncClientMock).toHaveBeenCalledWith(session)
        expect(sessionClient.updateMetadata).toHaveBeenCalledOnce()
        expect(notifyRunnerSessionStartedMock).toHaveBeenCalledWith(
            'hapi-session-1',
            expect.objectContaining({
                path: '/tmp/project',
                flavor: 'codex',
                startedBy: 'terminal',
                startedFromRunner: false,
                machineId: 'machine-1'
            })
        )
    })

    it('preserves existing native resume metadata when reactivating a session', async () => {
        const session = createSession()
        const existingMetadata = session.metadata
        if (!existingMetadata) throw new Error('expected test session metadata')

        session.metadata = {
            ...existingMetadata,
            claudeSessionId: 'claude-thread-1',
            codexSessionId: 'codex-thread-1',
            geminiSessionId: 'gemini-thread-1',
            opencodeSessionId: 'opencode-thread-1',
            grokSessionId: 'grok-thread-1',
            cursorSessionId: 'cursor-thread-1',
            cursorSessionProtocol: 'acp',
            summary: {
                text: 'resume me',
                updatedAt: 100
            },
            tools: ['read_file'],
            slashCommands: ['/compact']
        }
        const sessionClient = {
            updateMetadata: vi.fn()
        }
        getSessionMock.mockResolvedValue(session)
        getOrCreateMachineMock.mockResolvedValue({ id: 'machine-1' })
        sessionSyncClientMock.mockReturnValue(sessionClient)
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' })

        const result = await bootstrapExistingSession({
            sessionId: 'hapi-session-1',
            flavor: 'codex',
            workingDirectory: '/tmp/project'
        })

        expect(result.metadata).toEqual(expect.objectContaining({
            claudeSessionId: 'claude-thread-1',
            codexSessionId: 'codex-thread-1',
            geminiSessionId: 'gemini-thread-1',
            opencodeSessionId: 'opencode-thread-1',
            grokSessionId: 'grok-thread-1',
            cursorSessionId: 'cursor-thread-1',
            cursorSessionProtocol: 'acp',
            summary: {
                text: 'resume me',
                updatedAt: 100
            },
            tools: ['read_file'],
            slashCommands: ['/compact']
        }))
        expect(sessionClient.updateMetadata).toHaveBeenCalledOnce()
        const updateHandler = sessionClient.updateMetadata.mock.calls[0][0]
        expect(updateHandler(session.metadata)).toEqual(expect.objectContaining({
            codexSessionId: 'codex-thread-1',
            grokSessionId: 'grok-thread-1'
        }))
        expect(notifyRunnerSessionStartedMock).toHaveBeenCalledWith(
            'hapi-session-1',
            expect.objectContaining({
                codexSessionId: 'codex-thread-1',
                grokSessionId: 'grok-thread-1'
            })
        )
    })

    it('advertises remote terminal capability in session metadata', () => {
        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            now: 123
        })

        expect(metadata.capabilities?.terminal).toBe(true)
    })
})

describe('bootstrapLazySession', () => {
    beforeEach(() => {
        getOrCreateSessionMock.mockReset()
        getOrCreateMachineMock.mockReset()
        sessionSyncClientMock.mockReset()
        notifyRunnerSessionStartedMock.mockClear()
        readSettingsMock.mockReset()
    })

    it('does not persist a machine or session until materialization', async () => {
        const pendingClient = { isPending: () => true }
        sessionSyncClientMock.mockReturnValue(pendingClient)
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' })

        const result = await bootstrapLazySession({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            agentState: { controlledByUser: false }
        })

        expect(result.session).toBe(pendingClient)
        expect(getOrCreateMachineMock).not.toHaveBeenCalled()
        expect(getOrCreateSessionMock).not.toHaveBeenCalled()
        expect(notifyRunnerSessionStartedMock).not.toHaveBeenCalled()

        const [provisional, options] = sessionSyncClientMock.mock.calls[0]
        expect(provisional.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(provisional.metadata).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex'
        }))

        const materialized = createSession()
        materialized.id = provisional.id
        getOrCreateSessionMock.mockResolvedValue(materialized)
        const snapshot = {
            metadata: {
                ...provisional.metadata,
                codexSessionId: 'codex-thread-1'
            },
            agentState: { controlledByUser: true }
        }
        await options.materialize(snapshot, new AbortController().signal)

        expect(getOrCreateSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            id: provisional.id,
            metadata: snapshot.metadata,
            state: snapshot.agentState,
            timeoutMs: 10_000,
            machine: expect.objectContaining({ id: 'machine-1' })
        }))

        options.onMaterialized(materialized, snapshot)
        expect(notifyRunnerSessionStartedMock).toHaveBeenCalledWith(
            provisional.id,
            expect.objectContaining({ codexSessionId: 'codex-thread-1' })
        )
    })
})
