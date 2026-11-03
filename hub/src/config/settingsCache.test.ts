import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    __resetSettingsReadCacheForTests,
    createSettingsReadCache,
    getSettingsFile,
    readSettingsOrThrowCached,
    updateSettings,
    type Settings
} from './settings'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
    __resetSettingsReadCacheForTests()
})

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/** Drain pending microtasks (background revalidations) without a real timer. */
async function settle() {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe('createSettingsReadCache', () => {
    it('cold reads share one in-flight disk read', async () => {
        let reads = 0
        const first = deferred<Settings | null>()
        const cache = createSettingsReadCache({
            ttlMs: 100,
            now: () => 0,
            read: () => {
                reads++
                return first.promise
            }
        })
        const a = cache.read('/tmp/x/settings.json')
        const b = cache.read('/tmp/x/settings.json')
        expect(reads).toBe(1)
        first.resolve({ listenPort: 1 })
        expect(await a).toEqual({ listenPort: 1 })
        expect(await b).toEqual({ listenPort: 1 })
    })

    it('fresh reads skip the disk entirely', async () => {
        let reads = 0
        let nowMs = 0
        const cache = createSettingsReadCache({
            ttlMs: 100,
            now: () => nowMs,
            read: () => {
                reads++
                return Promise.resolve<Settings | null>({ listenPort: 1 })
            }
        })
        expect(await cache.read('/tmp/x/settings.json')).toEqual({ listenPort: 1 })
        nowMs += 99
        expect(await cache.read('/tmp/x/settings.json')).toEqual({ listenPort: 1 })
        expect(reads).toBe(1)
    })

    it('stale reads serve the snapshot and revalidate single-flight', async () => {
        let reads = 0
        let nowMs = 0
        let revalidation: { promise: Promise<Settings | null>; resolve: (v: Settings | null) => void } | null = null
        const cache = createSettingsReadCache({
            ttlMs: 100,
            now: () => nowMs,
            read: () => {
                reads++
                if (reads === 1) return Promise.resolve<Settings | null>({ listenPort: 1 })
                revalidation = deferred<Settings | null>()
                return revalidation.promise
            }
        })
        const file = '/tmp/x/settings.json'
        await cache.read(file) // seed
        nowMs += 101 // expire
        // Five concurrent stale readers: all answered from memory, one kick.
        const stale = await Promise.all([1, 2, 3, 4, 5].map(() => cache.read(file)))
        expect(stale.every((s) => (s as Settings).listenPort === 1)).toBe(true)
        expect(reads).toBe(2) // seed + single revalidation
        revalidation!.resolve({ listenPort: 2 })
        await settle()
        nowMs += 1 // still within the new TTL
        expect(await cache.read(file)).toEqual({ listenPort: 2 })
    })

    it('revalidation failure keeps the snapshot servable', async () => {
        let reads = 0
        let nowMs = 0
        let failNext = false
        const cache = createSettingsReadCache({
            ttlMs: 100,
            now: () => nowMs,
            read: () => {
                reads++
                if (failNext) {
                    failNext = false
                    return Promise.reject(new Error('disk hiccup'))
                }
                return Promise.resolve<Settings | null>({ listenPort: reads })
            }
        })
        const file = '/tmp/x/settings.json'
        await cache.read(file)
        nowMs += 101
        failNext = true
        expect(await cache.read(file)).toEqual({ listenPort: 1 }) // stale served
        await settle() // background rejection swallowed
        nowMs += 101
        expect(await cache.read(file)).toEqual({ listenPort: 1 }) // still stale
        await settle() // recovery revalidation lands
        nowMs += 1 // within the new TTL
        expect(await cache.read(file)).toEqual({ listenPort: 3 }) // recovered
    })

    it('parse-null evicts the entry so the next read is loud', async () => {
        let reads = 0
        let nowMs = 0
        let nextNull = false
        const cache = createSettingsReadCache({
            ttlMs: 100,
            now: () => nowMs,
            read: () => {
                reads++
                return Promise.resolve<Settings | null>(nextNull ? null : { listenPort: 1 })
            }
        })
        const file = '/tmp/x/settings.json'
        await cache.read(file)
        nowMs += 101
        nextNull = true
        expect(await cache.read(file)).toEqual({ listenPort: 1 }) // stale served
        await settle() // background revalidation sees null -> evict
        nextNull = false
        nowMs += 101
        expect(await cache.read(file)).toEqual({ listenPort: 1 }) // cold re-read
        expect(reads).toBe(3)
    })

    it('write-through refresh beats a late-landing revalidation', async () => {
        let reads = 0
        let nowMs = 0
        let revalidation: { promise: Promise<Settings | null>; resolve: (v: Settings | null) => void } | null = null
        const cache = createSettingsReadCache({
            ttlMs: 100,
            now: () => nowMs,
            read: () => {
                reads++
                if (reads === 1) return Promise.resolve<Settings | null>({ listenPort: 1 })
                revalidation = deferred<Settings | null>()
                return revalidation.promise
            }
        })
        const file = '/tmp/x/settings.json'
        await cache.read(file)
        nowMs += 101
        const stale = cache.read(file) // kicks the revalidation (stale inode)
        expect(await stale).toEqual({ listenPort: 1 })
        // A write lands while that read is still in flight.
        cache.refreshAfterWrite(file, { listenPort: 42 })
        revalidation!.resolve({ listenPort: 1 }) // old inode content
        await settle()
        nowMs += 1
        expect(await cache.read(file)).toEqual({ listenPort: 42 }) // not stomped
    })
})

describe('settings read cache (real files)', () => {
    it('updateSettings write-through is visible to cached readers immediately', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-src-'))
        directories.push(dataDir)
        const settingsFile = getSettingsFile(dataDir)

        await updateSettings(settingsFile, () => ({
            settings: { listenPort: 1234 },
            result: true
        }))
        // Write-through: no TTL wait needed.
        expect((await readSettingsOrThrowCached(settingsFile)).listenPort).toBe(1234)

        // Prove the value came from memory: stomp the file behind the cache.
        await writeFile(settingsFile, JSON.stringify({ listenPort: 9999 }), 'utf8')
        expect((await readSettingsOrThrowCached(settingsFile)).listenPort).toBe(1234)

        // After a reset (equivalent to TTL expiry) the disk truth is served.
        __resetSettingsReadCacheForTests()
        expect((await readSettingsOrThrowCached(settingsFile)).listenPort).toBe(9999)
    })
})
