/**
 * In-memory token-bucket rate limiter.
 *
 * One limiter instance covers one dimension (per-device-token or per-IP);
 * each distinct key gets its own bucket. Buckets refill continuously
 * (`refillPerMinute` tokens per minute, capped at `capacity`), so a key that
 * burns its burst recovers gradually instead of all at once.
 *
 * Memory safety: keys are attacker-influenced (random device tokens, many
 * IPs), so the map is bounded by `maxKeys`. When a new key would exceed the
 * bound we first drop buckets that have fully refilled (idle keys), then
 * evict the least-recently-used buckets. Eviction resets that key's budget -
 * acceptable here because a flood of fabricated token keys is still bounded
 * by the flooder's own per-IP bucket.
 *
 * State is process-local by design: the relay is a single small process and
 * these limits are abuse mitigation, not accounting.
 */

export type TokenBucketOptions = {
    /** Maximum burst (also the starting budget for a fresh key). */
    capacity: number
    /** Continuous refill rate, in tokens per minute. */
    refillPerMinute: number
    /** Injectable clock (milliseconds) for tests. Defaults to Date.now. */
    now?: () => number
    /** Upper bound on tracked keys before pruning kicks in. */
    maxKeys?: number
}

type Bucket = {
    tokens: number
    lastRefillMs: number
}

const DEFAULT_MAX_KEYS = 50_000

export class TokenBucketLimiter {
    private readonly buckets = new Map<string, Bucket>()
    private readonly capacity: number
    private readonly refillPerMs: number
    private readonly now: () => number
    private readonly maxKeys: number

    constructor(options: TokenBucketOptions) {
        if (!(options.capacity > 0)) {
            throw new Error('TokenBucketLimiter capacity must be > 0')
        }
        if (!(options.refillPerMinute > 0)) {
            throw new Error('TokenBucketLimiter refillPerMinute must be > 0')
        }
        this.capacity = options.capacity
        this.refillPerMs = options.refillPerMinute / 60_000
        this.now = options.now ?? Date.now
        this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
    }

    /** Take one token for `key`. Returns false when the key is out of budget. */
    tryTake(key: string): boolean {
        const nowMs = this.now()
        let bucket = this.buckets.get(key)
        if (bucket === undefined) {
            this.pruneIfNeeded(nowMs)
            bucket = { tokens: this.capacity, lastRefillMs: nowMs }
            this.buckets.set(key, bucket)
        } else {
            const elapsed = Math.max(0, nowMs - bucket.lastRefillMs)
            bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs)
            bucket.lastRefillMs = nowMs
            // Move to the back of the Map so insertion order doubles as an
            // LRU order for eviction.
            this.buckets.delete(key)
            this.buckets.set(key, bucket)
        }
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1
            return true
        }
        return false
    }

    /** Number of tracked keys (exposed for tests and monitoring). */
    get size(): number {
        return this.buckets.size
    }

    private pruneIfNeeded(nowMs: number): void {
        if (this.buckets.size < this.maxKeys) {
            return
        }
        // Pass 1: drop buckets that have fully refilled - they carry no
        // rate-limiting state anymore.
        for (const [key, bucket] of this.buckets) {
            const elapsed = Math.max(0, nowMs - bucket.lastRefillMs)
            const refilled = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs)
            if (refilled >= this.capacity) {
                this.buckets.delete(key)
            }
        }
        // Pass 2: still at the bound - evict least-recently-used keys.
        while (this.buckets.size >= this.maxKeys) {
            const oldest = this.buckets.keys().next()
            if (oldest.done === true) {
                break
            }
            this.buckets.delete(oldest.value)
        }
    }
}
