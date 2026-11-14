import { describe, expect, it } from 'vitest'
import { forwardClaudeAutoCompactionStart } from './autoCompactionHook'
import { startHookServer, type SessionHookData } from './startHookServer'

describe('Claude automatic compaction hook', () => {
    it('forwards START through the authenticated lifecycle endpoint before completion exists', async () => {
        const events: unknown[] = []
        const session = { sessionId: 'main-session', client: { sendSessionEvent: (event: unknown) => events.push(event) } }
        const server = await startHookServer({
            onSessionHook: (id, data) => forwardClaudeAutoCompactionStart(session, id, data)
        })
        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/hook/session-start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-hapi-hook-token': server.token },
                body: JSON.stringify({ session_id: 'main-session', hook_event_name: 'PreCompact', trigger: 'auto' })
            })
            expect(response.status).toBe(200)
            expect(events).toEqual([{ type: 'message', message: '📦 Compaction started' }])
        } finally {
            server.stop()
        }
    })

    it('ignores manual, SDK status, completion, subagent and foreign-session observations', () => {
        const events: unknown[] = []
        const session = { sessionId: 'main-session', client: { sendSessionEvent: (event: unknown) => events.push(event) } }
        const auto: SessionHookData = { hook_event_name: 'PreCompact', trigger: 'auto' }
        forwardClaudeAutoCompactionStart(session, 'foreign-session', auto)
        forwardClaudeAutoCompactionStart(null, 'main-session', auto)
        for (const data of [
            { ...auto, trigger: 'manual' },
            { ...auto, trigger: undefined },
            { ...auto, agent_id: 'child' },
            { ...auto, agent_id: '' },
            { ...auto, hook_event_name: 'PostCompact' },
            { type: 'system', subtype: 'status', status: 'compacting' },
            { type: 'system', subtype: 'compact_boundary' }
        ]) forwardClaudeAutoCompactionStart(session, 'main-session', data)
        expect(events).toEqual([])
    })

    it('announces each automatic attempt without claiming success or suppressing a retry', () => {
        const events: unknown[] = []
        const session = { sessionId: 'main-session', client: { sendSessionEvent: (event: unknown) => events.push(event) } }
        const auto = { hook_event_name: 'PreCompact', trigger: 'auto' }
        forwardClaudeAutoCompactionStart(session, 'main-session', auto)
        // A failed/aborted attempt may be retried without a successful boundary.
        forwardClaudeAutoCompactionStart(session, 'main-session', { hook_event_name: 'PostCompact', trigger: 'auto' })
        forwardClaudeAutoCompactionStart(session, 'main-session', auto)
        expect(events).toEqual(Array.from({ length: 2 }, () => ({ type: 'message', message: '📦 Compaction started' })))
    })
})
