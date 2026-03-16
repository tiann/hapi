import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionHeader } from './SessionHeader'
import type { Session } from '@/types/api'

vi.mock('@/components/HostBadge', () => ({
    HostBadge: () => null,
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        archiveSession: vi.fn(),
        renameSession: vi.fn(),
        deleteSession: vi.fn(async () => {}),
        isPending: false,
    }),
}))

vi.mock('@/components/SessionIcons', () => ({
    MoreVerticalIcon: () => <span aria-hidden="true">M</span>,
}))

vi.mock('@/components/SessionActionMenu', () => ({
    SessionActionMenu: () => null,
}))

vi.mock('@/components/RenameSessionDialog', () => ({
    RenameSessionDialog: () => null,
}))

vi.mock('@/shared/ui', () => ({
    ConfirmDialog: () => null,
}))

vi.mock('@/lib/sessionTitle', () => ({
    getSessionTitle: () => 'Session title',
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, number>) => {
            const map: Record<string, string> = {
                'button.close': 'Close',
                'session.more': 'More',
                'session.view.label': 'Session views',
                'session.view.chat': 'Chat',
                'session.view.terminal': 'Terminal',
                'session.view.files': 'Files',
                'session.git.loading': 'Loading Git status…',
                'session.git.unavailable': 'Git unavailable',
                'session.git.detached': 'Detached',
                'misc.unknown': 'Unknown'
            }
            if (key === 'session.git.staged') return `${params?.n ?? 0} staged`
            if (key === 'session.git.unstaged') return `${params?.n ?? 0} unstaged`
            return map[key] ?? key
        },
    }),
}))

function buildSession(hasPath: boolean): Session {
    return {
        id: hasPath ? 'session-with-path' : 'session-without-path',
        namespace: 'default',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: {
            path: hasPath ? '/tmp/project' : '',
            host: '',
            flavor: 'claude',
            machineId: undefined,
            worktree: undefined,
            os: undefined
        },
        metadataVersion: 1,
        modelMode: 'default',
        permissionMode: 'default',
        thinking: false,
        thinkingAt: 0,
        agentState: null,
        agentStateVersion: 0,
        teamState: undefined
    } as Session
}

describe('SessionHeader', () => {
    it('renders session title and back button', () => {
        render(
            <SessionHeader
                session={buildSession(true)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
            />
        )

        expect(screen.getByText('Session title')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('shows Files tab only when session has a working path', () => {
        const { rerender, container } = render(
            <SessionHeader
                session={buildSession(true)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
            />
        )

        expect(container.textContent).toContain('Chat')
        expect(container.textContent).toContain('Terminal')
        expect(container.textContent).toContain('Files')

        rerender(
            <SessionHeader
                session={buildSession(false)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
            />
        )

        expect(container.textContent).toContain('Chat')
        expect(container.textContent).toContain('Terminal')
        expect(container.textContent).not.toContain('Files')
    })

    it('calls onSelectView when tab is clicked', () => {
        const onSelectView = vi.fn()
        const { container } = render(
            <SessionHeader
                session={buildSession(true)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={onSelectView}
            />
        )

        const tabs = container.querySelectorAll('[role="tab"]')
        const terminalTab = Array.from(tabs).find(tab => tab.textContent?.includes('Terminal'))
        expect(terminalTab).toBeTruthy()

        fireEvent.click(terminalTab as Element)
        expect(onSelectView).toHaveBeenCalledWith('terminal')
    })

    it('shows git status when loading', () => {
        render(
            <SessionHeader
                session={buildSession(true)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
                gitLoading={true}
            />
        )

        expect(screen.getByText('Loading Git status…')).toBeInTheDocument()
    })

    it('shows git status when available', () => {
        render(
            <SessionHeader
                session={buildSession(true)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
                gitSummary={{ branch: 'main', totalStaged: 2, totalUnstaged: 3 }}
            />
        )

        expect(screen.getByText('main')).toBeInTheDocument()
        expect(screen.getByText('2 staged')).toBeInTheDocument()
        expect(screen.getByText('3 unstaged')).toBeInTheDocument()
    })

    it('shows git unavailable when error', () => {
        render(
            <SessionHeader
                session={buildSession(true)}
                onBack={vi.fn()}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
                gitError={true}
            />
        )

        const gitUnavailableElements = screen.getAllByText('Git unavailable')
        expect(gitUnavailableElements.length).toBeGreaterThan(0)
    })

    it('calls onBack when back button is clicked', () => {
        const onBack = vi.fn()
        const { container } = render(
            <SessionHeader
                session={buildSession(true)}
                onBack={onBack}
                api={null}
                currentView="chat"
                onSelectView={vi.fn()}
            />
        )

        const backButton = container.querySelector('button[aria-label="Close"]')
        expect(backButton).toBeTruthy()

        fireEvent.click(backButton as Element)
        expect(onBack).toHaveBeenCalled()
    })
})
