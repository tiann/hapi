import { platform } from 'node:os'
import type { Store } from '../store'

/**
 * Metadata helpers for Cursor local-session import (attach after ACP prepare).
 * Discovery + verify/transplant live on the runner; the hub only stamps rows.
 */

export function buildAlreadyImportedCursorIndex(store: Store, namespace: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = session.metadata as Record<string, unknown> | null
        if (!metadata || metadata.flavor !== 'cursor') continue
        const csid = metadata.cursorSessionId
        if (typeof csid === 'string' && csid.length > 0) {
            map.set(csid, session.id)
        }
    }
    return map
}

export function buildImportedCursorSessionMetadata(args: {
    uuid: string
    workspacePath: string | null
    title: string
    hostName: string
    homeDir: string
    machineId?: string | null
}): Record<string, unknown> {
    const now = Date.now()
    return {
        path: args.workspacePath ?? '',
        host: args.hostName,
        homeDir: args.homeDir,
        os: platform(),
        name: args.title,
        summary: { text: args.title, updatedAt: now },
        flavor: 'cursor',
        cursorSessionId: args.uuid,
        // Strict ACP-only: prepare/verify must have passed before this is called.
        cursorSessionProtocol: 'acp',
        lifecycleState: 'imported',
        lifecycleStateSince: now,
        ...(args.machineId ? { machineId: args.machineId } : {})
    }
}
