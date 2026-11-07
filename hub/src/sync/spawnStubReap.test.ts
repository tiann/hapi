import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { machineSpawnPreallocTag } from '../store/sessions'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

const GRACE_MS = 10 * 60_000

/** `reapSpawnStubs` is private and fire-and-forget; the test drives it directly. */
type Reaper = {
    reapSpawnStubs(now: number): void
    lastSpawnStubReapAt: number
}

const asReaper = (engine: SyncEngine): Reaper => engine as unknown as Reaper

/** Mirrors what `spawnSession` writes before it asks the runner to start anything. */
function createStub(store: Store, id: string, metadata: Record<string, unknown> = { path: '/tmp/x', startedBy: 'runner' }): void {
    store.sessions.getOrCreateSession(
        machineSpawnPreallocTag(id),
        metadata,
        null,
        'default',
        undefined,
        undefined,
        undefined,
        id
    )
}

async function withStore(run: (store: Store, engine: Reaper) => Promise<void> | void): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-spawn-stub-'))
    const store = new Store(join(dir, 'test.db'))
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.stop()
    try {
        await run(store, asReaper(engine))
    } finally {
        store.close()
        rmSync(dir, { recursive: true, force: true })
    }
}

describe('machine-spawn stub reaping', () => {
    it('lists only rows still carrying the machine-spawn tag', async () => {
        await withStore((store) => {
            createStub(store, 'stub-a')
            store.sessions.getOrCreateSession('real-session', { path: '/tmp/y' }, null, 'default')

            // A future cutoff makes "old enough" trivially true for both rows, so
            // what separates them is the tag alone.
            const stale = store.sessions.listStaleMachineSpawnStubs(Date.now() + 1).map((s) => s.id)
            expect(stale).toEqual(['stub-a'])
        })
    })

    it('removes a stub that never booted, once it is past the grace period', async () => {
        await withStore(async (store, engine) => {
            createStub(store, 'stub-old')

            // Inside the grace period a slow runner may still be booting.
            engine.reapSpawnStubs(Date.now())
            expect(store.sessions.getSession('stub-old')).not.toBeNull()

            engine.lastSpawnStubReapAt = 0
            engine.reapSpawnStubs(Date.now() + GRACE_MS + 60_000)
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(store.sessions.getSession('stub-old')).toBeNull()
        })
    })

    it('keeps a stub whose CLI booted (hostPid present), however old', async () => {
        await withStore((store, engine) => {
            createStub(store, 'stub-booted', { path: '/tmp/x', startedBy: 'runner', hostPid: 4242 })

            engine.reapSpawnStubs(Date.now() + GRACE_MS + 60_000)
            expect(store.sessions.getSession('stub-booted')).not.toBeNull()
        })
    })

    it('keeps a real session that is merely old', async () => {
        await withStore((store, engine) => {
            store.sessions.getOrCreateSession('tag-for-other', { path: '/tmp/z' }, null, 'default', undefined, undefined, undefined, 'long-lived')

            engine.reapSpawnStubs(Date.now() + GRACE_MS + 60_000)
            expect(store.sessions.getSession('long-lived')).not.toBeNull()
        })
    })

    it('reaps only once per interval', async () => {
        await withStore(async (store, engine) => {
            createStub(store, 'stub-throttled')

            // First call arms the throttle...
            engine.reapSpawnStubs(Date.now() + GRACE_MS + 60_000)
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(store.sessions.getSession('stub-throttled')).toBeNull()

            // ...so a second stub created afterwards is not swept by the next tick.
            createStub(store, 'stub-later')
            engine.reapSpawnStubs(Date.now() + GRACE_MS + 61_000)
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(store.sessions.getSession('stub-later')).not.toBeNull()
        })
    })
})
