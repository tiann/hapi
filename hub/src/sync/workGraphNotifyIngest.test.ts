import { describe, expect, it } from 'bun:test'
import { WORK_GRAPH_MAX_STRING, WORK_GRAPH_MAX_SUMMARY } from '@hapi/protocol'
import { Store } from '../store'
import {
    WORK_AD_DEFAULT_TTL_MS,
    buildWorkAdFromNotify,
    ingestNotifySummaryFromMessage,
    mapNotifyStatusToWorkAdStatus
} from './workGraphNotifyIngest'

function assistantOutput(text: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    content: [{ type: 'text', text }]
                }
            }
        }
    }
}

describe('mapNotifyStatusToWorkAdStatus', () => {
    it('maps notify contract statuses onto RFC WorkAd vocabulary', () => {
        expect(mapNotifyStatusToWorkAdStatus('done')).toBe('done')
        expect(mapNotifyStatusToWorkAdStatus('blocked')).toBe('blocked')
        expect(mapNotifyStatusToWorkAdStatus('needs_decision')).toBe('needs_decision')
        expect(mapNotifyStatusToWorkAdStatus('needs_review')).toBe('needs_decision')
        expect(mapNotifyStatusToWorkAdStatus('failed')).toBe('failed')
        expect(mapNotifyStatusToWorkAdStatus('stalled')).toBe('blocked')
        expect(mapNotifyStatusToWorkAdStatus('stale')).toBe('unknown')
        expect(mapNotifyStatusToWorkAdStatus('in_progress')).toBe('in_progress')
        expect(mapNotifyStatusToWorkAdStatus(undefined)).toBe('unknown')
        expect(mapNotifyStatusToWorkAdStatus('weird')).toBe('unknown')
    })
})

describe('buildWorkAdFromNotify field mapping', () => {
    it('maps notify fields per RFC elevation table', () => {
        const ts = 1_700_000_000_000
        const create = buildWorkAdFromNotify({
            sessionId: 'sess-1',
            messageId: 'msg-1',
            ownerUserId: 42,
            flavor: 'claude',
            ts,
            notify: {
                version: 1,
                status: 'done',
                summary: 'Opened PR',
                action: 'review diff',
                agent: 'peer-a',
                project: 'hapi'
            }
        })

        expect(create.event_type).toBe('work_ad')
        expect(create.summary).toBe('Opened PR')
        expect(create.related_session_id).toBe('sess-1')
        expect(create.provenance).toBe('AGENT_NOTIFY_SUMMARY')
        expect(create.idempotency_key).toBe('session:sess-1:message:msg-1:notify')
        expect(create.expires_at).toBe(ts + WORK_AD_DEFAULT_TTL_MS)
        expect(create.principal).toEqual({
            kind: 'agent',
            id: 'session:sess-1',
            on_behalf_of: '42'
        })
        expect(create.tags).toContain('project:hapi')
        expect(create.tags).toContain('agent:peer-a')
        expect(create.payload_json).toMatchObject({
            status: 'done',
            action: 'review diff',
            project: 'hapi',
            agent: 'peer-a',
            messageId: 'msg-1'
        })
    })

    it('never trusts notify.agent as principal.id', () => {
        const create = buildWorkAdFromNotify({
            sessionId: 'sess-xyz',
            messageId: 'msg-1',
            ownerUserId: 1,
            ts: 1000,
            notify: { status: 'done', summary: 'ok', agent: 'forged-peer' }
        })
        expect(create.principal).toEqual({
            kind: 'agent',
            id: 'session:sess-xyz',
            on_behalf_of: '1'
        })
        expect(create.payload_json).toMatchObject({ agent: 'forged-peer' })
    })
})

