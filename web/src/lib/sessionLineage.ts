import type { SessionSummary } from '@/types/api'
import { hasUrgentModelError } from '@/components/ModelErrorBanner'
import { hasAgentForegroundWork, hasRunningAttachedJob } from '@/lib/sessionInProgress'

const MAX_ANCESTOR_HOPS = 16

export type SessionLineageDescendant = {
    session: SessionSummary
    parentId: string
    depth: number
}

export type SessionLineageForest = {
    roots: SessionSummary[]
    childrenByParentId: Map<string, SessionSummary[]>
    descendantsByRootId: Map<string, SessionLineageDescendant[]>
    effectiveParentByChildId: Map<string, string>
}

export type ChildAttentionContext = {
    selectedSessionId?: string | null
    keepUnreadSessionsVisible?: boolean
    isUnread?: (session: SessionSummary) => boolean
}

export function childIsWorking(session: SessionSummary): boolean {
    return hasAgentForegroundWork(session) || hasRunningAttachedJob(session) || session.derivedToolWork === true
}

export function childDemandsAttention(
    session: SessionSummary,
    ctx: ChildAttentionContext
): boolean {
    if (session.id === ctx.selectedSessionId) return true
    if (session.active && (session.pendingRequestsCount ?? 0) > 0) return true
    if (hasUrgentModelError(session.metadata)) return true
    if (ctx.keepUnreadSessionsVisible && ctx.isUnread?.(session)) return true
    return false
}

export function isChildLineageExpandedByDefault(
    children: readonly SessionSummary[],
    ctx: ChildAttentionContext
): boolean {
    return children.some((child) => childIsWorking(child) || childDemandsAttention(child, ctx))
}

function findNearestVisibleAncestorId(
    session: SessionSummary,
    visibleIndexById: ReadonlyMap<string, number>,
    lookupById: ReadonlyMap<string, SessionSummary>
): string | null {
    if (session.pinned) return null
    const visited = new Set<string>([session.id])
    let cursor: SessionSummary | undefined = session
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
        const parentId = cursor?.metadata?.parentLink?.parentSessionId
        if (!parentId || visited.has(parentId)) return null
        if (visibleIndexById.has(parentId)) return parentId
        visited.add(parentId)
        cursor = lookupById.get(parentId)
        if (!cursor) return null
    }
    return null
}

/**
 * Partitions a list of sessions into a cycle-free lineage forest in O(N) time
 * while preserving the caller's incoming sort order at every level.
 */
export function buildSessionLineage(
    sessions: readonly SessionSummary[],
    allSessions?: readonly SessionSummary[]
): SessionLineageForest {
    const visibleIndexById = new Map<string, number>()
    const visibleById = new Map<string, SessionSummary>()
    for (let i = 0; i < sessions.length; i += 1) {
        const s = sessions[i]!
        visibleIndexById.set(s.id, i)
        visibleById.set(s.id, s)
    }

    let lookupById: ReadonlyMap<string, SessionSummary> = visibleById
    if (allSessions && allSessions.length > 0) {
        const combined = new Map<string, SessionSummary>(visibleById)
        for (const s of allSessions) {
            if (!combined.has(s.id)) combined.set(s.id, s)
        }
        lookupById = combined
    }

    const effectiveParentByChildId = new Map<string, string>()
    for (const s of sessions) {
        const parentId = findNearestVisibleAncestorId(s, visibleIndexById, lookupById)
        if (parentId !== null) {
            effectiveParentByChildId.set(s.id, parentId)
        }
    }

    // Break any cycle among visible sessions deterministically by promoting the
    // earliest-ordered member of each cycle to a root.
    const state = new Map<string, 'visiting' | 'done'>()
    for (const s of sessions) {
        if (state.get(s.id) === 'done') continue
        const path: string[] = []
        const pathIndex = new Map<string, number>()
        let curr: string | undefined = s.id

        while (curr !== undefined) {
            if (state.get(curr) === 'done') break
            const cycleStart = pathIndex.get(curr)
            if (cycleStart !== undefined) {
                let minNode = path[cycleStart]!
                let minOrder = visibleIndexById.get(minNode) ?? Number.MAX_SAFE_INTEGER
                for (let k = cycleStart + 1; k < path.length; k += 1) {
                    const node = path[k]!
                    const order = visibleIndexById.get(node) ?? Number.MAX_SAFE_INTEGER
                    if (order < minOrder) {
                        minOrder = order
                        minNode = node
                    }
                }
                effectiveParentByChildId.delete(minNode)
                break
            }
            pathIndex.set(curr, path.length)
            path.push(curr)
            state.set(curr, 'visiting')
            curr = effectiveParentByChildId.get(curr)
        }

        for (const id of path) {
            state.set(id, 'done')
        }
    }

    const roots: SessionSummary[] = []
    const childrenByParentId = new Map<string, SessionSummary[]>()

    for (const s of sessions) {
        const parentId = effectiveParentByChildId.get(s.id)
        if (parentId === undefined) {
            roots.push(s)
        } else {
            const list = childrenByParentId.get(parentId)
            if (list) list.push(s)
            else childrenByParentId.set(parentId, [s])
        }
    }

    const descendantsByRootId = new Map<string, SessionLineageDescendant[]>()
    for (const root of roots) {
        const direct = childrenByParentId.get(root.id)
        if (!direct || direct.length === 0) continue

        const flattened: SessionLineageDescendant[] = []
        const stack: Array<{ session: SessionSummary; parentId: string; depth: number }> = []
        for (let i = direct.length - 1; i >= 0; i -= 1) {
            stack.push({ session: direct[i]!, parentId: root.id, depth: 1 })
        }

        while (stack.length > 0) {
            const item = stack.pop()!
            flattened.push(item)
            const nested = childrenByParentId.get(item.session.id)
            if (nested && nested.length > 0) {
                for (let i = nested.length - 1; i >= 0; i -= 1) {
                    stack.push({
                        session: nested[i]!,
                        parentId: item.session.id,
                        depth: item.depth + 1
                    })
                }
            }
        }

        descendantsByRootId.set(root.id, flattened)
    }

    return {
        roots,
        childrenByParentId,
        descendantsByRootId,
        effectiveParentByChildId
    }
}
