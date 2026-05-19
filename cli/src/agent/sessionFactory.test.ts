import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/api/types'

const {
    getSessionMock,
    getOrCreateMachineMock,
    sessionSyncClientMock,
    notifyRunnerSessionStartedMock,
    readSettingsMock
} = vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    getOrCreateMachineMock: vi.fn(),
    sessionSyncClientMock: vi.fn(),
    notifyRunnerSessionStartedMock: vi.fn(async () => ({})),
    readSettingsMock: vi.fn()
}))

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getSession: getSessionMock,
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

import { bootstrapExistingSession, buildSessionMetadata } from './sessionFactory'

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
        permissionMode: undefined,
        collaborationMode: undefined
    }
}

describe('bootstrapExistingSession', () => {
    beforeEach(() => {
        getSessionMock.mockReset()
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
