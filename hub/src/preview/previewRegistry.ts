import {
    PREVIEW_DEFAULT_TTL_SECONDS,
    PREVIEW_HUB_TOTAL_MOUNTS,
    PREVIEW_MAX_MOUNTS_PER_SESSION,
    PREVIEW_TOMBSTONE_TTL_MS,
    buildPreviewUrl,
    isLoopbackTarget,
    type PreviewMountDescriptor,
    type PreviewRegisterAck
} from '@hapi/protocol/preview'

/**
 * Hub-side registry of preview mounts. The CLI owns mount truth and re-registers
 * on reconnect; this map is the lookup for browser requests against
 * `/preview/<mountId>/*` capability URLs (no hub auth — the unguessable
 * mountId plus optional per-mount token is the credential).
 */

export interface PreviewMountEntry {
    mountId: string
    socketId: string
    namespace: string | null
    sessionId: string | null
    kind: 'static' | 'proxy'
    name: string
    rootPath?: string
    port?: number
    url?: string
    ws: boolean
    token?: string
    createdAt: number
    expiresAt: number
    lastSeenAt: number
}

export interface RegisterContext {
    socketId: string
    namespace: string | null
    sessionId: string | null
    now?: number
}

export class PreviewRegistry {
    private readonly mounts = new Map<string, PreviewMountEntry>()
    private readonly bySocket = new Map<string, Set<string>>()
    private readonly tombstones = new Map<string, number>()
    private sweeper: ReturnType<typeof setInterval> | null = null

    /**
     * `publicUrl` is injected (only the hub knows HAPI_PUBLIC_URL) rather than
     * read from hub configuration so tests can run without booting it.
     */
    constructor(private readonly publicUrl: string) {}

    /** Lookup + touch. Returns null for unknown (caller decides 404 vs 410). */
    get(mountId: string, now = Date.now()): PreviewMountEntry | null {
        const entry = this.mounts.get(mountId)
        if (!entry) return null
        if (entry.expiresAt <= now) return null
        entry.lastSeenAt = now
        return entry
    }

    /** True when the mount existed recently and expired — respond 410 Gone. */
    isTombstoned(mountId: string, now = Date.now()): boolean {
        const at = this.tombstones.get(mountId)
        return at !== undefined && now - at < PREVIEW_TOMBSTONE_TTL_MS
    }

    checkToken(entry: PreviewMountEntry, queryToken: string | null): boolean {
        if (!entry.token) return true
        return typeof queryToken === 'string' && queryToken.length > 0 && queryToken === entry.token
    }

    register(descriptor: PreviewMountDescriptor, ctx: RegisterContext): PreviewRegisterAck {
        const now = ctx.now ?? Date.now()
        const validationError = this.validate(descriptor)
        if (validationError) {
            return { ok: false, error: validationError, code: 'invalid' }
        }

        const existing = this.mounts.get(descriptor.mountId)
        const isRebind = existing !== undefined && existing.socketId !== ctx.socketId
        if (existing === undefined) {
            const sessionKey = `${ctx.namespace ?? ''}:${ctx.sessionId ?? ''}`
            if (this.countForSession(sessionKey) >= PREVIEW_MAX_MOUNTS_PER_SESSION) {
                return { ok: false, error: 'mount limit reached for this session', code: 'cap' }
            }
            if (this.mounts.size >= PREVIEW_HUB_TOTAL_MOUNTS) {
                return { ok: false, error: 'hub-wide mount limit reached', code: 'cap' }
            }
        }

        // A re-register (same mountId) restores/rebinds the entry so URLs
        // survive hub restarts and CLI reconnects.
        const ttlSeconds = descriptor.ttlSeconds ?? PREVIEW_DEFAULT_TTL_SECONDS
        const entry: PreviewMountEntry = existing ?? {
            mountId: descriptor.mountId,
            socketId: ctx.socketId,
            namespace: ctx.namespace,
            sessionId: ctx.sessionId,
            kind: descriptor.kind,
            name: descriptor.name,
            rootPath: descriptor.rootPath,
            port: descriptor.port,
            url: descriptor.url,
            ws: descriptor.ws ?? true,
            token: descriptor.token,
            createdAt: now,
            expiresAt: 0,
            lastSeenAt: now
        }
        if (isRebind) {
            this.removeFromSocketIndex(existing!.mountId, existing!.socketId)
            entry.socketId = ctx.socketId
            entry.namespace = ctx.namespace
            entry.sessionId = ctx.sessionId
        }
        entry.kind = descriptor.kind
        entry.name = descriptor.name
        entry.rootPath = descriptor.rootPath
        entry.port = descriptor.port
        entry.url = descriptor.url
        entry.ws = descriptor.ws ?? true
        entry.token = descriptor.token
        entry.lastSeenAt = now
        entry.expiresAt = now + ttlSeconds * 1000
        this.mounts.set(entry.mountId, entry)
        this.tombstones.delete(entry.mountId)
        this.addToSocketIndex(entry.mountId, ctx.socketId)
        this.ensureSweeper()

        return {
            ok: true,
            url: buildPreviewUrl(this.publicUrl, entry.mountId),
            mountId: entry.mountId,
            expiresAt: entry.expiresAt
        }
    }

