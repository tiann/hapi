import { describe, expect, it } from 'bun:test'
import { toSessionSummary, type SyncEvent } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

const userText = (text: string) => ({ role: 'user', content: { type: 'text', text } })

describe('session parent link recording and persistence', () => {
    function setup() {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast: (event: SyncEvent) => events.push(event) } as never
        )
        const receive = (sessionId: string, content: unknown, localId?: string) => {
            const message = store.messages.addMessage(sessionId, content, localId)
            engine.handleRealtimeEvent({ type: 'message-received', sessionId, message })
        }
        return { store, events, engine, receive }
    }

    it('records parentSessionId from an explicit ## Parent remit in the same namespace', () => {
        const { store, events, engine, receive } = setup()
        try {
            const parent = engine.getOrCreateSession('parent-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const child = engine.getOrCreateSession('child-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')

            const remit = [
                '## Parent',
                `- Orchestrator chip (mandatory): [Lead](/sessions/${parent.id})`,
                '',
                'Verify the build'
            ].join('\n')
            receive(child.id, userText(remit), 'remit-1')

            const updated = engine.getSession(child.id)!
            expect(updated.metadata?.parentSessionId).toBe(parent.id)
            const summary = toSessionSummary(updated)
            expect(summary.metadata?.parentLink).toEqual({
                parentSessionId: parent.id,
                kind: 'peer'
            })

            const patch = events.find((event) => event.type === 'session-updated'
                && event.sessionId === child.id
                && (event.data as { metadata?: { value?: { parentSessionId?: string } } } | undefined)?.metadata?.value?.parentSessionId === parent.id)
            expect(patch).toBeDefined()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each([false, true])('checks the first user input after a long agent prelude (earlier user: %s)', (earlierUser) => {
        const { store, engine } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac' }
            const parent = engine.getOrCreateSession('parent', metadata, null, 'default')
            const child = engine.getOrCreateSession('child', metadata, null, 'default')
            for (let i = 0; i < 60; i++) {
                store.messages.addMessage(child.id, { role: 'agent', content: 'startup'.repeat(64) })
            }
            store.messages.addMessage(child.id, { ...userText('echo'), meta: { isTranscriptEcho: true } })
            if (earlierUser) store.messages.addMessage(child.id, userText('earlier input'.repeat(64)))
            const stamp = `## Parent\n- Orchestrator chip (mandatory): [Lead](/sessions/${parent.id})`
            const message = store.messages.addMessage(child.id, userText(stamp))
            engine.handleRealtimeEvent({ type: 'message-received', sessionId: child.id, message: { ...message, seq: null } })
            expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBe(earlierUser ? undefined : parent.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('ignores quoted and leading parent stamps in later user messages', () => {
        const { store, engine, receive } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac' }
            const parent = engine.getOrCreateSession('parent', metadata, null, 'default')
            const child = engine.getOrCreateSession('child', metadata, null, 'default')
            const stamp = `## Parent\n- Orchestrator chip (mandatory): [Lead](/sessions/${parent.id})`
            receive(child.id, userText('Start an unrelated task'))
            receive(child.id, userText(['A previous remit:', '```', stamp, '```'].join('\n')))
            expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBeUndefined()
            receive(child.id, userText(stamp))
            expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBeUndefined()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('ignores same-namespace citations without a canonical parent stamp', () => {
        const { store, engine, receive } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac' }
            const parent = engine.getOrCreateSession('parent', metadata, null, 'default')
            const child = engine.getOrCreateSession('child', metadata, null, 'default')
            const chip = `[Lead](/sessions/${parent.id})`
            for (const prompt of [
                `## Parent branch notes\n- Orchestrator chip (mandatory): ${chip}`,
                `## Parent\nSee ${chip} for context`,
            ]) {
                receive(child.id, userText(prompt))
                expect(engine.getSession(child.id)?.metadata?.parentSessionId).toBeUndefined()
            }
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('ignores casual /sessions/<id> citations, unknown targets, and cross-namespace parents', () => {
        const { store, engine, receive } = setup()
        try {
            const otherNsParent = engine.getOrCreateSession('other-ns-parent', { path: '/tmp/repo', host: 'mac' }, null, 'other-ns')
            const sameNsChild = engine.getOrCreateSession('child-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')

            receive(sameNsChild.id, userText(`See session "Other" (/sessions/${otherNsParent.id}) for context`), 'casual')
            expect(engine.getSession(sameNsChild.id)?.metadata?.parentSessionId).toBeUndefined()

            const crossNsRemit = [
                '## Parent',
                `- Orchestrator chip (mandatory): [Foreign](/sessions/${otherNsParent.id})`,
                '',
                'Do work'
            ].join('\n')
            receive(sameNsChild.id, userText(crossNsRemit), 'cross-ns')
            expect(engine.getSession(sameNsChild.id)?.metadata?.parentSessionId).toBeUndefined()

            const selfRemit = [
                '## Parent',
                `- Orchestrator chip (mandatory): [Self](/sessions/${sameNsChild.id})`,
                '',
                'Loop check'
            ].join('\n')
            receive(sameNsChild.id, userText(selfRemit), 'self')
            expect(engine.getSession(sameNsChild.id)?.metadata?.parentSessionId).toBeUndefined()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('adopts a preallocated peer with its updated parent after a parent merge', async () => {
        const { store, engine } = setup()
        try {
            const metadata = { path: '/tmp/repo', host: 'mac' }
            const parent = engine.getOrCreateSession('parent', metadata, null, 'default')
            const replacement = engine.getOrCreateSession('replacement', metadata, null, 'default')
            const peerId = crypto.randomUUID()
            engine.getOrCreateSession(
                `machine-spawn:${peerId}`, { ...metadata, parentSessionId: parent.id },
                null, 'default', undefined, undefined, undefined, peerId
            )

            await engine['sessionCache'].mergeSessions(parent.id, replacement.id, 'default')
            const adopted = engine.adoptPreallocatedSession(peerId, 'runner-peer', metadata, null, 'default')
            expect(adopted.id).toBe(peerId)
            expect(adopted.metadata?.parentSessionId).toBe(replacement.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('preserves hub-owned parentSessionId across sparse CLI metadata rewrites', () => {
        const { store, engine } = setup()
        try {
            const parent = engine.getOrCreateSession('parent-tag', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const child = engine.getOrCreateSession(
                'child-tag',
                { path: '/tmp/repo', host: 'mac', parentSessionId: parent.id },
                null,
                'default'
            )

            const update = store.sessions.updateSessionMetadata(
                child.id,
                { path: '/tmp/repo', host: 'mac' },
                child.metadataVersion,
                'default'
            )
            expect(update.result).toBe('success')
            expect(store.sessions.getSession(child.id)?.metadata).toMatchObject({
                parentSessionId: parent.id
            })
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('sanitizes incoming parentSessionId on session creation across namespaces', () => {
        const { store, engine } = setup()
        try {
            const otherNsParent = engine.getOrCreateSession('foreign-parent', { path: '/tmp/repo', host: 'mac' }, null, 'other-ns')
            const sameNsParent = engine.getOrCreateSession('same-parent', { path: '/tmp/repo', host: 'mac' }, null, 'default')

            const rejected = engine.getOrCreateSession(
                'rejected-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: otherNsParent.id },
                null,
                'default'
            )
            expect(rejected.metadata?.parentSessionId).toBeUndefined()

            const accepted = engine.getOrCreateSession(
                'accepted-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: sameNsParent.id },
                null,
                'default'
            )
            expect(accepted.metadata?.parentSessionId).toBe(sameNsParent.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('retargets children on parent merge', async () => {
        const { store, events, engine } = setup()
        try {
            const oldParent = engine.getOrCreateSession('old-parent', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const newParent = engine.getOrCreateSession('new-parent', { path: '/tmp/repo', host: 'mac' }, null, 'default')
            const peer = engine.getOrCreateSession(
                'peer-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: oldParent.id },
                null,
                'default'
            )

            const forkedChild = engine.getOrCreateSession(
                'forked-child',
                { path: '/tmp/repo', host: 'mac', forkedFrom: oldParent.id },
                null,
                'default'
            )
            const branchedChild = engine.getOrCreateSession(
                'branched-child',
                {
                    path: '/tmp/repo',
                    host: 'mac',
                    conversationBranch: {
                        sourceSessionId: oldParent.id,
                        boundary: 'after',
                        mode: 'visible-text',
                        requestFingerprint: 'fp-merge-1',
                        state: 'started',
                        createdAt: 100,
                        messageCount: 1,
                        workspace: 'current',
                    }
                },
                null,
                'default'
            )

            const cache = (engine as unknown as {
                sessionCache: { mergeSessions: (a: string, b: string, ns: string) => Promise<void> }
            }).sessionCache
            await cache.mergeSessions(oldParent.id, newParent.id, 'default')

            expect(engine.getSession(peer.id)?.metadata?.parentSessionId).toBe(newParent.id)
            expect(engine.getSession(forkedChild.id)?.metadata?.forkedFrom).toBe(newParent.id)
            expect(engine.getSession(branchedChild.id)?.metadata?.conversationBranch?.sourceSessionId).toBe(newParent.id)

            const lateChild = engine.getOrCreateSession(
                'late-child',
                { path: '/tmp/repo', host: 'mac', parentSessionId: oldParent.id },
                null,
                'default'
            )
            expect(engine.getSession(lateChild.id)?.metadata?.parentSessionId).toBe(newParent.id)
            expect(events.some((e) => e.type === 'session-updated' && e.sessionId === peer.id)).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })
})
