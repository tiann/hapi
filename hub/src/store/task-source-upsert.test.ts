import { expect, test } from 'bun:test'
import { Store } from './index'

test('refreshes a merged tool call at its source position without overriding later plans', () => {
    const store = new Store(':memory:')
    try {
        const session = store.sessions.getOrCreateSession('task-source-upsert', {}, {}, 'default')
        const first = [{ id: '1', content: 'Work', status: 'pending' }]
        const completed = [{ id: '1', content: 'Work', status: 'completed' }]
        expect(store.sessions.setSessionTodos(session.id, first, { at: 100, seq: 1 }, 'default')).toBe(true)
        const version = store.sessions.getSession(session.id)!.todosUpdatedAt!
        expect(store.sessions.setSessionTodos(session.id, completed, { at: 100, seq: 1 }, 'default', { allowSameSource: true })).toBe(true)
        expect(store.sessions.getSession(session.id)!.todosUpdatedAt!).toBeGreaterThan(version)
        expect(store.sessions.setSessionTodos(session.id, first, { at: 200, seq: 2 }, 'default')).toBe(true)
        expect(store.sessions.setSessionTodos(session.id, completed, { at: 100, seq: 1 }, 'default', { allowSameSource: true })).toBe(false)
        expect(store.sessions.getSession(session.id)!.todos).toEqual(first)
    } finally { store.close() }
})