    unregister(selector: { mountId?: string; name?: string; all?: boolean }, ctx: RegisterContext): number {
        let targets: PreviewMountEntry[] = []
        if (selector.all) {
            for (const entry of this.mounts.values()) {
                if (entry.socketId === ctx.socketId) targets.push(entry)
            }
        } else if (selector.mountId) {
            const entry = this.mounts.get(selector.mountId)
            if (entry && entry.socketId === ctx.socketId) targets.push(entry)
        } else if (selector.name) {
            for (const entry of this.mounts.values()) {
                if (entry.socketId === ctx.socketId && entry.name === selector.name) targets.push(entry)
            }
        }
        for (const entry of targets) {
            this.remove(entry.mountId)
        }
        return targets.length
    }

    /** CLI socket gone: every mount behind it becomes unavailable. */
    evictSocket(socketId: string): number {
        const ids = this.bySocket.get(socketId)
        if (!ids) return 0
        let removed = 0
        for (const mountId of [...ids]) {
            if (this.remove(mountId)) removed += 1
        }
        return removed
    }

    get stats(): { mounts: number } {
        return { mounts: this.mounts.size }
    }

    stopSweeper(): void {
        if (this.sweeper) {
            clearInterval(this.sweeper)
            this.sweeper = null
        }
    }

    /** Expires mounts past their TTL; test hook sweeps on demand. */
    sweep(now = Date.now()): void {
        for (const entry of [...this.mounts.values()]) {
            if (entry.expiresAt <= now) this.remove(entry.mountId, now)
        }
        for (const [mountId, at] of [...this.tombstones]) {
            if (now - at >= PREVIEW_TOMBSTONE_TTL_MS) this.tombstones.delete(mountId)
        }
        if (this.mounts.size === 0) this.stopSweeper()
    }

    private remove(mountId: string, now = Date.now()): boolean {
        const entry = this.mounts.get(mountId)
        if (!entry) return false
        this.mounts.delete(mountId)
        this.removeFromSocketIndex(mountId, entry.socketId)
        this.tombstones.set(mountId, now)
        return true
    }

    private validate(descriptor: PreviewMountDescriptor): string | null {
        if (descriptor.kind === 'static') {
            if (!descriptor.rootPath) return 'static mounts require rootPath'
            return null
        }
        if (descriptor.port !== undefined) return null
        if (descriptor.url) {
            try {
                if (!isLoopbackTarget(new URL(descriptor.url))) {
                    return 'proxy targets must be loopback'
                }
            } catch {
                return 'invalid proxy url'
            }
            return null
        }
        return 'proxy mounts require port or url'
    }

    private countForSession(sessionKey: string): number {
        let count = 0
        for (const entry of this.mounts.values()) {
            if (`${entry.namespace ?? ''}:${entry.sessionId ?? ''}` === sessionKey) count += 1
        }
        return count
    }

    private addToSocketIndex(mountId: string, socketId: string): void {
        const set = this.bySocket.get(socketId)
        if (set) {
            set.add(mountId)
        } else {
            this.bySocket.set(socketId, new Set([mountId]))
        }
    }

    private removeFromSocketIndex(mountId: string, socketId: string): void {
        const set = this.bySocket.get(socketId)
        if (!set) return
        set.delete(mountId)
        if (set.size === 0) this.bySocket.delete(socketId)
    }

    private ensureSweeper(): void {
        if (this.sweeper) return
        this.sweeper = setInterval(() => this.sweep(), 60_000)
        this.sweeper.unref?.()
    }
}
