import { describe, expect, it } from 'vitest'
import { normalizeAgentRecord } from '@/chat/normalizeAgent'

describe('normalizeAgentRecord — agentTimestamp exposure', () => {
    it('preserves a wire text message id as its snapshot stream id', () => {
        const normalized = normalizeAgentRecord('message-row-1', null, 1, {
            type: 'codex',
            data: {
                type: 'message',
                message: 'partial answer',
                id: 'text-stream-1'
            }
        })

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: 'partial answer',
                streamId: 'text-stream-1'
            }]
        })
    })

    it('keeps legacy wire text messages without a stream id', () => {
        const normalized = normalizeAgentRecord('message-row-1', null, 1, {
            type: 'codex',
            data: {
                type: 'message',
                message: 'complete answer'
            }
        })

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: 'complete answer'
            }]
        })
        expect((normalized as any).content[0].streamId).toBeUndefined()
    })

    it('keeps cumulative review-like snapshots in the same text stream', () => {
        const partial = normalizeAgentRecord('review-row-1', null, 1, {
            type: 'codex',
            data: { type: 'message', id: 'review-stream', streamSnapshot: true, message: '{"overall_correctness":' }
        })
        const complete = normalizeAgentRecord('review-row-2', null, 2, {
            type: 'codex',
            data: { type: 'message', id: 'review-stream', streamSnapshot: true, message: '{"overall_correctness":"patch is correct"}' }
        })

        expect(partial).toMatchObject({ content: [{ type: 'text', streamId: 'review-stream' }] })
        expect(complete).toMatchObject({
            content: [{
                type: 'text',
                streamId: 'review-stream',
                text: '{"overall_correctness":"patch is correct"}'
            }]
        })
    })

    it('keeps legacy Pi snapshot IDs type-stable without the provenance marker', () => {
        const streamId = 'pi-legacy-nonce-turn-1-message-1-text-0'
        const partial = normalizeAgentRecord('legacy-review-1', null, 1, {
            type: 'codex',
            data: { type: 'message', id: streamId, message: '{"overall_correctness":' }
        })
        const complete = normalizeAgentRecord('legacy-review-2', null, 2, {
            type: 'codex',
            data: { type: 'message', id: streamId, message: '{"overall_correctness":"patch is correct"}' }
        })

        expect(partial).toMatchObject({ content: [{ type: 'text', streamId }] })
        expect(complete).toMatchObject({ content: [{ type: 'text', streamId }] })
    })

    it('still parses a standalone review message that has a normal UUID', () => {
        const normalized = normalizeAgentRecord('review-row', null, 1, {
            type: 'codex',
            data: {
                type: 'message',
                id: '550e8400-e29b-41d4-a716-446655440000',
                message: '{"overall_correctness":"patch is correct"}'
            }
        })

        expect(normalized).toMatchObject({
            content: [{
                type: 'codex-review',
                review: { overallCorrectness: 'patch is correct' }
            }]
        })
    })

    it('preserves normalized native tool presentation metadata', () => {
        const normalized = normalizeAgentRecord('msg-native', null, 1, {
            type: 'codex',
            data: {
                type: 'tool-call',
                callId: 'call-native',
                name: 'Bash',
                input: { command: 'bun test' },
                nativeTitle: 'Run project tests',
                nativeKind: 'execute'
            }
        })

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'tool-call',
                nativeTitle: 'Run project tests',
                nativeKind: 'execute'
            }]
        })
    })

    it('preserves tool progress separately from the tool input', () => {
        const normalized = normalizeAgentRecord('progress-row-1', null, 1, {
            type: 'codex',
            data: {
                type: 'tool-call',
                callId: 'call-progress',
                name: 'Bash',
                input: { command: 'bun test' },
                progress: { stdout: 'running tests...\\n' }
            }
        })

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'tool-call',
                input: { command: 'bun test' },
                progress: { stdout: 'running tests...\\n' }
            }]
        })
    })

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
