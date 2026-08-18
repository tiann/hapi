export type TerminalRegistryEntry = {
    terminalId: string
    sessionId: string
    viewerSocketIds: Set<string>
    cliSocketId: string
    createdAt: number
    idleTimer: ReturnType<typeof setTimeout> | null
}

type TerminalRegistryOptions = {
    idleTimeoutMs: number
    onIdle?: (entry: TerminalRegistryEntry) => void
    // Fired whenever an entry is genuinely removed (close / idle / CLI gone),
    // but NOT when a browser detaches or re-attaches, so per-terminal resources
    // (e.g. the scrollback buffer) survive navigation and transport reconnects.
    onRemove?: (entry: TerminalRegistryEntry) => void
}

export class TerminalRegistry {
    private readonly terminals = new Map<string, TerminalRegistryEntry>()
    private readonly terminalsBySocket = new Map<string, Set<string>>()
    private readonly terminalsBySession = new Map<string, Set<string>>()
    private readonly terminalsByCliSocket = new Map<string, Set<string>>()
    private readonly sessionSubscribers = new Map<string, Set<string>>()
    private readonly sessionsBySocket = new Map<string, Set<string>>()
    private readonly idleTimeoutMs: number
    private readonly onIdle?: (entry: TerminalRegistryEntry) => void
    private readonly onRemove?: (entry: TerminalRegistryEntry) => void

    constructor(options: TerminalRegistryOptions) {
        this.idleTimeoutMs = options.idleTimeoutMs
        this.onIdle = options.onIdle
        this.onRemove = options.onRemove
    }

    register(terminalId: string, sessionId: string, socketId: string | null, cliSocketId: string): TerminalRegistryEntry | null {
        const existing = this.terminals.get(terminalId)
        if (existing) {
            if (existing.sessionId !== sessionId) {
                return null
            }
            // Backwards compatibility for older web clients that use
            // terminal:create for transport reconnects. A detached create does
            // not implicitly become a viewer; legacy attached creates still do.
            return socketId ? this.attach(terminalId, sessionId, socketId) : existing
        }

        // Initial empty-page bootstraps use a unique `-auto-<nonce>` resource ID.
        // The nonce keeps PTY identities unique across lifecycles, while this
        // synchronous registry gate makes simultaneous empty-page requests
        // create-if-empty: after the first request registers a PTY, later auto
        // requests for the same session are rejected and their clients refresh
        // the server inventory instead of opening duplicate shells.
        if (terminalId.startsWith(`term-${sessionId}-auto-`) && this.countForSession(sessionId) > 0) {
            return null
        }

        const entry: TerminalRegistryEntry = {
            terminalId,
            sessionId,
            viewerSocketIds: socketId ? new Set([socketId]) : new Set<string>(),
            cliSocketId,
            createdAt: Date.now(),
            idleTimer: null
        }

        this.terminals.set(terminalId, entry)
        if (socketId) {
            this.addToIndex(this.terminalsBySocket, socketId, terminalId)
        }
        this.addToIndex(this.terminalsBySession, sessionId, terminalId)
        this.addToIndex(this.terminalsByCliSocket, cliSocketId, terminalId)
        this.scheduleIdle(entry)

        return entry
    }

    attach(terminalId: string, sessionId: string, socketId: string): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry || entry.sessionId !== sessionId) {
            return null
        }

        if (entry.viewerSocketIds.has(socketId)) {
            return entry
        }

        entry.viewerSocketIds.add(socketId)
        this.addToIndex(this.terminalsBySocket, socketId, terminalId)
        return entry
    }

    detach(terminalId: string, socketId: string): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry || !entry.viewerSocketIds.has(socketId)) {
            return null
        }

        entry.viewerSocketIds.delete(socketId)
        this.removeFromIndex(this.terminalsBySocket, socketId, terminalId)
        return entry
    }

    isViewer(terminalId: string, socketId: string): boolean {
        return this.terminals.get(terminalId)?.viewerSocketIds.has(socketId) ?? false
    }

    subscribeSession(sessionId: string, socketId: string): void {
        this.addToIndex(this.sessionSubscribers, sessionId, socketId)
        this.addToIndex(this.sessionsBySocket, socketId, sessionId)
    }

    subscribersForSession(sessionId: string): string[] {
        return Array.from(this.sessionSubscribers.get(sessionId) ?? [])
    }

    markActivity(terminalId: string): void {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return
        }
        this.scheduleIdle(entry)
    }

    get(terminalId: string): TerminalRegistryEntry | null {
        return this.terminals.get(terminalId) ?? null
    }

    listForSession(sessionId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsBySession.get(sessionId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids)
            .map((terminalId) => this.terminals.get(terminalId))
            .filter((entry): entry is TerminalRegistryEntry => Boolean(entry))
            .sort((a, b) => a.createdAt - b.createdAt)
    }

    remove(terminalId: string, fireOnRemove = true): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return null
        }

        this.terminals.delete(terminalId)
        for (const socketId of entry.viewerSocketIds) {
            this.removeFromIndex(this.terminalsBySocket, socketId, terminalId)
        }
        this.removeFromIndex(this.terminalsBySession, entry.sessionId, terminalId)
        this.removeFromIndex(this.terminalsByCliSocket, entry.cliSocketId, terminalId)
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }
        if (fireOnRemove) {
            this.onRemove?.(entry)
        }

        return entry
    }

    detachBySocket(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsBySocket.get(socketId)
        const entries = ids
            ? Array.from(ids)
                .map((terminalId) => this.terminals.get(terminalId))
                .filter((entry): entry is TerminalRegistryEntry => Boolean(entry))
            : []

        for (const entry of entries) {
            entry.viewerSocketIds.delete(socketId)
        }
        this.terminalsBySocket.delete(socketId)

        const sessionIds = this.sessionsBySocket.get(socketId)
        if (sessionIds) {
            for (const sessionId of sessionIds) {
                this.removeFromIndex(this.sessionSubscribers, sessionId, socketId)
            }
        }
        this.sessionsBySocket.delete(socketId)

        return entries
    }

    removeByCliSocket(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsByCliSocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids).map((terminalId) => this.remove(terminalId)).filter(Boolean) as TerminalRegistryEntry[]
    }

    countForSocket(socketId: string): number {
        return this.terminalsBySocket.get(socketId)?.size ?? 0
    }

    countForSession(sessionId: string): number {
        return this.terminalsBySession.get(sessionId)?.size ?? 0
    }

    private scheduleIdle(entry: TerminalRegistryEntry): void {
        if (this.idleTimeoutMs <= 0) {
            return
        }

        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        entry.idleTimer = setTimeout(() => {
            const current = this.terminals.get(entry.terminalId)
            if (!current) {
                return
            }
            this.onIdle?.(current)
            this.remove(entry.terminalId)
        }, this.idleTimeoutMs)
    }

    private addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
        const set = index.get(key)
        if (set) {
            set.add(value)
        } else {
            index.set(key, new Set([value]))
        }
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string, value: string): void {
        const set = index.get(key)
        if (!set) {
            return
        }
        set.delete(value)
        if (set.size === 0) {
            index.delete(key)
        }
    }
}