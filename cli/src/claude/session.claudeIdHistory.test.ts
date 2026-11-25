import { describe, expect, it } from 'vitest'
import type { Metadata } from '@/api/types'
import { Session } from './session'

function makeSession(initial: Metadata) {
    let metadata = initial
    const session = new Session({
        api: {} as never,
        client: {
            updateMetadata(updater: (current: Metadata) => Metadata) {
                metadata = updater(metadata)
            },
            keepAlive() {},
            emitMessagesConsumed() {}
        } as never,
        path: '/tmp',
        logPath: '/tmp/test.log',
        sessionId: null,
        mcpServers: {},
        messageQueue: { onBatchConsumed: null } as never,
        onModeChange: () => {},
        startedBy: 'terminal',
        startingMode: 'local',
        hookSettingsPath: '/tmp/hooks.json'
    })
    return { session, metadata: () => metadata }
}

describe('Session Claude id rotation', () => {
    it('records the rotated-away Claude id so a resume by it finds this HAPI session', () => {
        const { session, metadata } = makeSession({ path: '/tmp', host: 'h' })

        session.onSessionFound('claude-a')
        expect(metadata().claudeSessionId).toBe('claude-a')
        expect(metadata().claudeSessionIdHistory).toBeUndefined()

        session.onSessionFound('claude-b')
        session.onSessionFound('claude-b')
        session.onSessionFound('claude-c')
        expect(metadata().claudeSessionId).toBe('claude-c')
        expect(metadata().claudeSessionIdHistory).toEqual(['claude-a', 'claude-b'])
    })

    it('never lists the current id as history when Claude returns to an earlier id', () => {
        const { session, metadata } = makeSession({
            path: '/tmp',
            host: 'h',
            claudeSessionId: 'claude-b',
            claudeSessionIdHistory: ['claude-a']
        })

        session.onSessionFound('claude-a')
        expect(metadata().claudeSessionId).toBe('claude-a')
        expect(metadata().claudeSessionIdHistory).toEqual(['claude-b'])
    })
})
