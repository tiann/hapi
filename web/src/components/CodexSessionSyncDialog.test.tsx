import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexSessionSyncDialog } from './CodexSessionSyncDialog'
import type { CodexLocalSessionSummary } from '@/types/api'

function renderDialog(
    sessions: CodexLocalSessionSummary[],
    onConfirm = vi.fn(async () => {})
) {
    const view = render(
        <I18nProvider>
            <CodexSessionSyncDialog
                isOpen={true}
                onClose={vi.fn()}
                sessions={sessions}
                currentCodexSessionId={null}
                onConfirm={onConfirm}
                onRestartCodexDesktop={vi.fn()}
                isPending={false}
                isRestartingCodexDesktop={false}
                isLoading={false}
            />
        </I18nProvider>
    )
    return { ...view, onConfirm }
}

describe('CodexSessionSyncDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows the working directory for local Codex sessions', () => {
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Session title',
                lastUserMessage: 'Last prompt',
                cwd: '/home/user/project',
                file: '/home/user/.codex/sessions/session.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                originator: 'codex_cli',
                cliVersion: '0.124.0'
            }
        ])

        expect(screen.getByText('Working directory')).toBeInTheDocument()
        expect(screen.getAllByText('/home/user/project')).toHaveLength(2)
    })

    it('filters sessions by working directory', () => {
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'codex-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.codex/sessions/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ])

        fireEvent.change(screen.getByLabelText('Work directory'), {
            target: { value: '/home/user/project-two' }
        })

        expect(screen.queryByText('Project one')).not.toBeInTheDocument()
        expect(screen.getByText('Project two')).toBeInTheDocument()
    })

    it('selects only filtered sessions when selecting all', async () => {
        const onConfirm = vi.fn(async () => {})
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'codex-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.codex/sessions/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ], onConfirm)

        fireEvent.change(screen.getByLabelText('Work directory'), {
            target: { value: '/home/user/project-two' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Select all' }))

        await waitFor(() => {
            expect(screen.getByText('1 sessions selected')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
        })

        fireEvent.click(screen.getByRole('button', { name: 'Import' }))

        expect(onConfirm).toHaveBeenCalledWith(['codex-session-2'])
    })
})
