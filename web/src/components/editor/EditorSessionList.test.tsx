import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { EditorSessionList, sessionBelongsToProject } from './EditorSessionList'

const useSessionsMock = vi.fn()

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: (...args: unknown[]) => useSessionsMock(...args)
}))

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: Date.now(),
        updatedAt: Date.now(),
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('sessionBelongsToProject', () => {
    it('matches project path, child paths, worktree basePath, and machine ID', () => {
        const direct = makeSession({ id: 'direct', metadata: { path: '/repo', machineId: 'machine-1' } })
        const child = makeSession({ id: 'child', metadata: { path: '/repo/packages/web', machineId: 'machine-1' } })
        const worktree = makeSession({
            id: 'worktree',
            metadata: { path: '/tmp/worktree', machineId: 'machine-1', worktree: { basePath: '/repo' } as never }
        })
        const sibling = makeSession({ id: 'sibling', metadata: { path: '/repo2', machineId: 'machine-1' } })
        const otherMachine = makeSession({ id: 'other', metadata: { path: '/repo', machineId: 'machine-2' } })

        expect(sessionBelongsToProject(direct, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToProject(child, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToProject(worktree, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToProject(sibling, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToProject(otherMachine, 'machine-1', '/repo')).toBe(false)
    })
})

describe('EditorSessionList', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useSessionsMock.mockReturnValue({
            sessions: [
                makeSession({
                    id: 's-1',
                    active: true,
                    thinking: true,
                    metadata: { path: '/repo', machineId: 'machine-1', name: 'Refactor editor', flavor: 'codex' }
                }),
                makeSession({
                    id: 's-2',
                    metadata: { path: '/repo/subdir', machineId: 'machine-1', name: 'Fix tests', flavor: 'claude' }
                }),
                makeSession({
                    id: 's-3',
                    metadata: { path: '/other', machineId: 'machine-1', name: 'Other project', flavor: 'gemini' }
                }),
                makeSession({
                    id: 's-4',
                    metadata: { path: '/repo', machineId: 'machine-2', name: 'Other machine', flavor: 'codex' }
                })
            ],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })
    })

    afterEach(() => {
        cleanup()
    })

    it('prompts for project selection before listing sessions', () => {
        render(
            <EditorSessionList
                api={null}
                machineId={null}
                projectPath={null}
                activeSessionId={null}
                onSelectSession={vi.fn()}
                onNewSession={vi.fn()}
            />
        )

        expect(screen.getByText('Select a project to view sessions')).toBeInTheDocument()
        expect(useSessionsMock).not.toHaveBeenCalled()
    })

    it('filters sessions by machine and project and selects sessions', () => {
        const onSelectSession = vi.fn()
        render(
            <EditorSessionList
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                activeSessionId="s-2"
                onSelectSession={onSelectSession}
                onNewSession={vi.fn()}
            />
        )

        expect(screen.getByText('Refactor editor')).toBeInTheDocument()
        expect(screen.getByText('Fix tests')).toBeInTheDocument()
        expect(screen.queryByText('Other project')).not.toBeInTheDocument()
        expect(screen.queryByText('Other machine')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Select session Fix tests' })).toHaveAttribute('aria-current', 'page')

        fireEvent.click(screen.getByRole('button', { name: 'Select session Refactor editor' }))
        expect(onSelectSession).toHaveBeenCalledWith('s-1')
    })

    it('shows loading, error, empty, and new session actions', () => {
        useSessionsMock.mockReturnValueOnce({ sessions: [], isLoading: true, error: null, refetch: vi.fn() })
        const { rerender } = render(
            <EditorSessionList
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                activeSessionId={null}
                onSelectSession={vi.fn()}
                onNewSession={vi.fn()}
            />
        )
        expect(screen.getByText('Loading sessions...')).toBeInTheDocument()

        useSessionsMock.mockReturnValueOnce({ sessions: [], isLoading: false, error: 'Network error', refetch: vi.fn() })
        rerender(
            <EditorSessionList
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                activeSessionId={null}
                onSelectSession={vi.fn()}
                onNewSession={vi.fn()}
            />
        )
        expect(screen.getByText('Network error')).toBeInTheDocument()

        const onNewSession = vi.fn()
        useSessionsMock.mockReturnValueOnce({ sessions: [], isLoading: false, error: null, refetch: vi.fn() })
        rerender(
            <EditorSessionList
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                activeSessionId={null}
                onSelectSession={vi.fn()}
                onNewSession={onNewSession}
            />
        )
        expect(screen.getByText('No sessions for this project')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '+ New' }))
        expect(onNewSession).toHaveBeenCalled()
    })
})
