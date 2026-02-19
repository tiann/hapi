import { Store } from '../store'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'

// Mock EventPublisher
const mockPublisher = {
    emit: () => {},
    subscribe: () => () => {},
} as unknown as EventPublisher

// Setup Store
const dbPath = ':memory:'
const store = new Store(dbPath)

// Create 1000 sessions
console.log('Creating 1000 sessions...')
const startCreate = performance.now()
const namespace = 'default'
const db = (store as any).db // Access private db property for direct insertion if needed, but using public API is safer

// Batch insert using transaction for speed during setup
const insertStmt = db.prepare(`
    INSERT INTO sessions (
        id, tag, namespace, machine_id, created_at, updated_at,
        metadata, metadata_version,
        agent_state, agent_state_version,
        todos, todos_updated_at,
        active, active_at, seq
    ) VALUES (
        @id, @tag, @namespace, NULL, @created_at, @updated_at,
        @metadata, 1,
        @agent_state, 1,
        NULL, NULL,
        0, NULL, 0
    )
`)

const setupTransaction = db.transaction((count: number) => {
    const now = Date.now()
    for (let i = 0; i < count; i++) {
        insertStmt.run({
            id: crypto.randomUUID(),
            tag: `tag-${i}`,
            namespace,
            created_at: now,
            updated_at: now,
            metadata: JSON.stringify({ name: `Session ${i}` }),
            agent_state: JSON.stringify({ step: 1 })
        })
    }
})

setupTransaction(1000)

console.log(`Created 1000 sessions in ${(performance.now() - startCreate).toFixed(2)}ms`)

// Initialize SessionCache
const cache = new SessionCache(store, mockPublisher)

// Measure reloadAll
console.log('Running reloadAll()...')
const startReload = performance.now()
cache.reloadAll()
const endReload = performance.now()

console.log(`reloadAll() took ${(endReload - startReload).toFixed(2)}ms`)

// Verify we have sessions
console.log(`Loaded ${cache.getSessions().length} sessions into cache.`)
