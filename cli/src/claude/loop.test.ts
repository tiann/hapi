import { describe, expect, it, vi } from 'vitest'

const runLocalRemoteSessionMock = vi.hoisted(() => vi.fn(async (options: { session: { stopKeepAlive: () => void } }) => {
    options.session.stopKeepAlive()
}))

vi.mock('@/agent/loopBase', () => ({
    runLocalRemoteSession: runLocalRemoteSessionMock
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        logFilePath: '/tmp/hapi.log',
        debug: vi.fn()
    }
}))

vi.mock('./claudeLocalLauncher', () => ({
    claudeLocalLauncher: vi.fn()
}))

vi.mock('./claudeRemoteLauncher', () => ({
    claudeRemoteLauncher: vi.fn()
}))

import { loop } from './loop'

describe('claude loop', () => {
    it('initializes the Claude session id from resumeSessionId', async () => {
        const sessionClient = {
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            updateMetadata: vi.fn()
        }

        await loop({
            path: '/tmp/project',
            startingMode: 'local',
            onModeChange: () => {},
            mcpServers: {},
            session: sessionClient as never,
            api: {} as never,
            messageQueue: {} as never,
            hookSettingsPath: '/tmp/hooks.json',
            resumeSessionId: '11111111-1111-4111-8111-111111111111'
        })

        expect(runLocalRemoteSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            session: expect.objectContaining({
                sessionId: '11111111-1111-4111-8111-111111111111'
            })
        }))
    })
})
