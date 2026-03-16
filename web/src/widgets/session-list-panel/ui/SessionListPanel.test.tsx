import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionListPanel, groupSessionsByDirectory } from './SessionListPanel'
import type { SessionSummary } from '@/types/api'

const hostBadgeMock = vi.fn(() => null)

vi.mock('@/shared/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTouch: true,
        haptic: {
            impact: vi.fn(),
            notification: vi.fn()
        }
    })
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        archiveSession: vi.fn(async () => {}),
        renameSession: vi.fn(async () => {}),
        deleteSession: vi.fn(async () => {}),
        isPending: false
    })
}))

vi.mock('@/components/HostBadge', () => ({
    HostBadge: () => hostBadgeMock()
}))

vi.mock('@/components/SessionActionMenu', () => ({
    SessionActionMenu: () => null
}))

vi.mock('@/components/RenameSessionDialog', () => ({
    RenameSessionDialog: () => null
}))

vi.mock('@/shared/ui', () => ({
    ConfirmDialog: () => null
}))

vi.mock('@/components/SessionIcons', () => ({
    ArchiveIcon: () => <span aria-hidden="true">A</span>,
    EditIcon: () => <span aria-hidden="true">E</span>,
    MoreVerticalIcon: () => <span aria-hidden="true">M</span>,
    TrashIcon: () => <span aria-hidden="true">T</span>
}))

vi.mock('@/lib/sessionTitle', () => ({
    getSessionTitle: (session: { id: string }) => `title-${session.id}`
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, string | number>) => {
            if (key === 'sessions.count') {
                return `${params?.n ?? 0} sessions / ${params?.m ?? 0} groups`
            }
            return key
        }
    })
}))

function createSession(partial: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: partial.active ?? false,
        thinking: partial.thinking ?? false,
        pendingRequestsCount: partial.pendingRequestsCount ?? 0,
        updatedAt: partial.updatedAt ?? Date.now(),
        modelMode: partial.modelMode ?? 'default',
        metadata: partial.metadata ?? { path: '/tmp/project-a', flavor: 'claude', host: undefined, os: undefined, machineId: undefined },
        todoProgress: partial.todoProgress ?? null,
        ...partial
    } as SessionSummary
}

describe('SessionListPanel', () => {
    it('renders session list with header', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', active: true, metadata: { path: '/tmp/project', flavor: 'claude', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        render(
            <SessionListPanel
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
            />
        )

        expect(screen.getByText('1 sessions / 1 groups')).toBeInTheDocument()
        expect(screen.getByTitle('sessions.new')).toBeInTheDocument()
    })

    it('calls onNewSession when new button is clicked', () => {
        const onNewSession = vi.fn()
        const sessions: SessionSummary[] = []

        const { container } = render(
            <SessionListPanel
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={onNewSession}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
            />
        )

        const newButton = container.querySelector('.session-list-new-button')
        expect(newButton).not.toBeNull()
        fireEvent.click(newButton as Element)
        expect(onNewSession).toHaveBeenCalled()
    })

    it('groups sessions by machineId and path', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', active: true, metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine1', host: 'laptop' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-2', active: false, metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine1', host: 'laptop' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-3', active: true, metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine2', host: 'server' } as SessionSummary['metadata'] })
        ]

        const { container } = render(
            <SessionListPanel
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
            />
        )

        const groupButtons = container.querySelectorAll('button[class*="sticky"]')
        expect(groupButtons.length).toBe(2)
    })

    it('toggles group collapse state', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', active: false, metadata: { path: '/tmp/project', flavor: 'claude', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        const { container } = render(
            <SessionListPanel
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
            />
        )

        const groupButton = container.querySelector('button[class*="sticky"]')
        expect(groupButton).not.toBeNull()

        // Initially collapsed (inactive group)
        expect(container.querySelector('.session-list-item')).toBeNull()

        // Click to expand
        fireEvent.click(groupButton as Element)
        expect(container.querySelector('.session-list-item')).not.toBeNull()
    })

    it('highlights selected session', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', active: true, metadata: { path: '/tmp/project', flavor: 'claude', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        const { container } = render(
            <SessionListPanel
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
                selectedSessionId="sess-1"
            />
        )

        const sessionItem = container.querySelector('.session-list-item')
        expect(sessionItem?.className).toContain('bg-[var(--app-secondary-bg)]')
    })
})

describe('groupSessionsByDirectory', () => {
    it('groups sessions by directory and machine', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', metadata: { path: '/home/user/project', machineId: 'machine1' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-2', metadata: { path: '/home/user/project', machineId: 'machine1' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-3', metadata: { path: '/home/user/other', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        const groups = groupSessionsByDirectory(sessions)
        expect(groups.length).toBe(2)
        expect(groups[0].sessions.length).toBe(2)
        expect(groups[1].sessions.length).toBe(1)
    })

    it('sorts groups by active status and update time', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', active: false, updatedAt: 100, metadata: { path: '/tmp/a', machineId: 'machine1' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-2', active: true, updatedAt: 200, metadata: { path: '/tmp/b', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        const groups = groupSessionsByDirectory(sessions)
        expect(groups[0].hasActiveSession).toBe(true)
        expect(groups[1].hasActiveSession).toBe(false)
    })

    it('extracts display name from path', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', metadata: { path: '/home/user/my-project', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        const groups = groupSessionsByDirectory(sessions)
        expect(groups[0].displayName).toBe('my-project')
    })
})
