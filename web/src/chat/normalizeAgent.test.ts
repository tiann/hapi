import { describe, expect, it } from 'vitest'
import { normalizeAgentRecord } from '@/chat/normalizeAgent'

describe('normalizeAgentRecord — agentTimestamp exposure', () => {
    it('parses data.timestamp into agentTimestamp for an assistant tool_use record', () => {
        const normalized = normalizeAgentRecord('msg-1', null, 1_783_953_478_235, {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'c93919e3',
                timestamp: '2026-07-13T14:37:57.372Z',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/marker.txt' } }]
                }
            }
        })

        expect(normalized).toMatchObject({
            role: 'agent',
            agentTimestamp: Date.parse('2026-07-13T14:37:57.372Z')
        })
    })

    it('parses data.timestamp into agentTimestamp for a user tool_result record', () => {
        const normalized = normalizeAgentRecord('msg-2', null, 1_783_953_478_237, {
            type: 'output',
            data: {
                type: 'user',
                uuid: '242b5485',
                timestamp: '2026-07-13T14:37:57.379Z',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }]
                }
            }
        })

        expect(normalized).toMatchObject({
            role: 'agent',
            agentTimestamp: Date.parse('2026-07-13T14:37:57.379Z')
        })
    })

    it('falls back to null (not the hub createdAt) when data.timestamp is absent', () => {
        const normalized = normalizeAgentRecord('msg-3', null, 1_783_953_478_237, {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'no-ts',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'sleep 2' } }]
                }
            }
        })

        expect(normalized).toMatchObject({ role: 'agent', agentTimestamp: null })
    })

    it('returns null when data.timestamp is an unparseable string', () => {
        const normalized = normalizeAgentRecord('msg-4', null, 1_783_953_478_237, {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'bad-ts',
                timestamp: 'not-a-timestamp',
                message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
            }
        })

        expect(normalized).toMatchObject({ role: 'agent', agentTimestamp: null })
    })
})
