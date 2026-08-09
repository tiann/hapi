import { describe, expect, it } from 'vitest'
import {
    annotatePeerDeliveryForAgent,
    formatMessageWithAttachments,
    formatUserMessageForAgent
} from './attachmentFormatter'

describe('formatMessageWithAttachments', () => {
    it('keeps the @path prefix shape agySessionScanner matches', () => {
        expect(formatMessageWithAttachments('hello', [
            { id: '1', path: '/tmp/a.txt', filename: 'a.txt', mimeType: 'text/plain', size: 1 }
        ])).toBe('@/tmp/a.txt\n\nhello')
    })
})

describe('annotatePeerDeliveryForAgent', () => {
    it('prepends From: /sessions/<id> for attributed peer rows', () => {
        expect(annotatePeerDeliveryForAgent('handoff body', {
            sentFrom: 'peer',
            peer: {
                sourceSessionId: '6212dae5-8a60-4284-b7a5-c09aa3571ce4',
                sourceName: 'Orchestrator'
            }
        })).toBe(
            'From: /sessions/6212dae5-8a60-4284-b7a5-c09aa3571ce4 (Orchestrator)\n\nhandoff body'
        )
    })

    it('marks unattributed peer delivery without inventing a source id', () => {
        expect(annotatePeerDeliveryForAgent('cli ping', { sentFrom: 'peer' }))
            .toBe('From: peer (unattributed)\n\ncli ping')
    })

    it('leaves non-peer messages unchanged', () => {
        expect(annotatePeerDeliveryForAgent('typed', { sentFrom: 'webapp' })).toBe('typed')
        expect(annotatePeerDeliveryForAgent('typed', undefined)).toBe('typed')
    })
})

describe('formatUserMessageForAgent', () => {
    it('preserves attachment prefix under the peer From header', () => {
        expect(formatUserMessageForAgent(
            'body',
            [{ id: '1', path: '/tmp/a.txt', filename: 'a.txt', mimeType: 'text/plain', size: 1 }],
            {
                sentFrom: 'peer',
                peer: { sourceSessionId: '6212dae5-8a60-4284-b7a5-c09aa3571ce4' }
            }
        )).toBe(
            'From: /sessions/6212dae5-8a60-4284-b7a5-c09aa3571ce4\n\n@/tmp/a.txt\n\nbody'
        )
    })
})
