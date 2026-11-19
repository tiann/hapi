import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    buildSessionLineage,
    buildSessionLookup,
    childDemandsAttention,
    childIsWorking,
    isChildLineageExpandedByDefault
} from './sessionLineage'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/work/proj' },
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

function link(parentSessionId: string, kind: 'peer' | 'fork' | 'branch' = 'peer') {
    return { path: '/work/proj', parentLink: { parentSessionId, kind } }
}

describe('buildSessionLineage', () => {
    it('groups peers, forks, and branches under their nearest visible ancestor while keeping sort order', () => {
        const root = makeSession({ id: 'root', updatedAt: 400 })
        const childA = makeSession({ id: 'child-a', updatedAt: 350, metadata: link('root', 'peer') })
        const grandchild = makeSession({ id: 'grandchild', updatedAt: 320, metadata: link('child-a', 'fork') })
        const childB = makeSession({ id: 'child-b', updatedAt: 300, metadata: link('root', 'branch') })
        const orphan = makeSession({ id: 'orphan', updatedAt: 200, metadata: link('missing-parent', 'peer') })

        const forest = buildSessionLineage([root, childA, grandchild, childB, orphan])
        expect(forest.roots.map((s) => s.id)).toEqual(['root', 'orphan'])
        expect(forest.childrenByParentId.get('root')?.map((s) => s.id)).toEqual(['child-a', 'child-b'])
        expect(forest.descendantsByRootId.get('root')?.map((d) => ({
            id: d.session.id,
            parentId: d.parentId,
            depth: d.depth
        }))).toEqual([
            { id: 'child-a', parentId: 'root', depth: 1 },
            { id: 'grandchild', parentId: 'child-a', depth: 2 },
            { id: 'child-b', parentId: 'root', depth: 1 }
        ])
    })

    it('bridges filtered-out intermediates when allSessions is provided', () => {
        const root = makeSession({ id: 'root' })
        const archivedMiddle = makeSession({ id: 'mid', metadata: link('root', 'peer') })
        const activeLeaf = makeSession({ id: 'leaf', metadata: link('mid', 'peer') })

        const forest = buildSessionLineage([root, activeLeaf], [root, archivedMiddle, activeLeaf])
        expect(forest.roots.map((s) => s.id)).toEqual(['root'])
        expect(forest.effectiveParentByChildId.get('leaf')).toBe('root')
        expect(forest.descendantsByRootId.get('root')?.map((d) => d.session.id)).toEqual(['leaf'])
    })

    it('reuses a shared session lookup map across groups without iterating it', () => {
        const root = makeSession({ id: 'root' })
        const archivedMiddle = makeSession({ id: 'mid', metadata: link('root', 'peer') })
        const activeLeaf = makeSession({ id: 'leaf', metadata: link('mid', 'peer') })
        const standaloneA = makeSession({ id: 'standalone-a' })
        const standaloneB = makeSession({ id: 'standalone-b' })

        const lookup = buildSessionLookup([root, archivedMiddle, activeLeaf, standaloneA, standaloneB])
        const getSpy = vi.spyOn(lookup, 'get')
        const iterSpy = vi.spyOn(lookup as Map<string, SessionSummary>, Symbol.iterator)

        const unlinkedForest = buildSessionLineage([standaloneA, standaloneB], lookup)
        expect(unlinkedForest.roots.map((s) => s.id)).toEqual(['standalone-a', 'standalone-b'])
        expect(getSpy).not.toHaveBeenCalled()
        expect(iterSpy).not.toHaveBeenCalled()

        const linkedForest = buildSessionLineage([root, activeLeaf], lookup)
        expect(linkedForest.roots.map((s) => s.id)).toEqual(['root'])
        expect(linkedForest.effectiveParentByChildId.get('leaf')).toBe('root')
        expect(linkedForest.descendantsByRootId.get('root')?.map((d) => d.session.id)).toEqual(['leaf'])
        expect(iterSpy).not.toHaveBeenCalled()
        expect(getSpy).toHaveBeenCalledTimes(1)
        expect(getSpy).toHaveBeenCalledWith('mid')
    })

    it('breaks cycles deterministically without losing any session', () => {
        const a = makeSession({ id: 'a', metadata: link('b') })
        const b = makeSession({ id: 'b', metadata: link('a') })
        const c = makeSession({ id: 'c', metadata: link('b') })
        const self = makeSession({ id: 'self', metadata: link('self') })

        const forest = buildSessionLineage([a, b, c, self])
        expect(forest.roots.map((s) => s.id)).toEqual(['a', 'self'])
        expect(forest.descendantsByRootId.get('a')?.map((d) => d.session.id)).toEqual(['b', 'c'])
        const total = forest.roots.length
            + Array.from(forest.descendantsByRootId.values()).reduce((sum, list) => sum + list.length, 0)
        expect(total).toBe(4)
    })

    it('keeps project-pinned children as independent roots instead of folding under an unpinned parent', () => {
        const pinnedChild = makeSession({ id: 'pinned-child', pinned: true, metadata: link('parent') })
        const parent = makeSession({ id: 'parent', metadata: { path: '/work/proj' } })
        const unpinnedChild = makeSession({ id: 'unpinned-child', metadata: link('parent') })

        const forest = buildSessionLineage([pinnedChild, parent, unpinnedChild])
        expect(forest.roots.map((s) => s.id)).toEqual(['pinned-child', 'parent'])
        expect(forest.childrenByParentId.get('parent')?.map((s) => s.id)).toEqual(['unpinned-child'])
    })
})