describe('ingestNotifySummaryFromMessage', () => {
    it('inserts a work_ad ledger row from a well-formed footer', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-ingest', {}, null, 'alpha')
        const content = assistantOutput(
            'All good.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"status":"done","action":"ship it","summary":"Tests green","agent":"worker","project":"hapi"}'
        )

        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: session.namespace,
            sessionId: session.id,
            messageId: 'msg-a',
            content,
            ts: Date.now(),
            ownerUserId: 7,
            flavor: 'claude'
        })

        expect(result?.inserted).toBe(true)
        expect(result?.event.eventType).toBe('work_ad')
        expect(result?.event.summary).toBe('Tests green')
        expect(result?.event.namespace).toBe('alpha')
        expect(result?.event.relatedSessionId).toBe(session.id)
        expect(result?.event.provenance).toBe('AGENT_NOTIFY_SUMMARY')
        expect(result?.event.payloadJson).toMatchObject({
            status: 'done',
            action: 'ship it'
        })

        const listed = store.workGraph.listByRelatedSession('alpha', session.id)
        expect(listed).toHaveLength(1)
        expect(listed[0]!.id).toBe(result!.event.id)
    })

    it('is idempotent for the same message', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-idem', {}, null, 'default')
        const content = assistantOutput(
            'AGENT_NOTIFY_SUMMARY {"status":"blocked","summary":"Waiting on review"}'
        )
        const input = {
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-same',
            content,
            ts: Date.now(),
            ownerUserId: 1
        }

        const first = ingestNotifySummaryFromMessage(input)
        const second = ingestNotifySummaryFromMessage(input)

        expect(first?.inserted).toBe(true)
        expect(second?.inserted).toBe(false)
        expect(second?.event.id).toBe(first?.event.id)
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(1)
    })

    it('isolates ledger rows by namespace', () => {
        const store = new Store(':memory:')
        const alpha = store.sessions.getOrCreateSession('sess-ns', {}, null, 'alpha')
        const content = assistantOutput(
            'AGENT_NOTIFY_SUMMARY {"status":"failed","summary":"Boom"}'
        )

        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'alpha',
            sessionId: alpha.id,
            messageId: 'msg-ns',
            content,
            ts: Date.now(),
            ownerUserId: 1
        })

        expect(result?.inserted).toBe(true)
        expect(store.workGraph.listByRelatedSession('beta', alpha.id)).toHaveLength(0)
        expect(store.workGraph.getEvent(result!.event.id, 'beta')).toBeNull()
        expect(store.workGraph.listByRelatedSession('alpha', alpha.id)).toHaveLength(1)
    })

    it('ignores messages without a well-formed notify footer', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-none', {}, null, 'default')
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-none',
            content: assistantOutput('Just prose, no footer.'),
            ts: Date.now(),
            ownerUserId: 1
        })
        expect(result).toBeNull()
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(0)
    })

    it('does not require a chat display setting — capture always runs when well-formed', () => {
        // Kill criterion: display-off does not block capture. This path has no
        // display gate at all; presence of a footer is sufficient.
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-capture', {}, null, 'default')
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-capture',
            content: assistantOutput(
                'AGENT_NOTIFY_SUMMARY {"status":"needs_review","summary":"Please look","action":"review PR"}'
            ),
            ts: Date.now(),
            ownerUserId: 1
        })
        expect(result?.inserted).toBe(true)
        expect(result?.event.payloadJson).toMatchObject({ status: 'needs_decision' })
    })

    it('persists the message timestamp and default expires_at (M2/M3)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-ts', {}, null, 'default')
        const messageTs = 1_650_000_000_000
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-ts',
            content: assistantOutput(
                'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Historical import"}'
            ),
            ts: messageTs,
            ownerUserId: 1
        })

        expect(result?.inserted).toBe(true)
        expect(result?.event.ts).toBe(messageTs)
        expect(result?.event.expiresAt).toBe(messageTs + WORK_AD_DEFAULT_TTL_MS)
    })

    it('keeps work_ad rows after session delete (append-only audit, M1)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-survive', {}, null, 'default')
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-survive',
            content: assistantOutput(
                'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Survives delete"}'
            ),
            ts: Date.now(),
            ownerUserId: 1
        })
        expect(result?.inserted).toBe(true)

        expect(store.sessions.deleteSession(session.id, 'default')).toBe(true)
        expect(store.sessions.getSession(session.id)).toBeNull()

        const listed = store.workGraph.listByRelatedSession('default', session.id)
        expect(listed).toHaveLength(1)
        expect(listed[0]!.summary).toBe('Survives delete')
        expect(listed[0]!.id).toBe(result!.event.id)
    })

    it('clamps oversized footer summary to WORK_GRAPH_MAX_SUMMARY (S4)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-bound', {}, null, 'default')
        const oversized = 'x'.repeat(WORK_GRAPH_MAX_SUMMARY + 1)
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-bound',
            content: assistantOutput(
                `AGENT_NOTIFY_SUMMARY {"status":"done","summary":${JSON.stringify(oversized)}}`
            ),
            ts: Date.now(),
            ownerUserId: 1
        })

        expect(result?.inserted).toBe(true)
        expect(result?.event.summary?.length).toBe(WORK_GRAPH_MAX_SUMMARY)
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(1)
    })

    it('elevates max-clamped footer fields without duplicating into payload (bot Minor)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-budget', {}, null, 'default')
        // Three near-max strings previously lived twice (flat + notify_summary)
        // and blew the 32 KiB payload cap → silent null. Flat-only must insert.
        const fat = 'a'.repeat(6_000)
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-budget',
            content: assistantOutput(
                `AGENT_NOTIFY_SUMMARY ${JSON.stringify({
                    status: 'done',
                    summary: 'ok',
                    action: fat,
                    project: fat,
                    agent: fat
                })}`
            ),
            ts: Date.now(),
            ownerUserId: 1
        })

        expect(result?.inserted).toBe(true)
        const payload = result?.event.payloadJson as Record<string, unknown>
        expect(payload).not.toHaveProperty('notify_summary')
        expect(payload?.action).toBe(fat)
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(1)
    })

    it('clamps CJK footer fields by UTF-8 bytes so elevation still inserts', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cjk', {}, null, 'default')
        // 6k CJK × 3 ≈ 54 KiB UTF-8 if unclamped; must not silent-drop.
        const fatCjk = '\u4e2d'.repeat(6_000)
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-cjk',
            content: assistantOutput(
                `AGENT_NOTIFY_SUMMARY ${JSON.stringify({
                    status: 'done',
                    summary: 'ok',
                    action: fatCjk,
                    project: fatCjk,
                    agent: fatCjk
                })}`
            ),
            ts: Date.now(),
            ownerUserId: 1
        })

        expect(result?.inserted).toBe(true)
        const action = (result?.event.payloadJson as { action?: string })?.action ?? ''
        expect(new TextEncoder().encode(action).byteLength).toBeLessThanOrEqual(WORK_GRAPH_MAX_STRING)
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(1)
    })

    it('clamps JSON-escapable ASCII so elevation still inserts', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-esc', {}, null, 'default')
        // Raw UTF-8 clamp would keep 8192 backslashes; JSON.stringify doubles them.
        const fatEsc = '\\'.repeat(8_192)
        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-esc',
            content: assistantOutput(
                `AGENT_NOTIFY_SUMMARY ${JSON.stringify({
                    status: 'done',
                    summary: 'ok',
                    action: fatEsc,
                    project: fatEsc,
                    agent: fatEsc
                })}`
            ),
            ts: Date.now(),
            ownerUserId: 1
        })

        expect(result?.inserted).toBe(true)
        const action = (result?.event.payloadJson as { action?: string })?.action ?? ''
        const escaped = JSON.stringify(action).slice(1, -1)
        expect(new TextEncoder().encode(escaped).byteLength).toBeLessThanOrEqual(WORK_GRAPH_MAX_STRING)
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(1)
    })
})
