import { describe, expect, it } from 'vitest'
import { dedupeAgentEvents, parseMessageAsEvent } from './reducerEvents'
import type { AgentEventBlock, NormalizedMessage } from './types'

describe('delivery resolution records', () => {
    const notice = (id: string, localId?: string): AgentEventBlock => ({
        kind: 'agent-event', id, createdAt: 1,
        event: { type: 'message', message: 'Delivery confirmation abandoned.\n\ncontinue after restart' },
        ...(localId ? { meta: { abandonedDelivery: { localId } } } : {}),
    })

    it('retains separate resolutions for identical inputs while deduplicating the same resolution', () => {
        const first = notice('notice-1', 'original-input-1')
        const second = notice('notice-2', 'original-input-2')
        expect(dedupeAgentEvents([first, second, { ...second }])).toEqual([first, second])
    })

    it('still deduplicates ordinary repeated message events', () => {
        const first = notice('notice-1')
        expect(dedupeAgentEvents([first, notice('notice-2')])).toEqual([first])
    })
})

function makeAgentTextMessage(text: string): NormalizedMessage {
    return {
        role: 'agent',
        content: [{ type: 'text', text, uuid: 'u1', parentUUID: null }],
        id: 'msg-1',
        localId: null,
        createdAt: Date.now(),
        isSidechain: false,
    }
}

describe('parseMessageAsEvent — usage limit formats', () => {
    it('parses reached with limitType', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000|five_hour')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour',
        })
    })

    it('parses reached without limitType (backward compat)', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: '',
        })
    })

    it('parses warning with five_hour type', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774278000|90|five_hour')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour',
        })
    })

    it('parses warning with seven_day type', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774850400|85|seven_day')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 0.85,
            endsAt: 1774850400,
            limitType: 'seven_day',
        })
    })

    it('handles missing limitType', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774278000|100|')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 1,
            endsAt: 1774278000,
            limitType: '',
        })
    })

    it('returns null for non-limit text', () => {
        const msg = makeAgentTextMessage('Hello world')
        expect(parseMessageAsEvent(msg)).toBeNull()
    })

    it('returns null for sidechain messages', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000')
        msg.isSidechain = true
        expect(parseMessageAsEvent(msg)).toBeNull()
    })
})
