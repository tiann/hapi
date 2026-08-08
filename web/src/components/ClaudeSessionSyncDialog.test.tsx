import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ClaudeSessionSyncDialog } from './ClaudeSessionSyncDialog'
import type { ClaudeLocalSessionSummary } from '@/types/api'

function renderDialog(
    sessions: ClaudeLocalSessionSummary[],
    onConfirm = vi.fn(async () => {}),
    currentClaudeSessionId: string | null = null
) {
    const view = render(
        <I18nProvider>
            <ClaudeSessionSyncDialog
                isOpen={true}
                onClose={vi.fn()}
                sessions={sessions}
                currentClaudeSessionId={currentClaudeSessionId}
                onConfirm={onConfirm}
                isPending={false}
                isLoading={false}
            />
        </I18nProvider>
    )
    return { ...view, onConfirm }
}

describe('ClaudeSessionSyncDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows the working directory for local Claude sessions', () => {
        renderDialog([
            {
                id: 'claude-session-1',
                title: 'Session title',
                lastUserMessage: 'Last prompt',
                cwd: '/home/user/project',
                file: '/home/user/.claude/projects/-home-user-project/session.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                originator: 'claude_code',
                cliVersion: '1.0.0'
            }
        ])

        expect(screen.getByText('Working directory')).toBeInTheDocument()
        expect(screen.getAllByText('/home/user/project')).toHaveLength(2)
    })

    it('filters sessions by working directory', () => {
        renderDialog([
            {
                id: 'claude-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.claude/projects/-home-user-project-one/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'claude-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.claude/projects/-home-user-project-two/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ])

        fireEvent.change(screen.getByLabelText('Work directory'), {
            target: { value: '/home/user/project-two' }
        })

        expect(screen.queryByText('Project one')).not.toBeInTheDocument()
        expect(screen.getByText('Project two')).toBeInTheDocument()
    })

    it('selects only filtered sessions when selecting all and confirms them', async () => {
        const onConfirm = vi.fn(async () => {})
        renderDialog([
            {
                id: 'claude-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.claude/projects/-home-user-project-one/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'claude-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.claude/projects/-home-user-project-two/two.jsonl',
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

        expect(onConfirm).toHaveBeenCalledWith(['claude-session-2'])
    })

    it('defaults selection to the linked current Claude session', async () => {
        renderDialog([
            {
                id: 'claude-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.claude/projects/-home-user-project-one/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            }
        ], vi.fn(async () => {}), 'claude-session-1')

        await waitFor(() => {
            expect(screen.getByText('1 sessions selected')).toBeInTheDocument()
            expect(screen.getByText('Linked')).toBeInTheDocument()
        })
    })
})
