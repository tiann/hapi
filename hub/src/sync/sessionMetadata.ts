export function mergeSessionMetadata(oldMetadata: unknown | null, newMetadata: unknown | null): unknown | null {
    if (!oldMetadata || typeof oldMetadata !== 'object') {
        return newMetadata
    }
    if (!newMetadata || typeof newMetadata !== 'object') {
        return oldMetadata
    }

    const oldObj = oldMetadata as Record<string, unknown>
    const newObj = newMetadata as Record<string, unknown>
    const merged: Record<string, unknown> = { ...newObj }
    let changed = false

    if (typeof oldObj.name === 'string' && typeof newObj.name !== 'string') {
        merged.name = oldObj.name
        changed = true
    }

    const oldSummary = oldObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
    const newSummary = newObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
    const oldUpdatedAt = typeof oldSummary?.updatedAt === 'number' ? oldSummary.updatedAt : null
    const newUpdatedAt = typeof newSummary?.updatedAt === 'number' ? newSummary.updatedAt : null
    if (oldUpdatedAt !== null && (newUpdatedAt === null || oldUpdatedAt > newUpdatedAt)) {
        merged.summary = oldSummary
        changed = true
    }

    if (oldObj.worktree && !newObj.worktree) {
        merged.worktree = oldObj.worktree
        changed = true
    }

    if (typeof oldObj.path === 'string' && typeof newObj.path !== 'string') {
        merged.path = oldObj.path
        changed = true
    }
    if (typeof oldObj.host === 'string' && typeof newObj.host !== 'string') {
        merged.host = oldObj.host
        changed = true
    }

    return changed ? merged : newMetadata
}
