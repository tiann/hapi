/** List ordering follows user intent, not agent output or connection state. */
type SessionOrderFields = {
    id: string
    createdAt?: number
    lastUserMessageAt?: number
}

export function getSessionOrderKey(session: SessionOrderFields): number {
    return session.lastUserMessageAt ?? session.createdAt ?? 0
}

export function compareSessionsByOrderKeyDesc(a: SessionOrderFields, b: SessionOrderFields): number {
    return getSessionOrderKey(b) - getSessionOrderKey(a)
        || (b.createdAt ?? 0) - (a.createdAt ?? 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function compareSessionSummaries(
    a: SessionOrderFields & { pinned?: boolean; globalPinned?: boolean },
    b: SessionOrderFields & { pinned?: boolean; globalPinned?: boolean }
): number {
    if (Boolean(a.globalPinned) !== Boolean(b.globalPinned)) return a.globalPinned ? -1 : 1
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return compareSessionsByOrderKeyDesc(a, b)
}

export function compareDescWithKeyTiebreak(
    a: { key: string; order: number },
    b: { key: string; order: number }
): number {
    return b.order - a.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}
