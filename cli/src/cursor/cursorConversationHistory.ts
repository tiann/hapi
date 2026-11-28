import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { getAgentLaunchCommand, resolveExecutable } from '@/agent/agentLaunchCommand'
import type { Metadata } from '@/api/types'
import type { CursorSession } from './session'

type HistoryStore = typeof import('./cursorHistoryStore')
const testedBuild = '2026.11.22-e9042b2'

// Stock Cursor installations resolve "agent" to a versioned launcher. Avoid
// spawning a second CLI command against a running ACP session to query it.
export function hasVerifiedCursorBuild(): boolean {
    const agent = resolveExecutable(getAgentLaunchCommand('cursor'))
    try {
        return !!agent && realpathSync(agent).endsWith(sep + join('cursor-agent', 'versions', testedBuild, 'cursor-agent'))
    } catch {
        return false
    }
}

export async function loadCursorHistoryStore(): Promise<HistoryStore | null> {
    if (!process.versions.bun || !hasVerifiedCursorBuild()) return null
    return import('./cursorHistoryStore')
}

/** Points belong to this ACP launch. Never infer native boundaries from HAPI text or ordinals. */
export class CursorConversationHistory {
    private readonly points = new Map<string, string>()
    private materialized = false

    constructor(private readonly session: CursorSession, private readonly store: HistoryStore | null) {}

    root(id: string): string | undefined {
        try {
            if (this.store && hasVerifiedCursorBuild()) return this.store.readCursorHistoryRoot(homedir(), this.session.path, id)
        } catch {
            // Fresh ACP sessions do not always materialize a store before the first prompt.
        }
        return undefined
    }

    refresh(id: string): void {
        const materialized = this.root(id) !== undefined
        if (materialized !== this.materialized) {
            this.materialized = materialized
            this.publish()
        }
    }

    confirm(sessionId: string, localId: string, before: string, prompt: string): void {
        if (!this.store) return
        let root: string
        try {
            root = this.store.confirmCursorHistoryTurn(homedir(), this.session.path, sessionId, before, prompt)
        } catch {
            return
        }
        this.points.set(localId, root)
        this.materialized = true
        this.publish()
    }

    disable(): void {
        if (!this.materialized) return
        this.materialized = false
        this.reset()
    }

    reset(): void {
        this.points.clear()
        this.publish()
    }

    private publish(): void {
        const enabled = this.materialized
        const points = Object.fromEntries([...this.points.keys()].map(id => [id, true as const]))
        this.session.client.updateMetadata((metadata: Metadata) => ({
            ...metadata,
            capabilities: {
                ...metadata.capabilities,
                conversationHistory: { forkCurrent: enabled, forkAtMessage: enabled, rewindToMessage: enabled }
            },
            conversationHistoryPoints: points
        }))
    }

    fork(id: string, localId?: string): string {
        if (!this.store || !hasVerifiedCursorBuild()) throw new Error('Unsupported Cursor history build')
        const root = localId === undefined ? undefined : this.points.get(localId)
        if (localId !== undefined && root === undefined) throw new Error('No verified Cursor history point for this message')
        return this.store.forkCursorHistoryStore(homedir(), this.session.path, id, root)
    }
}
