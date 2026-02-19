import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionList } from './SessionList'

vi.mock('@/hooks/useLongPress', () => ({
    useLongPress: ({ onClick }: { onClick: () => void }) => ({ onClick })
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { impact: vi.fn() } })
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        archiveSession: vi.fn(),
        renameSession: vi.fn(),
        deleteSession: vi.fn(),
        isPending: false
    })
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

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
    const id = overrides.id ?? 'session-1'
    return {
        id,
        active: overrides.active ?? true,
        thinking: overrides.thinking ?? false,
        activeAt: overrides.activeAt ?? 1,
        updatedAt: overrides.updatedAt ?? 1,
        metadata: overrides.metadata ?? {
            name: id,
            path: '/repo/app',
            machineId: 'machine-1',
            flavor: 'claude',
            summary: { text: id }
        },
        todoProgress: overrides.todoProgress ?? null,
        pendingRequestsCount: overrides.pendingRequestsCount ?? 0,
        permissionMode: overrides.permissionMode,
        modelMode: overrides.modelMode
    }
}

function renderList(sessions: SessionSummary[], machineLabelsById?: Record<string, string>) {
    return render(
        <I18nProvider>
            <SessionList
                sessions={sessions}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={machineLabelsById}
            />
        </I18nProvider>
    )
}

describe('SessionList', () => {
    it('groups sessions by machine and directory', () => {
        const sessions = [
            makeSession({
                id: 's1',
                metadata: { path: '/repo/app', machineId: 'm1', flavor: 'claude' },
                updatedAt: 100
            }),
            makeSession({
                id: 's2',
                metadata: { path: '/repo/app', machineId: 'm2', flavor: 'claude' },
                updatedAt: 90
            })
        ]

        renderList(sessions, { m1: 'Laptop', m2: 'Server' })

        expect(screen.getByText('Laptop')).toBeInTheDocument()
        expect(screen.getByText('Server')).toBeInTheDocument()
    })

    it('shows permission badge only when mode allowed for flavor', () => {
        const sessions = [
            makeSession({
                id: 'claude-plan',
                metadata: { path: '/repo/claude', machineId: 'm1', flavor: 'claude' },
                permissionMode: 'plan'
            }),
            makeSession({
                id: 'codex-plan',
                metadata: { path: '/repo/codex', machineId: 'm1', flavor: 'codex' },
                permissionMode: 'plan'
            })
        ]

        renderList(sessions, { m1: 'Laptop' })

        expect(screen.getByText('plan mode')).toBeInTheDocument()
        const codexRow = screen.getAllByText('codex')[0]?.closest('button')
        expect(codexRow).toBeTruthy()
        expect(codexRow?.textContent?.toLowerCase()).not.toContain('plan mode')
    })
})
