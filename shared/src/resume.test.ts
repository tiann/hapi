import { describe, expect, it } from 'bun:test'
import { LocalResumeTargetSchema, ResumableSessionSchema } from './resume'
import { SyncEventSchema } from './schemas'
import { SessionEndReasonSchema } from './socket'

describe('resume schemas', () => {
    it('accepts a local resume target', () => {
        const parsed = LocalResumeTargetSchema.safeParse({
            sessionId: 'hapi-session-1',
            flavor: 'codex',
            directory: '/tmp/project',
            machineId: 'machine-1',
            host: 'devbox',
            active: true,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'codex-thread-1',
            model: 'gpt-5.4',
            effort: null,
            modelReasoningEffort: 'xhigh',
            permissionMode: 'default',
            collaborationMode: 'default'
        })

        expect(parsed.success).toBe(true)
    })

    it('accepts a resumable session summary', () => {
        const parsed = ResumableSessionSchema.safeParse({
            sessionId: 'hapi-session-1',
            flavor: 'claude',
            directory: '/tmp/project',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: '11111111-1111-4111-8111-111111111111',
            updatedAt: 123,
            name: 'project work',
            summary: 'finish docs'
        })

        expect(parsed.success).toBe(true)
    })

    it('accepts handoff as a session end reason', () => {
        expect(SessionEndReasonSchema.parse('handoff')).toBe('handoff')
    })

    it('accepts handoff in session-ended sync events', () => {
        const parsed = SyncEventSchema.safeParse({
            type: 'session-ended',
            sessionId: 'hapi-session-1',
            reason: 'handoff'
        })

        expect(parsed.success).toBe(true)
    })
})
