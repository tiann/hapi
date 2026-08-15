import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { ReasonixSession } from './session'
import type { ReasonixMode } from './types'

describe('ReasonixSession', () => {
    it('persists session discovery metadata alongside the native session id', () => {
        const updates: Record<string, unknown>[] = []
        const client = {
            updateMetadata: vi.fn((handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                updates.push(handler({ path: '/tmp', host: 'host', flavor: 'reasonix' }))
            }),
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn()
        }
        const session = new ReasonixSession({
            api: {} as never,
            client: client as never,
            path: '/tmp',
            logPath: '/tmp/reasonix.log',
            sessionId: null,
            messageQueue: new MessageQueue2<ReasonixMode>(() => 'reasonix'),
            onModeChange: vi.fn(),
            startedBy: 'runner'
        })

        session.onSessionFound('native-session', { reasonixTranscriptPersisted: false })
        session.stopKeepAlive()

        expect(updates[0]).toEqual({
            path: '/tmp',
            host: 'host',
            flavor: 'reasonix',
            reasonixTranscriptPersisted: false,
            reasonixSessionId: 'native-session'
        })
    })
})
