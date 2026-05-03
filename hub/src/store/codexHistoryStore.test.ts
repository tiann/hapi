import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'

import { Store } from './index'

describe('CodexHistoryStore', () => {
    it('creates v9 codex history table on fresh DB', () => {
        const store = new Store(':memory:')
        const db: Database = (store as any).db
        const rows = db.prepare("PRAGMA table_info(codex_history_items)").all() as Array<{ name: string }>
        const columns = rows.map((row) => row.name)

        expect(columns).toContain('session_id')
        expect(columns).toContain('codex_thread_id')
        expect(columns).toContain('turn_id')
        expect(columns).toContain('item_id')
        expect(columns).toContain('message_seq')
        expect(columns).toContain('raw_item')
        expect(columns).toContain('seq')
    })

    it('returns raw history prefix before the selected user message', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('s1', { flavor: 'codex' }, null, 'default')

        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'user-1',
            itemKind: 'user',
            messageSeq: 1,
            rawItem: { id: 'user-1', role: 'user' }
        })
        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'assistant-1',
            itemKind: 'assistant',
            rawItem: { id: 'assistant-1', role: 'assistant' }
        })
        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'user-2',
            itemKind: 'user',
            messageSeq: 3,
            rawItem: { id: 'user-2', role: 'user' }
        })

        expect(store.codexHistory.getPrefixBeforeMessageSeq(session.id, 3)).toEqual([
            { id: 'user-1', role: 'user' },
            { id: 'assistant-1', role: 'assistant' }
        ])
        expect(store.codexHistory.getPrefixBeforeMessageSeq(session.id, 1)).toEqual([])
        expect(store.codexHistory.getPrefixBeforeMessageSeq(session.id, 2)).toBeNull()
    })

    it('returns raw history through the selected user reply', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('s1', { flavor: 'codex' }, null, 'default')

        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'user-1',
            itemKind: 'user',
            messageSeq: 1,
            rawItem: { id: 'user-1', role: 'user' }
        })
        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'assistant-1',
            itemKind: 'assistant',
            rawItem: { id: 'assistant-1', role: 'assistant' }
        })
        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'user-2',
            itemKind: 'user',
            messageSeq: 3,
            rawItem: { id: 'user-2', role: 'user' }
        })
        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'assistant-2',
            itemKind: 'assistant',
            rawItem: { id: 'assistant-2', role: 'assistant' }
        })

        expect(store.codexHistory.getPrefixThroughReplyForUserMessageSeq(session.id, 1)).toEqual([
            { id: 'user-1', role: 'user' },
            { id: 'assistant-1', role: 'assistant' }
        ])
        expect(store.codexHistory.getPrefixThroughReplyForUserMessageSeq(session.id, 3)).toEqual([
            { id: 'user-1', role: 'user' },
            { id: 'assistant-1', role: 'assistant' },
            { id: 'user-2', role: 'user' },
            { id: 'assistant-2', role: 'assistant' }
        ])
        expect(store.codexHistory.getPrefixThroughReplyForUserMessageSeq(session.id, 2)).toBeNull()
    })

    it('deletes codex history rows when deleting the session', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('s1', { flavor: 'codex' }, null, 'default')
        const db: Database = (store as any).db

        store.codexHistory.addItem({
            sessionId: session.id,
            codexThreadId: 'thread-1',
            itemId: 'user-1',
            itemKind: 'user',
            messageSeq: 1,
            rawItem: { id: 'user-1', role: 'user' }
        })

        expect(db.prepare('SELECT COUNT(*) AS count FROM codex_history_items').get()).toEqual({ count: 1 })
        store.sessions.deleteSession(session.id, 'default')
        expect(db.prepare('SELECT COUNT(*) AS count FROM codex_history_items').get()).toEqual({ count: 0 })
    })
})