describe('attention auto-folding predicates', () => {
    it('counts a child with only derived tool work as working and expands its lineage', () => {
        const child = makeSession({ id: 'child', active: true, derivedToolWork: true })

        expect(childIsWorking(child)).toBe(true)
        expect(isChildLineageExpandedByDefault([child], {})).toBe(true)
        expect(childIsWorking({ ...child, active: false })).toBe(true)
    })

    it('folds idle read settled children by default and expands when working or demanding attention', () => {
        const idleChild = makeSession({ id: 'c1', active: false })
        const workingChild = makeSession({ id: 'c2', active: true, thinking: true })
        const backgroundWorkingChild = makeSession({ id: 'c5', active: true, thinking: false, backgroundTaskCount: 1 })
        const pendingChild = makeSession({ id: 'c3', active: true, pendingRequestsCount: 1 })
        const unreadChild = makeSession({ id: 'c4', active: true, thinking: false })

        expect(childIsWorking(workingChild)).toBe(true)
        expect(childIsWorking(backgroundWorkingChild)).toBe(true)
        expect(childDemandsAttention(pendingChild, {})).toBe(true)
        expect(childDemandsAttention(unreadChild, {
            keepUnreadSessionsVisible: true,
            isUnread: (s) => s.id === 'c4'
        })).toBe(true)

        expect(isChildLineageExpandedByDefault([idleChild], {})).toBe(false)
        expect(isChildLineageExpandedByDefault([idleChild, workingChild], {})).toBe(true)
        expect(isChildLineageExpandedByDefault([idleChild, backgroundWorkingChild], {})).toBe(true)
        expect(isChildLineageExpandedByDefault([idleChild, pendingChild], {})).toBe(true)
        expect(isChildLineageExpandedByDefault([idleChild], { selectedSessionId: 'c1' })).toBe(true)
    })
})

