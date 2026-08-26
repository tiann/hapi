export function reconcileAttachmentOrder(
    previous: readonly string[],
    current: readonly string[],
): string[] {
    const currentIds = new Set(current)
    const next: string[] = []
    const seen = new Set<string>()

    for (const id of previous) {
        if (!currentIds.has(id) || seen.has(id)) continue
        next.push(id)
        seen.add(id)
    }

    for (const id of current) {
        if (seen.has(id)) continue
        next.push(id)
        seen.add(id)
    }

    return next
}

export type AttachmentDropPosition = 'before' | 'after'

export function moveAttachmentId(
    order: readonly string[],
    activeId: string,
    targetId: string,
    position: AttachmentDropPosition = 'before',
): string[] {
    if (activeId === targetId) return [...order]

    const next = [...order]
    const activeIndex = next.indexOf(activeId)
    if (activeIndex < 0 || next.indexOf(targetId) < 0) return next

    const [active] = next.splice(activeIndex, 1)
    const insertionIndex = next.indexOf(targetId)
    next.splice(insertionIndex + (position === 'after' ? 1 : 0), 0, active!)
    return next
}

export function orderItemsById<T extends { id: string }>(
    items: readonly T[],
    order: readonly string[],
): T[] {
    const byId = new Map(items.map((item) => [item.id, item]))
    const seen = new Set<string>()
    const ordered: T[] = []

    for (const id of order) {
        const item = byId.get(id)
        if (!item || seen.has(id)) continue
        ordered.push(item)
        seen.add(id)
    }

    for (const item of items) {
        if (seen.has(item.id)) continue
        ordered.push(item)
        seen.add(item.id)
    }

    return ordered
}
