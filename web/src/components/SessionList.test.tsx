import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SessionList } from './SessionList'
import type { SessionSummary } from '@/types/api'

const hostBadgeMock = vi.fn((_props?: { host?: string; machineId?: string; showBoth?: boolean }) => null)

vi.mock('@/hooks/usePlatform', () => ({
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
    HostBadge: (props: { host?: string; machineId?: string; showBoth?: boolean }) => hostBadgeMock(props)
}))

vi.mock('@/components/SessionActionMenu', () => ({
    SessionActionMenu: () => null
}))

vi.mock('@/components/RenameSessionDialog', () => ({
    RenameSessionDialog: () => null
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
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
        metadata: partial.metadata ?? { path: '/tmp/project-a', flavor: 'claude', host: undefined, machineId: undefined },
        todoProgress: partial.todoProgress ?? null,
        ...partial
    } as SessionSummary
}

describe('SessionList action touch behavior', () => {
    it('does not navigate when tapping archive/delete action buttons on touch devices', () => {
        const onSelect = vi.fn()

        const sessions: SessionSummary[] = [
            createSession({ id: 'active-1', active: true, metadata: { path: '/tmp/project-a', flavor: 'claude', machineId: 'machine1' } as SessionSummary['metadata'] }),
            createSession({ id: 'inactive-1', active: false, metadata: { path: '/tmp/project-a', flavor: 'claude', machineId: 'machine1' } as SessionSummary['metadata'] })
        ]

        render(
            <SessionList
                sessions={sessions}
                onSelect={onSelect}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
                selectedSessionId={null}
            />
        )

        const archiveButton = screen.getByRole('button', { name: 'session.action.archive' })
        const deleteButton = screen.getByRole('button', { name: 'session.action.delete' })

        fireEvent.touchStart(archiveButton, { touches: [{ clientX: 12, clientY: 8 }] })
        fireEvent.touchEnd(archiveButton)

        fireEvent.touchStart(deleteButton, { touches: [{ clientX: 14, clientY: 10 }] })
        fireEvent.touchEnd(deleteButton)

        expect(onSelect).not.toHaveBeenCalled()
    })

    it('still navigates when tapping row non-action area', () => {
        const onSelect = vi.fn()

        const sessions: SessionSummary[] = [
            createSession({ id: 'active-2', active: true, metadata: { path: '/tmp/project-b', flavor: 'claude', machineId: 'machine2' } as SessionSummary['metadata'] })
        ]

        const { container } = render(
            <SessionList
                sessions={sessions}
                onSelect={onSelect}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
                selectedSessionId={null}
            />
        )

        const row = container.querySelector('.session-list-item')
        expect(row).not.toBeNull()

        fireEvent.touchStart(row as Element, { touches: [{ clientX: 20, clientY: 18 }] })
        fireEvent.touchEnd(row as Element)

        expect(onSelect).toHaveBeenCalledWith('active-2')
    })

    it('groups sessions by machineId and path', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', active: true, metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine1', host: 'laptop' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-2', active: false, metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine1', host: 'laptop' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-3', active: true, metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine2', host: 'server' } as SessionSummary['metadata'] })
        ]

        const { container } = render(
            <SessionList
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
                selectedSessionId={null}
            />
        )

        const groupButtons = container.querySelectorAll('button[class*="sticky"]')
        expect(groupButtons.length).toBe(2)
    })

    it('separates groups by host when machineId is missing', () => {
        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-4', active: true, metadata: { path: '/home/user/project', flavor: 'claude', machineId: undefined, host: 'laptop' } as SessionSummary['metadata'] }),
            createSession({ id: 'sess-5', active: true, metadata: { path: '/home/user/project', flavor: 'claude', machineId: undefined, host: 'server' } as SessionSummary['metadata'] })
        ]

        const { container } = render(
            <SessionList
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
                selectedSessionId={null}
            />
        )

        const groupButtons = container.querySelectorAll('button[class*="sticky"]')
        expect(groupButtons.length).toBe(2)
    })
    it('renders group HostBadge with showBoth enabled', () => {
        hostBadgeMock.mockClear()

        const sessions: SessionSummary[] = [
            createSession({ id: 'sess-1', metadata: { path: '/home/user/project', flavor: 'claude', machineId: 'machine1', host: 'laptop' } as SessionSummary['metadata'] })
        ]

        render(
            <SessionList
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
                selectedSessionId={null}
            />
        )

        expect(hostBadgeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                host: 'laptop',
                machineId: 'machine1',
                showBoth: true
            })
        )
    })
})