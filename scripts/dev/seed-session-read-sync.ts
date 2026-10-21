/** Isolated archived fixtures; requires an explicit disposable Hub database. */
import { resolve } from 'node:path'
import { Store } from '../../hub/src/store'

const dbPath = process.env.HAPI_READ_SYNC_TEST_DB
if (!dbPath || !resolve(dbPath).includes('session-read-sync')) {
    throw new Error('Set HAPI_READ_SYNC_TEST_DB to the isolated session-read-sync test database')
}
const store = new Store(dbPath)
for (const suffix of ['a', 'b', 'c']) {
    const id = `read-sync-fixture-${suffix}`
    const existing = store.sessions.getSession(id)
    if (existing && existing.tag !== id) throw new Error('Refusing to overwrite a non-fixture session')
    const session = store.sessions.getOrCreateSession(id, {
        path: '/read-sync-fixture', host: 'Read sync fixtures', name: `Read sync ${suffix.toUpperCase()}`,
        flavor: 'claude', lifecycleState: 'archived'
    }, null, 'default', undefined, undefined, undefined, id)
    if (!store.messages.countMessages(session.id)) store.messages.addMessage(session.id, {
        role: 'agent', content: { type: 'output', data: {
            type: 'assistant', uuid: `reply-${suffix}`, parentUuid: null, isSidechain: false,
            message: { content: [{ type: 'text', text: `Read synchronization fixture ${suffix.toUpperCase()}.` }] }
        } }
    })
    console.log(`${session.id}: ${store.sessions.getSession(id)!.updatedAt}`)
}
store.close()
