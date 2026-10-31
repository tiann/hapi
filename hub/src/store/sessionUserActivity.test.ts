import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const stores: Store[] = []
const dirs: string[] = []
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(path = ':memory:'): Store {
    const store = new Store(path)
    stores.push(store)
    return store
}
const user = (text = 'hello') => ({ role: 'user', content: { type: 'text', text } })
const create = (store: Store, tag = 's') => store.sessions.getOrCreateSession(tag, { path: '/tmp', host: 'mac' }, null, 'default')

describe('persisted last user-message time', () => {
    it('advances only for new human input, including attachment-only input', () => {
        const store = open()
        const session = create(store)
        const at = () => store.sessions.getSession(session.id)?.lastUserMessageAt
        expect(at()).toBeUndefined()
        store.messages.addMessage(session.id, user(), 'prompt', null, 100)
        expect(at()).toBe(100)
        store.messages.addMessage(session.id, user(), 'prompt', null, 900) // duplicate
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: 'tool result' } } } }, undefined, null, 1_000)
        store.messages.addMessage(session.id, { ...user(), meta: { isTranscriptEcho: true } }, undefined, null, 2_000)
        store.recordMessagesConsumed(session.id, ['prompt'], 3_000, 'default')
        store.sessions.touchSessionUpdatedAt(session.id, 4_000, 'default')
        expect(at()).toBe(100)
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '', attachments: [{ name: 'image.png' }] } }, 'attachment', null, 500)
        expect(at()).toBe(500)
    })

    it('preserves original time through import, copy, merge and restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-user-activity-'))
        dirs.push(dir)
        const path = join(dir, 'db')
        const store = open(path)
        const source = create(store, 'source')
        const target = create(store, 'target')
        store.messages.addImportedMessage(source.id, user('imported'), 'original', 500)
        store.messages.addImportedMessage(source.id, user('imported'), 'original', 900)
        store.messages.addImportedMessage(source.id, user('older'), 'older', 100)
        expect(store.sessions.getSession(source.id)?.lastUserMessageAt).toBe(500)
        store.messages.copyMessagesToSession(target.id, store.messages.getAllMessages(source.id))
        expect(store.sessions.getSession(target.id)?.lastUserMessageAt).toBe(500)
        store.messages.addMessage(source.id, user('new'), 'new', null, 700)
        store.messages.mergeSessionMessages(source.id, target.id)
        expect(store.sessions.getSession(target.id)?.lastUserMessageAt).toBe(700)
        stores.splice(stores.indexOf(store), 1)
        store.close()
        expect(open(path).sessions.getSession(target.id)?.lastUserMessageAt).toBe(700)
    })

    it('migrates plaintext/compressed history once, ignoring tool results and prompt echoes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-user-activity-migration-'))
        dirs.push(dir)
        const path = join(dir, 'db')
        const store = open(path)
        const session = create(store)
        const empty = create(store, 'empty')
        store.messages.addMessage(session.id, user(), 'plain', null, 100)
        store.messages.addMessage(session.id, user('compressed '.repeat(500)), 'compressed', null, 200)
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'later' } }, undefined, null, 300)
        store.messages.addMessage(session.id, { ...user(), meta: { isTranscriptEcho: true } }, undefined, null, 400)
        stores.splice(stores.indexOf(store), 1)
        store.close()
        const db = new Database(path)
        db.exec('ALTER TABLE sessions DROP COLUMN last_user_message_at; PRAGMA user_version = 28;')
        db.close()
        const migrated = open(path)
        expect(migrated.sessions.getSession(session.id)?.lastUserMessageAt).toBe(200)
        expect(migrated.sessions.getSession(empty.id)?.lastUserMessageAt).toBeUndefined()
    })
})
