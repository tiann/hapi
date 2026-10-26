import { describe, expect, it } from 'bun:test'
import { SessionEnumerationCache } from './sessionEnumerationCache'

interface Harness {
    cache: SessionEnumerationCache
    clock: { now: number }
    fetches: Array<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper must accept any deferred payload type
        resolve: (value?: any) => void
        reject: (reason?: unknown) => void
    }>
}

function createHarness(ttlMs = 30_000, fetchTimeoutMs = 8_000): Harness {
    const clock = { now: 1_000 }
    const fetches: Harness['fetches'] = []
    const cache = new SessionEnumerationCache({
        ttlMs,
        fetchTimeoutMs,
        now: () => clock.now
    })
    return { cache, clock, fetches }
}

/** A fetch that stays pending until the test resolves it. */
function deferredFetch<T>(harness: Harness, value?: T): () => Promise<T> {
    return () =>
        new Promise((resolve, reject) => {
            harness.fetches.push({ resolve: (v?: T) => resolve((v ?? value) as T), reject })
        })
}

function immediateFetch<T>(harness: Harness, impl: () => T): () => Promise<T> {
    return () => {
        harness.fetches.push({ resolve: () => {}, reject: () => {} })
        return Promise.resolve().then(impl)
    }
}

const okCommands = (n: number) => ({ success: true, commands: [{ name: `cmd-${n}` }] })
const isCacheable = (value: { success: boolean; commands?: unknown[] }) =>
    value.success === true && Array.isArray(value.commands)

describe('SessionEnumerationCache', () => {
    it('shares one in-flight fetch across concurrent cold callers (single-flight)', async () => {
        const h = createHarness()
        const first = h.cache.get('s1|claude', deferredFetch(h, okCommands(1)), isCacheable)
        const second = h.cache.get('s1|claude', deferredFetch(h, okCommands(2)), isCacheable)

        h.fetches[0].resolve()
        const [a, b] = await Promise.all([first, second])

        expect(h.fetches.length).toBe(1)
        expect(a).toEqual(okCommands(1))
        expect(b).toEqual(okCommands(1))
    })

    it('serves a fresh value without any RPC inside the ttl', async () => {
        const h = createHarness()
        const first = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(1)), isCacheable)
        h.clock.now += 29_999
        const second = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(2)), isCacheable)

        expect(first).toEqual(okCommands(1))
        expect(second).toEqual(okCommands(1))
        expect(h.fetches.length).toBe(1)
    })

    it('serves stale immediately while revalidating in background (stale-while-revalidate)', async () => {
        const h = createHarness()
        await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(1)), isCacheable)
        h.clock.now += 31_000

        const stalePromise = h.cache.get('s1|claude', deferredFetch(h, okCommands(2)), isCacheable)
        // Stale value must resolve without waiting for the revalidation RPC.
        expect(await Promise.race([
            stalePromise.then(() => 'resolved'),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
        ])).toBe('resolved')
        expect(await stalePromise).toEqual(okCommands(1))

        h.fetches[1].resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        h.clock.now += 1_000
        const refreshed = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(3)), isCacheable)
        expect(refreshed).toEqual(okCommands(2))
    })

    it('keeps serving the last good value when a revalidation fails', async () => {
        const h = createHarness()
        await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(1)), isCacheable)
        h.clock.now += 31_000

        const failing = () => {
            h.fetches.push({ resolve: () => {}, reject: () => {} })
            return Promise.reject(new Error('engine offline'))
        }
        const stalePromise = h.cache.get('s1|claude', failing, isCacheable)
        expect(await stalePromise).toEqual(okCommands(1))
        // Let the background rejection settle without an unhandled rejection.
        await new Promise((resolve) => setTimeout(resolve, 0))
    })

    it('caps a cold fetch at fetchTimeoutMs while the fetch keeps running', async () => {
        const h = createHarness(30_000, 10)
        const cold = h.cache.get('s1|claude', deferredFetch(h, okCommands(1)), isCacheable)

        await expect(cold).rejects.toThrow('Enumeration RPC timed out')

        // The late success still populates the cache for the next caller.
        h.fetches[0].resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        const warm = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(2)), isCacheable)
        expect(warm).toEqual(okCommands(1))
    })

    it('propagates a cold fetch failure to the caller', async () => {
        const h = createHarness()
        const failing = () => {
            h.fetches.push({ resolve: () => {}, reject: () => {} })
            return Promise.reject(new Error('engine offline'))
        }
        await expect(h.cache.get('s1|claude', failing, isCacheable)).rejects.toThrow('engine offline')
    })

    it('does not cache results rejected by isCacheable', async () => {
        const h = createHarness()
        const failing = () => {
            h.fetches.push({ resolve: () => {}, reject: () => {} })
            return Promise.resolve({ success: false, error: 'catalog unavailable' })
        }
        const first = await h.cache.get('s1|claude', failing, isCacheable)
        expect(first).toEqual({ success: false, error: 'catalog unavailable' })

        h.clock.now += 1_000
        const second = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(1)), isCacheable)
        expect(second).toEqual(okCommands(1))
        expect(h.fetches.length).toBe(2)
    })

    it('caches per key: different agents do not share entries', async () => {
        const h = createHarness()
        const claude = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(1)), isCacheable)
        const codex = await h.cache.get('s1|codex', immediateFetch(h, () => okCommands(2)), isCacheable)
        expect(claude).toEqual(okCommands(1))
        expect(codex).toEqual(okCommands(2))
    })

    it('releaseSession() drops the session composite keys but not other sessions', async () => {
        const h = createHarness()
        await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(1)), isCacheable)
        await h.cache.get('s1|codex', immediateFetch(h, () => okCommands(2)), isCacheable)
        await h.cache.get('s2|claude', immediateFetch(h, () => okCommands(3)), isCacheable)

        h.cache.releaseSession('s1')
        // No TTL game needed — the entries are gone, so even an immediate
        // get() inside the freshness window must hit the RPC again — while
        // the other session's entry survives.
        const claudeAgain = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(4)), isCacheable)
        const codexAgain = await h.cache.get('s1|codex', immediateFetch(h, () => okCommands(5)), isCacheable)
        const otherSession = await h.cache.get('s2|claude', immediateFetch(h, () => okCommands(6)), isCacheable)

        expect(claudeAgain).toEqual(okCommands(4))
        expect(codexAgain).toEqual(okCommands(5))
        expect(otherSession).toEqual(okCommands(3))
        expect(h.fetches.length).toBe(5)
    })

    it('releaseSession() during an in-flight fetch does not resurrect the entry', async () => {
        const h = createHarness()
        const first = h.cache.get('s1|claude', deferredFetch(h, okCommands(1)), isCacheable)

        h.cache.releaseSession('s1')
        h.fetches[0].resolve()
        expect(await first).toEqual(okCommands(1))

        // The late success landed on the detached entry: a subsequent get()
        // starts cold instead of being served the released value.
        const second = await h.cache.get('s1|claude', immediateFetch(h, () => okCommands(2)), isCacheable)
        expect(second).toEqual(okCommands(2))
        expect(h.fetches.length).toBe(2)
    })
})
