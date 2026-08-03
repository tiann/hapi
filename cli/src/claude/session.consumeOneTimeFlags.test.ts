import { describe, expect, it } from 'vitest'
import { Session } from './session'

function makeSession(claudeArgs: string[] | undefined): Session {
    return new Session({
        api: {} as never,
        client: {
            updateMetadata() {},
            keepAlive() {},
            emitMessagesConsumed() {}
        } as never,
        path: '/tmp',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeArgs,
        mcpServers: {},
        messageQueue: { onBatchConsumed: null } as never,
        onModeChange: () => {},
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hooks.json'
    })
}

describe('Session.consumeOneTimeFlags', () => {
    it('consumes --resume and --fork-session together', () => {
        const session = makeSession(['--resume', 'claude-source-id', '--fork-session', '--permission-mode', 'default'])
        session.consumeOneTimeFlags()
        expect(session.claudeArgs).toEqual(['--permission-mode', 'default'])
    })

    it('consumes a lone --fork-session flag', () => {
        const session = makeSession(['--fork-session'])
        session.consumeOneTimeFlags()
        expect(session.claudeArgs).toBeUndefined()
    })

    it('leaves unrelated args alone', () => {
        const session = makeSession(['--permission-mode', 'acceptEdits'])
        session.consumeOneTimeFlags()
        expect(session.claudeArgs).toEqual(['--permission-mode', 'acceptEdits'])
    })
})
