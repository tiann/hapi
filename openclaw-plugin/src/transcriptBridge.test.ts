import { beforeEach, describe, expect, it } from 'bun:test'
import type { HapiCallbackEvent } from './types'
import { HapiCallbackClient } from './hapiClient'
import { handleTranscriptUpdate } from './transcriptBridge'
import { adapterState } from './adapterState'

class CapturingCallbackClient extends HapiCallbackClient {
    events: HapiCallbackEvent[] = []

    constructor() {
        super('http://127.0.0.1:3006', 'shared-secret')
    }

    override async postEvent(event: HapiCallbackEvent): Promise<void> {
        this.events.push(event)
    }
}

describe('handleTranscriptUpdate', () => {
    beforeEach(() => {
        adapterState.resetForTests()
    })

    it('forwards repeated transcript updates for the same assistant message id', async () => {
        const callbackClient = new CapturingCallbackClient()
        const update = {
            sessionKey: 'agent:main:hapi-openclaw:default:debug-user',
            messageId: 'assistant-1',
            message: {
                role: 'assistant',
                content: 'partial',
                timestamp: 100
            }
        }

        await handleTranscriptUpdate(callbackClient, update)
        await handleTranscriptUpdate(callbackClient, {
            ...update,
            message: {
                ...update.message,
                content: 'partial and more'
            }
        })

        expect(callbackClient.events).toHaveLength(2)
        expect(callbackClient.events[0]?.type).toBe('message')
        expect(callbackClient.events[1]?.type).toBe('message')
        expect(callbackClient.events[0]?.eventId).not.toBe(callbackClient.events[1]?.eventId)
    })

    it('does not end the active run when transcript text arrives', async () => {
        const callbackClient = new CapturingCallbackClient()
        const conversationId = 'agent:main:hapi-openclaw:default:debug-user'

        expect(adapterState.startRun(conversationId)).toBe(true)

        await handleTranscriptUpdate(callbackClient, {
            sessionKey: conversationId,
            messageId: 'assistant-1',
            message: {
                role: 'assistant',
                content: 'partial',
                timestamp: 100
            }
        })

        expect(adapterState.isRunActive(conversationId)).toBe(true)
        expect(callbackClient.events).toHaveLength(1)
        expect(callbackClient.events[0]?.type).toBe('message')
    })
})
