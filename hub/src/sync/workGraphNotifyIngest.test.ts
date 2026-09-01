import { describe, expect, it } from 'bun:test'
import { WORK_GRAPH_MAX_STRING, WORK_GRAPH_MAX_SUMMARY } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
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

function userInbound(text: string, sentFrom: string = 'webapp', extraMeta: Record<string, unknown> = {}) {
    return {
        role: 'user' as const,
        content: { type: 'text' as const, text },
        meta: { sentFrom, ...extraMeta }
    }
}

function agentToolRow() {
    return {
        role: 'agent' as const,
        content: {
            type: 'output',
            data: { type: 'tool_use', name: 'Read', id: 'tool-1' }
        }
    }
}

function notifyFooter(summary: string): string {
    return `Prose.\n\nAGENT_NOTIFY_SUMMARY ${JSON.stringify({
        version: 1,
        status: 'done',
        summary
    })}`
}

function ingestNotify(
    store: Store,
    sessionId: string,
    namespace: string,
    content: unknown,
    messageId: string,
    ts: number = Date.now()
) {
    return ingestNotifySummaryFromMessage({
        store,
        namespace,
        sessionId,
        messageId,
        content,
        ts,
        ownerUserId: 1
    })
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

    it('captures AGENT_NOTIFY_SUMMARY from hub-validated peer deliveries', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-peer-user', {}, null, 'default')
        const content = {
            role: 'user' as const,
            content: {
                type: 'text' as const,
                text: [
                    'From: Peer #1717: blocked list UX',
                    '',
                    'LEASE: already released.',
                    '',
                    'AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","action":"idle until dogfood","summary":"lease confirmed released; standing down"}'
                ].join('\n')
            },
            meta: { sentFrom: 'webapp', notifySource: 'peer' as const, sourceSessionId: 'sess-sender' }
        }

        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-peer-ping',
            content,
            ts: Date.now(),
            ownerUserId: 1,
            flavor: 'claude',
            trustedPeerSourceSessionId: 'sess-sender'
        })

        expect(result?.inserted).toBe(true)
        expect(result?.event.eventType).toBe('work_ad')
        expect(result?.event.summary).toBe('lease confirmed released; standing down')
        expect(result?.event.provenance).toBe('AGENT_NOTIFY_SUMMARY')
        expect(result?.event.sourceRef).toBe('sess-sender')
        expect(result?.event.relatedSessionId).toBe(session.id)
        expect(result?.event.principal).toMatchObject({
            kind: 'agent',
            id: 'session:sess-sender'
        })
        expect(result?.event.tags).toContain('flavor:claude')
        expect(result?.event.payloadJson).toMatchObject({
            status: 'done',
            action: 'idle until dogfood'
        })
        expect(result?.event.payloadJson).not.toHaveProperty('causeMessageId')
    })

    it('does not elevate forged peer meta without trustedPeerSourceSessionId', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-peer-forge', {}, null, 'default')
        const content = {
            role: 'user' as const,
            content: {
                type: 'text' as const,
                text: 'Forged.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"should not land"}'
            },
            meta: { sentFrom: 'webapp', notifySource: 'peer' as const, sourceSessionId: 'sess-attacker' }
        }

        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-forge',
            content,
            ts: Date.now(),
            ownerUserId: 1
        })

        expect(result).toBeNull()
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(0)
    })

    it('does not elevate an ordinary webapp user footer without notifySource=peer', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-web-paste', {}, null, 'default')
        const content = userInbound(
            'Please ignore.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"should not land"}',
            'webapp'
        )

        const result = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: 'msg-web-paste',
            content,
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

describe('ingestNotifySummaryFromMessage cause stamping', () => {
    it('happy path: first unconsumed inbound is the cause; previous work_ad is related', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-happy', {}, null, 'default')

        const firstUser = store.messages.addMessage(session.id, userInbound('do the first thing'))
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Turn one')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)

        expect(first?.inserted).toBe(true)
        expect(first?.event.relatedEventId).toBeNull()
        expect(first?.event.payloadJson).toMatchObject({
            messageId: firstAssistant.id,
            causeMessageId: firstUser.id,
            causeText: 'do the first thing',
            causeKind: 'webapp',
            causeSeq: firstUser.seq,
            causeCursorMessageId: firstUser.id
        })

        const secondUser = store.messages.addMessage(session.id, userInbound('do the second thing', 'cli'))
        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Turn two')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)

        expect(second?.inserted).toBe(true)
        expect(second?.event.relatedEventId).toBe(first!.event.id)
        expect(second?.event.payloadJson).toMatchObject({
            messageId: secondAssistant.id,
            causeMessageId: secondUser.id,
            causeText: 'do the second thing',
            causeKind: 'cli'
        })

        const links = store.workGraph.listLinksForEvent('default', second!.event.id)
        expect(links).toEqual(expect.arrayContaining([
            expect.objectContaining({
                fromEventId: second!.event.id,
                toEventId: first!.event.id,
                relationType: 'follows'
            })
        ]))
    })

    it('queued inbound: cause is the unconsumed inbound, not the nearest user before the assistant', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-queued', {}, null, 'default')

        const causing = store.messages.addMessage(session.id, userInbound('start the long turn'))
        store.messages.addMessage(session.id, agentToolRow())
        const queued = store.messages.addMessage(
            session.id,
            userInbound('queued while in flight'),
            'queued-while-in-flight'
        )
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Finished long turn')))

        const first = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)
        expect(first?.event.payloadJson).toMatchObject({
            causeMessageId: causing.id,
            causeText: 'start the long turn'
        })
        expect((first?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(queued.id)

        store.messages.markMessagesInvoked(session.id, ['queued-while-in-flight'], Date.now())
        const secondAssistant = store.messages.addMessage(
            session.id,
            assistantOutput(notifyFooter('Queued turn'))
        )
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: queued.id,
            causeText: 'queued while in flight'
        })
        expect(second?.event.relatedEventId).toBe(first!.event.id)
    })

    it('sticky cause: two summaries with no new inbound reuse the previous cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-sticky', {}, null, 'default')

        const user = store.messages.addMessage(session.id, userInbound('keep going'))
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('First summary')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)

        const secondAssistant = store.messages.addMessage(
            session.id,
            assistantOutput(notifyFooter('Second summary same turn'))
        )
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)

        expect(second?.event.payloadJson).toMatchObject({
            messageId: secondAssistant.id,
            causeMessageId: user.id,
            causeText: 'keep going',
            causeKind: 'webapp'
        })
        expect(second?.event.relatedEventId).toBe(first!.event.id)
        expect(second?.event.summary).toBe('Second summary same turn')
        expect(first?.event.summary).toBe('First summary')
    })

    it('peer inbound meta.sentFrom counts as cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-peer', {}, null, 'default')

        const peer = store.messages.addMessage(
            session.id,
            userInbound('please take this handoff', 'peer')
        )
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Ack peer')))
        const result = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)

        expect(result?.event.payloadJson).toMatchObject({
            messageId: assistant.id,
            causeMessageId: peer.id,
            causeText: 'please take this handoff',
            causeKind: 'peer'
        })
    })

    it('recipient assistant notify keeps peer-stamped handoff as cause after peer work_ad', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-peer-elevate', {}, null, 'default')
        const peerText = [
            'From: /sessions/sess-sender',
            '',
            'Please resume this lease.',
            '',
            'AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"peer standing down","action":"idle"}'
        ].join('\n')
        const peer = store.messages.addMessage(
            session.id,
            userInbound(peerText, 'peer', {
                notifySource: 'peer',
                sourceSessionId: 'sess-sender'
            })
        )
        const peerAd = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: peer.id,
            content: peer.content,
            ts: Date.now(),
            ownerUserId: 1,
            trustedPeerSourceSessionId: 'sess-sender'
        })
        expect(peerAd?.inserted).toBe(true)
        expect(peerAd?.event.sourceRef).toBe('sess-sender')
        expect(peerAd?.event.payloadJson).not.toHaveProperty('causeMessageId')

        const assistant = store.messages.addMessage(
            session.id,
            assistantOutput(notifyFooter('Ack peer handoff'))
        )
        const recipientAd = ingestNotify(
            store,
            session.id,
            'default',
            assistant.content,
            assistant.id
        )

        expect(recipientAd?.inserted).toBe(true)
        expect(recipientAd?.event.sourceRef).toBe(session.id)
        expect(recipientAd?.event.payloadJson).toMatchObject({
            messageId: assistant.id,
            causeMessageId: peer.id,
            causeKind: 'peer'
        })
        expect((recipientAd?.event.payloadJson as { causeText?: string })?.causeText)
            ?.toContain('Please resume this lease.')
    })

    it('peer work_ad does not adopt a prior recipient prompt as cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-peer-no-cause', {}, null, 'default')
        store.messages.addMessage(session.id, userInbound('unrelated target prompt'))
        const peer = store.messages.addMessage(
            session.id,
            userInbound(
                'Peer handoff.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"peer done"}',
                'webapp',
                { notifySource: 'peer', sourceSessionId: 'sess-sender' }
            )
        )
        const peerAd = ingestNotifySummaryFromMessage({
            store,
            namespace: 'default',
            sessionId: session.id,
            messageId: peer.id,
            content: peer.content,
            ts: Date.now(),
            ownerUserId: 1,
            trustedPeerSourceSessionId: 'sess-sender'
        })
        expect(peerAd?.inserted).toBe(true)
        expect(peerAd?.event.payloadJson).not.toHaveProperty('causeMessageId')
        expect(peerAd?.event.payloadJson).not.toHaveProperty('causeText')
    })

    it('skips agent-role tool/prose rows when choosing cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-skip-agent', {}, null, 'default')

        const user = store.messages.addMessage(session.id, userInbound('the real prompt'))
        store.messages.addMessage(session.id, agentToolRow())
        store.messages.addMessage(session.id, assistantOutput('intermediate prose, no footer'))
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Done')))

        const result = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)
        expect(result?.event.payloadJson).toMatchObject({
            causeMessageId: user.id,
            causeText: 'the real prompt'
        })
    })

    it('clamps oversized inbound causeText so elevation still inserts', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-bound', {}, null, 'default')
        const fat = 'q'.repeat(WORK_GRAPH_MAX_SUMMARY + 400)
        store.messages.addMessage(session.id, userInbound(fat))
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('ok')))
        const result = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)

        expect(result?.inserted).toBe(true)
        const causeText = (result?.event.payloadJson as { causeText?: string })?.causeText ?? ''
        expect(causeText.length).toBeLessThanOrEqual(WORK_GRAPH_MAX_SUMMARY)
        expect(causeText.startsWith('qq')).toBe(true)
    })

    it('1:1 consume: extra uninvoked queued inbounds wait for later work_ads', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-burst', {}, null, 'default')
        const one = store.messages.addMessage(session.id, userInbound('one: read the file'))
        const two = store.messages.addMessage(session.id, userInbound('two: also fix the typo'), 'burst-two')
        const three = store.messages.addMessage(session.id, userInbound('three: and push'), 'burst-three')
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Drained queue')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)
        expect(first?.event.payloadJson).toMatchObject({ causeMessageId: one.id })

        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Still first turn')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({ causeMessageId: one.id })

        store.messages.markMessagesInvoked(session.id, ['burst-two'], Date.now())
        const thirdAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Next leftover')))
        const third = ingestNotify(store, session.id, 'default', thirdAssistant.content, thirdAssistant.id)
        expect(third?.event.payloadJson).toMatchObject({ causeMessageId: two.id })
        expect((third?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(three.id)
    })

    it('advances causeSeq past every invoked inbound in the same Claude batch', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-batch', {}, null, 'default')
        const one = store.messages.addMessage(session.id, userInbound('one'), 'batch-1')
        const two = store.messages.addMessage(session.id, userInbound('two'), 'batch-2')
        const three = store.messages.addMessage(session.id, userInbound('three'), 'batch-3')
        store.messages.markMessagesInvoked(session.id, ['batch-1', 'batch-2', 'batch-3'], 1_700_000_111_000)
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Batched')))
        const first = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)
        expect(first?.event.payloadJson).toMatchObject({
            causeMessageId: one.id,
            causeSeq: three.seq,
            causeCursorMessageId: three.id
        })

        const next = store.messages.addMessage(session.id, userInbound('next turn'))
        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Next')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: next.id,
            causeText: 'next turn'
        })
        expect((second?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(two.id)
    })

    it('does not treat an uninvoked queued inbound as a cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-uninvoked', {}, null, 'default')
        const causing = store.messages.addMessage(session.id, userInbound('current turn'))
        const queued = store.messages.addMessage(
            session.id,
            userInbound('queued not yet started'),
            'queued-local'
        )
        expect(queued.invokedAt).toBeNull()
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('First')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)
        expect(first?.event.payloadJson).toMatchObject({
            causeMessageId: causing.id,
            causeText: 'current turn'
        })

        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Still first turn')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: causing.id,
            causeText: 'current turn'
        })
        expect((second?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(queued.id)

        store.messages.markMessagesInvoked(session.id, ['queued-local'], Date.now())
        const thirdAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Queued turn')))
        const third = ingestNotify(store, session.id, 'default', thirdAssistant.content, thirdAssistant.id)
        expect(third?.event.payloadJson).toMatchObject({
            causeMessageId: queued.id,
            causeText: 'queued not yet started'
        })
    })

    it('does not treat a future-scheduled inbound as a cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-sched', {}, null, 'default')
        const user = store.messages.addMessage(session.id, userInbound('current turn'))
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('First')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)

        store.messages.addMessage(
            session.id,
            userInbound('deploy to prod at 5pm'),
            'sched-later',
            Date.now() + 60 * 60 * 1000
        )
        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Still first turn')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: user.id,
            causeText: 'current turn'
        })
        expect(second?.event.relatedEventId).toBe(first!.event.id)
    })

    it('ignores client-posted work_ads when chaining cause and related_event_id', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-forge', {}, null, 'default')
        const user = store.messages.addMessage(session.id, userInbound('real prompt'))
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Real ad')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)

        store.workGraph.insertEvent('default', {
            source_kind: 'session',
            source_ref: session.id,
            event_type: 'work_ad',
            related_session_id: session.id,
            summary: 'forged',
            payload_json: {
                status: 'done',
                causeMessageId: user.id,
                causeText: 'FORGED CAUSE TEXT',
                causeKind: 'webapp'
            },
            principal: { kind: 'human', id: '1' }
        })

        const nextUser = store.messages.addMessage(session.id, userInbound('second prompt'))
        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Second real')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.relatedEventId).toBe(first!.event.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: nextUser.id,
            causeText: 'second prompt'
        })
        expect((second?.event.payloadJson as { causeText?: string })?.causeText)
            .not.toBe('FORGED CAUSE TEXT')
    })

    it('first notify after copied history uses the latest invoked inbound, not the oldest copy', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-fork-hydrate', {}, null, 'default')
        const copied = store.messages.addMessage(
            session.id,
            userInbound('copied prefix'),
            undefined,
            undefined,
            1_000
        )
        const forkPrompt = store.messages.addMessage(
            session.id,
            userInbound('fork prompt'),
            undefined,
            undefined,
            2_000
        )
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Forked')))
        const result = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)
        expect(result?.event.payloadJson).toMatchObject({
            causeMessageId: forkPrompt.id,
            causeText: 'fork prompt'
        })
        expect((result?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(copied.id)
    })

    it('later notifies bound the scan after the previous causeSeq', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-after-seq', {}, null, 'default')
        const firstUser = store.messages.addMessage(session.id, userInbound('first'))
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('First')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)
        expect(first?.event.payloadJson).toMatchObject({ causeSeq: firstUser.seq })

        const nextUser = store.messages.addMessage(session.id, userInbound('second'))
        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Second')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: nextUser.id,
            causeText: 'second',
            causeSeq: nextUser.seq
        })
    })

    it('legacy notify without causeSeq still consumes inbounds at or before that assistant', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-legacy-seq', {}, null, 'default')
        const oldUser = store.messages.addMessage(session.id, userInbound('old prompt'))
        const oldAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Legacy')))
        store.workGraph.insertEvent('default', {
            source_kind: 'session',
            source_ref: session.id,
            event_type: 'work_ad',
            related_session_id: session.id,
            summary: 'legacy',
            provenance: 'AGENT_NOTIFY_SUMMARY',
            payload_json: {
                status: 'done',
                messageId: oldAssistant.id
            },
            principal: { kind: 'agent', id: `session:${session.id}`, on_behalf_of: '1' }
        })

        const nextUser = store.messages.addMessage(session.id, userInbound('new prompt'))
        const nextAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Next')))
        const result = ingestNotify(store, session.id, 'default', nextAssistant.content, nextAssistant.id)
        expect(result?.event.payloadJson).toMatchObject({
            causeMessageId: nextUser.id,
            causeText: 'new prompt'
        })
        expect((result?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(oldUser.id)
    })

    it('treats an unmarked local CLI prompt as a cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-local-cli', {}, null, 'default')
        const local = store.messages.addMessage(session.id, userInbound('typed in the TTY', 'cli'))
        const assistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Local turn')))
        const result = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)
        expect(result?.event.payloadJson).toMatchObject({
            causeMessageId: local.id,
            causeText: 'typed in the TTY',
            causeKind: 'cli'
        })
    })

    it('skips Claude transcript echoes so the next turn is not attributed to the previous prompt copy', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-echo', {}, null, 'default')

        const web1 = store.messages.addMessage(session.id, userInbound('turn one'))
        store.messages.addMessage(
            session.id,
            userInbound('turn one', 'cli', { isTranscriptEcho: true })
        )
        const firstAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('One')))
        const first = ingestNotify(store, session.id, 'default', firstAssistant.content, firstAssistant.id)
        expect(first?.event.payloadJson).toMatchObject({ causeMessageId: web1.id })

        const web2 = store.messages.addMessage(session.id, userInbound('turn two'))
        store.messages.addMessage(
            session.id,
            userInbound('turn two', 'cli', { isTranscriptEcho: true })
        )
        const secondAssistant = store.messages.addMessage(session.id, assistantOutput(notifyFooter('Two')))
        const second = ingestNotify(store, session.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: web2.id,
            causeText: 'turn two'
        })
    })

    it('still inserts when max-clamped footer fields share the payload with cause', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sess-cause-budget', {}, null, 'default')
        store.messages.addMessage(session.id, userInbound('prompt'))
        const fat = 'a'.repeat(6_000)
        const assistant = store.messages.addMessage(session.id, assistantOutput(
            `AGENT_NOTIFY_SUMMARY ${JSON.stringify({
                status: 'done',
                summary: 'ok',
                action: fat,
                project: fat,
                agent: fat
            })}`
        ))
        const result = ingestNotify(store, session.id, 'default', assistant.content, assistant.id)
        expect(result?.inserted).toBe(true)
        expect(result?.event.payloadJson).toMatchObject({
            causeText: 'prompt',
            action: fat
        })
    })

    it('preserves notify history across mergeSessions into the surviving id', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, {
            emit: (_event: SyncEvent) => {}
        } as EventPublisher)
        const oldSession = cache.getOrCreateSession(
            'sess-cause-merge-old',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const newSession = cache.getOrCreateSession(
            'sess-cause-merge-new',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )

        store.messages.addMessage(oldSession.id, userInbound('from the old session'))
        const firstAssistant = store.messages.addMessage(oldSession.id, assistantOutput(notifyFooter('Old turn')))
        const first = ingestNotify(store, oldSession.id, 'default', firstAssistant.content, firstAssistant.id)
        expect(first?.inserted).toBe(true)

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const nextUser = store.messages.addMessage(newSession.id, userInbound('after merge'))
        const nextAssistant = store.messages.addMessage(newSession.id, assistantOutput(notifyFooter('New turn')))
        const second = ingestNotify(store, newSession.id, 'default', nextAssistant.content, nextAssistant.id)

        expect(second?.event.relatedEventId).toBe(first!.event.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: nextUser.id,
            causeText: 'after merge'
        })
        const onSurvivor = store.workGraph.listWorkAdsByRelatedSession('default', newSession.id)
            .map((event) => event.id)
        expect(onSurvivor).toContain(first!.event.id)
        expect(onSurvivor).toContain(second!.event.id)
    })

    it('keeps notify history on the live source after mergeSessionHistory', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, {
            emit: (_event: SyncEvent) => {}
        } as EventPublisher)
        const source = cache.getOrCreateSession(
            'sess-cause-hist-src',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const target = cache.getOrCreateSession(
            'sess-cause-hist-tgt',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )

        const firstUser = store.messages.addMessage(source.id, userInbound('live source prompt'))
        const firstAssistant = store.messages.addMessage(source.id, assistantOutput(notifyFooter('Before history merge')))
        const first = ingestNotify(store, source.id, 'default', firstAssistant.content, firstAssistant.id)
        expect(first?.inserted).toBe(true)

        await cache.mergeSessionHistory(source.id, target.id, 'default', { mergeAgentState: false })

        const nextUser = store.messages.addMessage(source.id, userInbound('still on the live source'))
        const nextAssistant = store.messages.addMessage(source.id, assistantOutput(notifyFooter('After history merge')))
        const second = ingestNotify(store, source.id, 'default', nextAssistant.content, nextAssistant.id)

        expect(second?.event.relatedEventId).toBe(first!.event.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: nextUser.id,
            causeText: 'still on the live source'
        })
        expect((second?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(firstUser.id)
        const onSource = store.workGraph.listWorkAdsByRelatedSession('default', source.id)
            .map((event) => event.id)
        expect(onSource).toContain(first!.event.id)
        expect(onSource).toContain(second!.event.id)
    })

    it('does not re-attribute a prior batch after surviving-session seq-shift', () => {
        const store = new Store(':memory:')
        const surviving = store.sessions.getOrCreateSession('sess-cause-shift-live', {}, null, 'default')
        const incoming = store.sessions.getOrCreateSession('sess-cause-shift-in', {}, null, 'default')

        const one = store.messages.addMessage(surviving.id, userInbound('one'), 'shift-1')
        const two = store.messages.addMessage(surviving.id, userInbound('two'), 'shift-2')
        store.messages.addMessage(surviving.id, userInbound('three'), 'shift-3')
        store.messages.markMessagesInvoked(surviving.id, ['shift-1', 'shift-2', 'shift-3'], 1_700_000_222_000)
        const assistant = store.messages.addMessage(surviving.id, assistantOutput(notifyFooter('Batched')))
        const first = ingestNotify(store, surviving.id, 'default', assistant.content, assistant.id)
        expect(first?.event.payloadJson).toMatchObject({ causeMessageId: one.id })

        store.messages.addMessage(incoming.id, userInbound('history from the other id'))
        store.messages.mergeSessionMessages(incoming.id, surviving.id)

        const secondAssistant = store.messages.addMessage(
            surviving.id,
            assistantOutput(notifyFooter('Sticky after merge'))
        )
        const second = ingestNotify(store, surviving.id, 'default', secondAssistant.content, secondAssistant.id)
        expect(second?.event.payloadJson).toMatchObject({
            causeMessageId: one.id,
            causeText: 'one'
        })
        expect((second?.event.payloadJson as { causeMessageId?: string })?.causeMessageId)
            .not.toBe(two.id)
    })
})
