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
})
