import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgySession } from './session'
import type { AgyMode } from './types'

describe('AgySession message acknowledgement', () => {
    it('does not acknowledge a web message merely because the queue dequeued it', async () => {
        const emitMessagesConsumed = vi.fn()
        const client = {
            emitMessagesConsumed,
            keepAlive: vi.fn(),
        }
        const queue = new MessageQueue2<AgyMode>(() => 'default')
        const session = new AgySession({
            api: {} as never,
            client: client as never,
            path: '/tmp',
            logPath: '/tmp/agy.log',
            sessionId: 'agy-session',
            messageQueue: queue,
            onModeChange: () => {},
            startedBy: 'runner',
        })

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1')
        await queue.waitForMessagesAndGetAsString()

        expect(emitMessagesConsumed).not.toHaveBeenCalled()
        session.stopKeepAlive()
    })
})
