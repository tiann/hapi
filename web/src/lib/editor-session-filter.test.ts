import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { filterSessionsForEditorProject, sessionBelongsToEditorProject } from './editor-session-filter'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('sessionBelongsToEditorProject', () => {
    it('matches direct project paths, child paths, worktree base paths, and machine ID', () => {
        const direct = makeSession({ id: 'direct', metadata: { path: '/repo', machineId: 'machine-1' } })
        const child = makeSession({ id: 'child', metadata: { path: '/repo/packages/web', machineId: 'machine-1' } })
        const trailingSlash = makeSession({ id: 'trailing-slash', metadata: { path: '/repo/', machineId: 'machine-1' } })
        const worktree = makeSession({
            id: 'worktree',
            metadata: { path: '/tmp/hapi-worktree', machineId: 'machine-1', worktree: { basePath: '/repo' } as never }
        })
        const worktreeChild = makeSession({
            id: 'worktree-child',
            metadata: { path: '/tmp/hapi-worktree', machineId: 'machine-1', worktree: { basePath: '/repo/packages/web' } as never }
        })

        expect(sessionBelongsToEditorProject(direct, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(child, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(trailingSlash, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(worktree, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(worktreeChild, 'machine-1', '/repo')).toBe(true)
    })

    it('rejects sibling paths, other machines, and missing machine metadata', () => {
        const sibling = makeSession({ id: 'sibling', metadata: { path: '/repo2', machineId: 'machine-1' } })
        const siblingNested = makeSession({ id: 'sibling-nested', metadata: { path: '/repo-other/packages/web', machineId: 'machine-1' } })
        const worktreeSibling = makeSession({
            id: 'worktree-sibling',
            metadata: { path: '/tmp/hapi-worktree', machineId: 'machine-1', worktree: { basePath: '/repo2' } as never }
        })
        const otherMachine = makeSession({ id: 'other-machine', metadata: { path: '/repo', machineId: 'machine-2' } })
        const missingMachine = makeSession({ id: 'missing-machine', metadata: { path: '/repo' } })
        const missingMetadata = makeSession({ id: 'missing-metadata', metadata: null })

        expect(sessionBelongsToEditorProject(sibling, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(siblingNested, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(worktreeSibling, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(otherMachine, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(missingMachine, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(missingMetadata, 'machine-1', '/repo')).toBe(false)
    })
})

describe('filterSessionsForEditorProject', () => {
    it('filters sessions and sorts active sessions first, then recent updates', () => {
        const sessions = [
            makeSession({ id: 'inactive-old', updatedAt: 100, metadata: { path: '/repo', machineId: 'machine-1' } }),
            makeSession({ id: 'other-project', active: true, updatedAt: 500, metadata: { path: '/other', machineId: 'machine-1' } }),
            makeSession({ id: 'active-old', active: true, updatedAt: 200, metadata: { path: '/repo', machineId: 'machine-1' } }),
            makeSession({ id: 'inactive-new', updatedAt: 400, metadata: { path: '/repo/packages/web', machineId: 'machine-1' } }),
            makeSession({ id: 'active-new', active: true, updatedAt: 300, metadata: { path: '/repo', machineId: 'machine-1' } }),
            makeSession({ id: 'other-machine', active: true, updatedAt: 600, metadata: { path: '/repo', machineId: 'machine-2' } })
        ]

        const result = filterSessionsForEditorProject(sessions, 'machine-1', '/repo')

        expect(result.map((session) => session.id)).toEqual([
            'active-new',
            'active-old',
            'inactive-new',
            'inactive-old'
        ])
    })
})
