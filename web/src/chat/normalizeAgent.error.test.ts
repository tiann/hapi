import { describe, expect, it } from 'vitest'
import { normalizeAgentRecord } from './normalizeAgent'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'

describe('normalizeAgentRecord — agent error payloads', () => {
    it('normalizes codex error payloads into error-styled agent events', () => {
        const normalized = normalizeAgentRecord(
            'msg-1',
            null,
            1_700_000_000_000,
            {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'error',
                    message: 'API quota exceeded.'
                }
            }
        )

        expect(normalized).toEqual({
            id: 'msg-1',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'event',
            isSidechain: false,
            content: {
                type: 'error',
                message: 'API quota exceeded.'
            }
        })
    })
})
