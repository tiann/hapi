export type TerminalRegistryEntry = {
    terminalId: string
    sessionId: string
    socketId: string
    cliSocketId: string
    idleTimer: ReturnType<typeof setTimeout> | null
}

type TerminalRegistryOptions = {
    idleTimeoutMs: number
    onIdle?: (entry: TerminalRegistryEntry) => void
}

export class TerminalRegistry {
    private readonly terminals = new Map<string, TerminalRegistryEntry>()
    private readonly terminalsBySocket = new Map<string, Set<string>>()
    private readonly terminalsBySession = new Map<string, Set<string>>()
    private readonly terminalsByCliSocket = new Map<string, Set<string>>()
    private readonly idleTimeoutMs: number
    private readonly onIdle?: (entry: TerminalRegistryEntry) => void

    constructor(options: TerminalRegistryOptions) {
        this.idleTimeoutMs = options.idleTimeoutMs
        this.onIdle = options.onIdle
    }

    register(terminalId: string, sessionId: string, socketId: string, cliSocketId: string): TerminalRegistryEntry | null {
        if (this.terminals.has(terminalId)) {
            return null
        }

        const entry: TerminalRegistryEntry = {
            terminalId,
            sessionId,
            socketId,
            cliSocketId,
            idleTimer: null
        }

        this.terminals.set(terminalId, entry)
        this.addToIndex(this.terminalsBySocket, socketId, terminalId)
        this.addToIndex(this.terminalsBySession, sessionId, terminalId)
        this.addToIndex(this.terminalsByCliSocket, cliSocketId, terminalId)
        this.scheduleIdle(entry)

        return entry
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

    remove(terminalId: string): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return null
        }

        this.terminals.delete(terminalId)
        this.removeFromIndex(this.terminalsBySocket, entry.socketId, terminalId)
        this.removeFromIndex(this.terminalsBySession, entry.sessionId, terminalId)
        this.removeFromIndex(this.terminalsByCliSocket, entry.cliSocketId, terminalId)
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        return entry
    }

    removeBySocket(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsBySocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids).map((terminalId) => this.remove(terminalId)).filter(Boolean) as TerminalRegistryEntry[]
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

    private addToIndex(index: Map<string, Set<string>>, key: string, terminalId: string): void {
        const set = index.get(key)
        if (set) {
            set.add(terminalId)
        } else {
            index.set(key, new Set([terminalId]))
        }
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string, terminalId: string): void {
        const set = index.get(key)
        if (!set) {
            return
        }
        set.delete(terminalId)
        if (set.size === 0) {
            index.delete(key)
        }
    }
}