describe('buildSessionLineage performance benchmark', () => {
    function buildSyntheticGraph(count: number): SessionSummary[] {
        const list: SessionSummary[] = []
        for (let i = 0; i < count; i += 1) {
            const hasParent = i % 5 !== 0
            const parentIdx = hasParent ? Math.max(0, i - 1 - (i % 4)) : -1
            list.push(makeSession({
                id: `s-${i}`,
                updatedAt: count - i,
                metadata: parentIdx >= 0 ? link(`s-${parentIdx}`, i % 3 === 0 ? 'fork' : 'peer') : { path: '/work/proj' }
            }))
        }
        return list
    }

    function measureMs(sessions: SessionSummary[], warmup = 50, runs = 200) {
        let lastRoots = 0
        for (let i = 0; i < warmup; i += 1) {
            lastRoots = buildSessionLineage(sessions).roots.length
        }
        const samples: number[] = []
        for (let i = 0; i < runs; i += 1) {
            const t0 = performance.now()
            const forest = buildSessionLineage(sessions)
            const t1 = performance.now()
            samples.push(t1 - t0)
            lastRoots = forest.roots.length
        }
        samples.sort((a, b) => a - b)
        const medianMs = samples[Math.floor(samples.length * 0.5)]!
        const p95Ms = samples[Math.floor(samples.length * 0.95)]!
        return { runs, medianMs, p95Ms, lastRoots }
    }

    it('processes 500 and 5000 sessions in linear O(N) time far under frame budget', () => {
        const g500 = buildSyntheticGraph(500)
        const g5000 = buildSyntheticGraph(5000)

        const r500 = measureMs(g500)
        const r5000 = measureMs(g5000)

        console.info(
            `[sessionLineage-bench] N=500 runs=${r500.runs} median=${r500.medianMs.toFixed(3)}ms p95=${r500.p95Ms.toFixed(3)}ms roots=${r500.lastRoots}; ` +
            `N=5000 runs=${r5000.runs} median=${r5000.medianMs.toFixed(3)}ms p95=${r5000.p95Ms.toFixed(3)}ms roots=${r5000.lastRoots}`
        )

        expect(r500.lastRoots).toBe(100)
        expect(r5000.lastRoots).toBe(1000)
        expect(r500.medianMs).toBeLessThan(5)
        expect(r5000.medianMs).toBeLessThan(25)
    })

    it('processes multi-group sidebars in linear O(N) time with a shared lookup', () => {
        const groupCount = 100
        const sessionsPerGroup = 50
        const allSessions: SessionSummary[] = []
        const groups: SessionSummary[][] = []
        let expectedTotalRoots = 0

        for (let g = 0; g < groupCount; g += 1) {
            const group: SessionSummary[] = []
            const linkedGroup = g % 2 === 0
            for (let i = 0; i < sessionsPerGroup; i += 1) {
                const id = `g${g}-s${i}`
                if (!linkedGroup) {
                    const session = makeSession({ id, updatedAt: sessionsPerGroup - i, metadata: { path: `/work/proj-${g}` } })
                    allSessions.push(session)
                    group.push(session)
                    expectedTotalRoots += 1
                    continue
                }
                const slot = i % 5
                if (slot === 0) {
                    const root = makeSession({ id, updatedAt: sessionsPerGroup - i, metadata: { path: `/work/proj-${g}` } })
                    allSessions.push(root)
                    group.push(root)
                    expectedTotalRoots += 1
                } else if (slot === 1) {
                    // Filtered-out intermediate present only in allSessions.
                    const hidden = makeSession({
                        id,
                        updatedAt: sessionsPerGroup - i,
                        metadata: { path: `/work/proj-${g}`, parentLink: { parentSessionId: `g${g}-s${i - 1}`, kind: 'peer' } }
                    })
                    allSessions.push(hidden)
                } else {
                    const child = makeSession({
                        id,
                        updatedAt: sessionsPerGroup - i,
                        metadata: { path: `/work/proj-${g}`, parentLink: { parentSessionId: `g${g}-s${i - 1}`, kind: 'peer' } }
                    })
                    allSessions.push(child)
                    group.push(child)
                }
            }
            groups.push(group)
        }

        const runMultiGroup = () => {
            const lookup = buildSessionLookup(allSessions)
            let totalRoots = 0
            for (const group of groups) {
                totalRoots += buildSessionLineage(group, lookup).roots.length
            }
            return totalRoots
        }

        const warmup = 20
        const runs = 100
        let lastRoots = 0
        for (let i = 0; i < warmup; i += 1) {
            lastRoots = runMultiGroup()
        }
        const samples: number[] = []
        for (let i = 0; i < runs; i += 1) {
            const t0 = performance.now()
            lastRoots = runMultiGroup()
            const t1 = performance.now()
            samples.push(t1 - t0)
        }
        samples.sort((a, b) => a - b)
        const medianMs = samples[Math.floor(samples.length * 0.5)]!
        const p95Ms = samples[Math.floor(samples.length * 0.95)]!

        console.info(
            `[sessionLineage-bench] multi-group N=${allSessions.length} G=${groupCount} runs=${runs} ` +
            `median=${medianMs.toFixed(3)}ms p95=${p95Ms.toFixed(3)}ms roots=${lastRoots}`
        )

        expect(lastRoots).toBe(expectedTotalRoots)
        expect(medianMs).toBeLessThan(25)
    })
})
