import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { CodexSession } from './session'
import type { EnhancedMode } from './loop'
import type { Metadata } from '@/api/types'

describe('CodexSession', () => {
    it.each([undefined, { sourceSessionId: 'source-1', machineId: 'machine-1' }])(
        'atomically binds the fork without removing cleanup ownership: %j', (codexForkCleanup) => {
        let metadata: Metadata = {
            path: '/tmp/project',
            host: 'localhost',
            codexSessionId: 'thread-source',
            codexForkRequest: { sourceThreadId: 'thread-source' },
            codexForkCleanup
        }
        const client = {
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            updateMetadata: vi.fn((update: (value: typeof metadata) => typeof metadata) => {
                metadata = update(metadata)
            })
        }
        const session = new CodexSession({
            api: {} as never,
            client: client as never,
            path: '/tmp/project',
            logPath: '/tmp/codex.log',
            sessionId: 'thread-source',
            messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
            onModeChange: () => {},
            startedBy: 'runner',
            startingMode: 'remote',
            codexForkRequest: metadata.codexForkRequest
        })

        session.onSessionFound('thread-child')
        session.stopKeepAlive()

        expect(metadata).toEqual({
            path: '/tmp/project',
            host: 'localhost',
            codexSessionId: 'thread-child',
            codexForkCleanup
        })
    })
})
