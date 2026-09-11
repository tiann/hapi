const HUB_OWNED_METADATA_KEYS = ['supersededBySessionId', 'opencodeClearOperation', 'codexForkCleanup'] as const

/** CLI metadata may echo an existing Hub owner, but cannot create or replace one. */
export function preserveHubOwnedMetadata(incoming: unknown, current?: unknown): unknown {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
    const next = { ...(incoming as Record<string, unknown>) }
    const existing = current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}
    for (const key of HUB_OWNED_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key]
        else delete next[key]
    }
    return next
}
