import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'
import {
    MAX_INDEXED_MESSAGE_CHARACTERS,
    removeMessageContentSearchForSessions
} from './messageContentSearch'

function makeSession(store: Store, tag: string, namespace = 'default') {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, namespace)
}

function failSessionDelete(store: Store): void {
    const db = (store as unknown as { db: Database }).db
    db.exec(`
        CREATE TRIGGER fail_session_delete
        BEFORE DELETE ON sessions
        BEGIN
            SELECT RAISE(ABORT, 'forced session delete failure');
        END
    `)
}

describe('message content search', () => {
    it('indexes visible user and assistant prose, including compressed messages', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'content-search')
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'How do I rotate the cache key?' }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'Use the key rotation command.' } }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call', input: { text: 'cache key' } } }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: `long answer ${'cache rotation '.repeat(40)}` }
            }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isMeta: true,
                    message: { content: [{ type: 'text', text: 'hidden cache rotation metadata' }] }
                }
            }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'hidden sidechain prose' }] }
                }
            }
        })

        expect(store.messages.searchContent('rotate the cache', 'default').map((result) => result.sessionId))
            .toEqual([session.id])
        expect(store.messages.searchContent('rotation command', 'default')[0]?.role).toBe('assistant')
        expect(store.messages.searchContent('cache key', 'default')[0]?.role).toBe('user')
        expect(store.messages.searchContent('cache key', 'default')[0]?.snippet).toContain('cache')
        expect(store.messages.searchContent('hidden cache rotation', 'default')).toEqual([])
        expect(store.messages.searchContent('hidden sidechain prose', 'default')).toEqual([])
    })

    it('indexes only visible AGY planner prose', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'agy-content-search')
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_message',
                    content: 'Visible planner answer\n[Message] timestamp=2026-07-08T06:04:31Z content=Hidden background task payload'
                }
            }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_message',
                    content: 'Inside the task-246 log...\n[Message] timestamp=2026-07-08T06:04:31Z content=Another hidden task payload'
                }
            }
        })

        expect(store.messages.searchContent('Visible planner', 'default'))
            .toMatchObject([{ sessionId: session.id }])
        expect(store.messages.searchContent('Hidden background', 'default')).toEqual([])
        expect(store.messages.searchContent('Another hidden', 'default')).toEqual([])
    })

    it('uses the indexed short-query path for CJK queries and isolates namespaces', () => {
        const store = new Store(':memory:')
        const defaultSession = makeSession(store, 'cjk-default')
        const otherSession = makeSession(store, 'cjk-other', 'other')
        store.messages.addMessage(defaultSession.id, {
            role: 'user',
            content: { type: 'text', text: '中文缓存搜索测试' }
        })
        store.messages.addMessage(otherSession.id, {
            role: 'user',
            content: { type: 'text', text: '中文缓存搜索测试' }
        })

        expect(store.messages.searchContent('搜索', 'default').map((result) => result.sessionId))
            .toEqual([defaultSession.id])
        expect(store.messages.searchContent('搜索', 'other').map((result) => result.sessionId))
            .toEqual([otherSession.id])
        expect(store.messages.searchContent('搜', 'default')).toEqual([])
        expect(store.messages.searchContentInSession('搜', 'default', defaultSession.id))
            .toEqual({ matches: [], total: 0 })
    })

    it('bounds per-message short-index work for long high-entropy text', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'bounded-short-index')
        const text = `${Array.from({ length: MAX_INDEXED_MESSAGE_CHARACTERS + 1024 }, (_, index) =>
            String.fromCodePoint(0x1000 + index)
        ).join('')} tail-search-needle`

        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text }
        })

        const db = (store as unknown as { db: Database }).db
        const row = db.prepare(`
            SELECT rowid AS search_rowid
            FROM message_content_search
            LIMIT 1
        `).get() as { search_rowid: number }
        const indexedText = db.prepare(`
            SELECT searchable_text
            FROM message_content_search
            WHERE rowid = ?
        `).get(row.search_rowid) as { searchable_text: string }
        const count = db.prepare(`
            SELECT COUNT(*) AS count
            FROM message_content_search_short
            WHERE search_rowid = ?
        `).get(row.search_rowid) as { count: number | string }

        expect(indexedText.searchable_text.length).toBeLessThanOrEqual(MAX_INDEXED_MESSAGE_CHARACTERS)
        expect(indexedText.searchable_text).toContain('tail-search-needle')
        expect(Number(count.count)).toBeLessThanOrEqual(MAX_INDEXED_MESSAGE_CHARACTERS - 1)
        expect(store.messages.searchContent('tail-search-needle', 'default'))
            .toMatchObject([{ sessionId: session.id }])
    })

    it('defers live stream snapshots until the explicit terminal snapshot', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'live-stream-index')
        const db = (store as unknown as { db: Database }).db
        const liveContent = (message: string) => ({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    id: 'pi-stream-1',
                    message,
                    streamSnapshot: true,
                    live: true
                }
            }
        })

        store.messages.addMessage(session.id, liveContent('partial response 1'))
        store.messages.addMessage(session.id, liveContent('partial response 2'))
        expect(Number((db.prepare('SELECT COUNT(*) AS count FROM message_content_search').get() as { count: number | string }).count))
            .toBe(0)

        const terminal = store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    id: 'pi-stream-1',
                    message: 'complete terminal response',
                    streamSnapshot: true
                }
            }
        })

        expect(Number((db.prepare('SELECT COUNT(*) AS count FROM message_content_search').get() as { count: number | string }).count))
            .toBe(1)
        expect(store.messages.searchContent('terminal response', 'default'))
            .toMatchObject([{ sessionId: session.id, messageId: terminal.id }])
    })

    it('matches visible Markdown text rather than source delimiters', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'markdown-content-search')
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'Use **KV Cache** for this path.' }
            }
        })

        expect(store.messages.searchContent('KV Cache', 'default'))
            .toMatchObject([{ sessionId: session.id }])
    })

    it('indexes visible non-sidechain Claude user records', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'claude-user-content-search')
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: 'Find this Claude prompt.' }] }
                }
            }
        })

        expect(store.messages.searchContent('Claude prompt', 'default'))
            .toMatchObject([{ sessionId: session.id }])
    })

    it('applies the result limit after deduplicating matching sessions', () => {
        const store = new Store(':memory:')
        const otherSession = makeSession(store, 'content-search-other')
        const busySession = makeSession(store, 'content-search-busy')

        store.messages.addMessage(otherSession.id, {
            role: 'user',
            content: { type: 'text', text: 'needle in another session' }
        })
        for (let index = 0; index < 201; index += 1) {
            store.messages.addMessage(busySession.id, {
                role: 'user',
                content: { type: 'text', text: `needle in frequent result ${index}` }
            })
        }
        store.sessions.touchSessionUpdatedAt(busySession.id, Date.now() + 1_000, 'default')

        expect(store.messages.searchContent('needle', 'default', 2).map((result) => result.sessionId))
            .toEqual([busySession.id, otherSession.id])
    })

    it('restricts global content search to requested sessions before applying the limit', () => {
        const store = new Store(':memory:')
        const first = makeSession(store, 'content-search-scope-first')
        const second = makeSession(store, 'content-search-scope-second')
        for (const session of [first, second]) {
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'scoped needle' }
            })
        }

        expect(store.messages.searchContent('scoped needle', 'default', 1, [second.id])
            .map((result) => result.sessionId))
            .toEqual([second.id])
    })

    it('supports scoped content search beyond SQLite variable limits', () => {
        const store = new Store(':memory:')
        const sessions = Array.from({ length: 1001 }, (_, index) =>
            makeSession(store, `large-content-scope-${index}`)
        )
        const target = sessions.at(-1)!
        const message = store.messages.addMessage(target.id, {
            role: 'user',
            content: { type: 'text', text: 'large scoped needle' }
        })

        expect(store.messages.searchContent('large scoped needle', 'default', 1, sessions.map((session) => session.id)))
            .toMatchObject([{ sessionId: target.id, messageId: message.id }])
    })

    it('returns message-level matches and the full count for one session', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'message-level-search')
        const older = store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'needle in the older message' }
        })
        const newer = store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'needle in the newer message' } }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'unrelated' } }
        })

        const result = store.messages.searchContentInSession('needle', 'default', session.id)
        expect(result.total).toBe(2)
        expect(result.matches.map((match) => match.messageId)).toEqual([newer.id, older.id])
        expect(result.matches.map((match) => match.sessionId)).toEqual([session.id, session.id])
    })

    it('collapses streamed assistant snapshots to the latest rendered message', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'streamed-content-search')
        const firstSnapshot = store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-1', message: 'old streamed needle' }
            }
        })
        const latestSnapshot = store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-1', message: 'latest streamed answer' }
            }
        })

        expect(store.messages.searchContent('old streamed', 'default')).toEqual([])
        expect(store.messages.searchContent('latest streamed', 'default')[0]?.messageId)
            .toBe(latestSnapshot.id)
        expect(store.messages.searchContentInSession('streamed', 'default', session.id))
            .toMatchObject({ total: 1, matches: [{ messageId: latestSnapshot.id }] })

        const emptySnapshot = store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-2', message: 'temporary streamed phrase' }
            }
        })
        expect(store.messages.searchContent('temporary streamed', 'default')[0]?.messageId)
            .toBe(emptySnapshot.id)
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-2', message: '' }
            }
        })
        expect(store.messages.searchContent('temporary streamed', 'default')).toEqual([])
        expect(firstSnapshot.id).not.toBe(latestSnapshot.id)
    })

    it('does not expose queued messages until they are invoked', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'queued-content')
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'queued secret phrase' }
        }, 'queued-1')

        expect(store.messages.searchContent('secret phrase', 'default')).toEqual([])
        store.messages.markMessagesInvoked(session.id, ['queued-1'], 123)
        expect(store.messages.searchContent('secret phrase', 'default')[0]?.sessionId).toBe(session.id)
    })

    it('keeps the derived index in sync with deletion and session merge', () => {
        const store = new Store(':memory:')
        const from = makeSession(store, 'merge-from')
        const to = makeSession(store, 'merge-to')
        const message = store.messages.addMessage(from.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'mergeable result' } }
        })

        expect(store.messages.searchContent('mergeable', 'default')[0]?.messageId).toBe(message.id)
        store.messages.mergeSessionMessages(from.id, to.id)
        expect(store.messages.searchContent('mergeable', 'default')[0]?.sessionId).toBe(to.id)
        store.sessions.deleteSession(to.id, 'default')
        expect(store.messages.searchContent('mergeable', 'default')).toEqual([])
    })

    it('keeps searchable content when session deletion fails after index cleanup starts', () => {
        const store = new Store(':memory:')
        const session = makeSession(store, 'delete-index-rollback')
        const message = store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'delete rollback phrase' }
        })
        failSessionDelete(store)

        expect(() => store.sessions.deleteSession(session.id, 'default'))
            .toThrow('forced session delete failure')
        expect(store.sessions.getSession(session.id)).not.toBeNull()
        expect(store.messages.searchContent('delete rollback', 'default')[0]?.messageId)
            .toBe(message.id)
    })

    it('cleans derived rows before a bulk session deletion', () => {
        const store = new Store(':memory:')
        const first = makeSession(store, 'bulk-delete-first')
        const second = makeSession(store, 'bulk-delete-second')
        for (const session of [first, second]) {
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'bulk cleanup phrase' }
            })
        }

        const db = (store as unknown as { db: Database }).db
        removeMessageContentSearchForSessions(db, [first.id, second.id])
        db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run(first.id, second.id)

        expect(store.messages.searchContent('bulk cleanup phrase', 'default')).toEqual([])
    })
})
