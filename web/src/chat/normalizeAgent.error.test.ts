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

    it('normalizes Claude API error assistant records into error events without usage (#1857)', () => {
        const normalized = normalizeAgentRecord(
            'msg-2',
            null,
            1_700_000_000_000,
            {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a1',
                    isSidechain: false,
                    isApiErrorMessage: true,
                    error: 'invalid_request',
                    message: {
                        model: '<synthetic>',
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Prompt is too long' }],
                        usage: { input_tokens: 0, output_tokens: 0, service_tier: null }
                    }
                }
            }
        )

        expect(normalized).toEqual({
            id: 'msg-2',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'event',
            isSidechain: false,
            parentToolUseId: null,
            content: {
                type: 'error',
                message: 'Prompt is too long'
            }
        })
    })
})
