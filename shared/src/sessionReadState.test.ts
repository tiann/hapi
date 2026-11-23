import { describe, expect, it } from 'bun:test'
import { hasUnreadMessageContent } from './messages'
import { mergeReadState, SessionReadStateRequestSchema } from './sessionReadState'

describe('read activity contract', () => {
    it('accepts visible answers, media and errors while excluding agent bookkeeping', () => {
        const agent = (data: unknown) => ({ role: 'agent', content: { type: 'codex', data } })
        for (const data of [{ type: 'message', message: 'Answer' }, { type: 'generated-image', imageId: 'image' }, { type: 'error', message: 'Failed' }]) {
            expect(hasUnreadMessageContent(agent(data))).toBe(true)
        }
        for (const data of [{ type: 'reasoning', message: 'Thinking' }, { type: 'tool-call', callId: '1' }, { type: 'token_count' }, { type: 'message', message: ' ' }]) {
            expect(hasUnreadMessageContent(agent(data))).toBe(false)
        }
        expect(hasUnreadMessageContent({ role: 'user', content: { type: 'text', text: 'Prompt' } })).toBe(false)
    })

    it('matches Claude visible text and failures while excluding hidden transcript records', () => {
        const output = (data: unknown) => ({ role: 'agent', content: { type: 'output', data } })
        const answer = { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }
        expect(hasUnreadMessageContent(output(answer))).toBe(true)
        expect(hasUnreadMessageContent(output({ type: 'assistant', message: { content: 'answer' } }))).toBe(true)
        expect(hasUnreadMessageContent(output({ ...answer, isMeta: true }))).toBe(false)
        expect(hasUnreadMessageContent(output({ ...answer, isCompactSummary: true }))).toBe(false)
        expect(hasUnreadMessageContent(output({ type: 'assistant', error: 'Prompt too long' }))).toBe(true)
        expect(hasUnreadMessageContent(output({ type: 'result', is_error: true }))).toBe(true)
        expect(hasUnreadMessageContent(output({ type: 'system', subtype: 'task_notification', summary: 'hidden' }))).toBe(false)
        expect(hasUnreadMessageContent(output({ type: 'assistant', message: { content: [{ type: 'image', source: {} }] } }))).toBe(false)
    })

    it('rejects unsafe and fractional cursors', () => {
        for (const readRevision of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
            expect(SessionReadStateRequestSchema.safeParse({ type: 'read', readRevision, expectedVersion: 0 }).success).toBe(false)
        }
    })

    it('preserves a newer manual choice across stale responses', () => {
        expect(mergeReadState({ version: 3, manualUnread: true, readRevision: 5 }, { version: 2, manualUnread: false, readRevision: 4 }))
            .toEqual({ version: 3, manualUnread: true, readRevision: 5 })
    })
})
