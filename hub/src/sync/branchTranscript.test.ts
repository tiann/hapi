import { describe, expect, it } from 'bun:test'
import type { BranchConversationRequest } from '@hapi/protocol/apiTypes'
import type { StoredMessage } from '../store/types'
import { branchSessionId, buildBranchPrompt, BRANCH_CONTEXT_MAX_BYTES } from './branchTranscript'

const request: BranchConversationRequest = {
    requestId: 'b428e5be-dc54-4edc-9903-59250c1b5c31', messageLocalId: 'second', boundary: 'before',
    agent: 'codex', workspace: 'current', instruction: 'Explore another approach'
}
function row(seq: number, content: unknown, localId: string | null = null, invokedAt: number | null = seq): StoredMessage {
    return { id: String(seq), sessionId: 'source', content, seq, localId, createdAt: seq, invokedAt, scheduledAt: null }
}
const messages = [
    row(1, { role: 'user', content: { type: 'text', text: 'First question' } }, 'first'),
    row(2, { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'First reply' },
        { type: 'tool_use', name: 'Read', input: { path: 'README.md' } }
    ] } } } }),
    row(3, { role: 'user', content: { type: 'text', text: 'Second question' } }, 'second'),
    row(4, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Second reply' } } }),
    row(5, { role: 'user', content: 'Third question' }, 'third'),
    row(6, { role: 'user', content: 'QUEUED_SECRET' }, 'queued', null)
]
describe('portable branch reference', () => {
    it('derives stable namespace/source-scoped UUIDs for CLI adoption', () => {
        const id = branchSessionId('default', 'source', request.requestId)
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(branchSessionId('default', 'source', request.requestId)).toBe(id)
        expect(branchSessionId('other', 'source', request.requestId)).not.toBe(id)
        expect(branchSessionId('default', 'other', request.requestId)).not.toBe(id)
    })

    it('selects before/after a user turn and excludes later/queued/hidden content', () => {
        const before = buildBranchPrompt(messages, request).text
        expect(before).toContain('First reply')
        expect(before).toContain('README.md')
        for (const excluded of ['Second question', 'Second reply', 'Third question', 'QUEUED_SECRET', 'PRIVATE_REASONING']) {
            expect(before).not.toContain(excluded)
        }
        const after = buildBranchPrompt(messages, { ...request, boundary: 'after' }).text
        expect(after).toContain('Second question')
        expect(after).toContain('Second reply')
        expect(after).not.toContain('Third question')
        expect(after).toContain('NEW_USER_INSTRUCTION:')
    })
    it('orders by invocation time and rejects stale, queued, or non-user boundaries', () => {
        expect(() => buildBranchPrompt(messages, { ...request, messageLocalId: 'queued' })).toThrow('not found')
        expect(() => buildBranchPrompt(messages, { ...request, messageLocalId: 'missing' })).toThrow('not found')
        const late = row(20, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Late sequence' } } }, null, 2)
        expect(buildBranchPrompt([...messages, late], request).text).toContain('Late sequence')
    })
    it('rejects attachments and oversized context rather than silently claiming portability', () => {
        const attachment = row(0, { role: 'user', content: { type: 'text', text: 'See attached', attachments: [{ id: 'image' }] } }, 'attachment')
        expect(() => buildBranchPrompt([attachment, ...messages], request)).toThrow('attachments')
        const huge = row(0, { role: 'user', content: 'x'.repeat(BRANCH_CONTEXT_MAX_BYTES) }, 'huge')
        expect(() => buildBranchPrompt([huge, ...messages], request)).toThrow('256 KiB')
    })
    it('rejects generated and nested tool images rather than serializing their bytes', () => {
        for (const data of [
            { type: 'generated-image', imageId: 'image' },
            { type: 'tool-call-result', output: { content: [{ type: 'image', data: 'BASE64_BYTES' }] } }
        ]) {
            const image = row(0, { role: 'agent', content: { type: 'codex', data } })
            expect(() => buildBranchPrompt([image, ...messages], request)).toThrow('attachments')
        }
    })

    it('never imports arbitrary system fields or raw private envelopes', () => {
        const hidden = row(0, { role: 'agent', content: { type: 'output', data: {
            type: 'system', systemPrompt: 'PRIVATE_SYSTEM', credentials: 'PRIVATE_TOKEN'
        } } })
        expect(buildBranchPrompt([hidden, ...messages], request).text).not.toContain('PRIVATE_')
    })
})
