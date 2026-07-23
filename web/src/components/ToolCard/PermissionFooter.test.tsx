import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { ChatToolCall } from '@/chat/types'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { I18nProvider } from '@/lib/i18n-context'

function renderWithI18n(ui: ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

function makeTool(overrides?: Partial<ChatToolCall>): ChatToolCall {
    return {
        id: 'tool-1',
        name: 'Bash',
        state: 'running',
        input: { command: 'ls' },
        createdAt: 0,
        startedAt: 0,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        result: null,
        permission: {
            id: 'perm-1',
            status: 'pending',
        },
        ...overrides,
    }
}

describe('PermissionFooter local mode', () => {
    it('hides remote approval actions and explains local-only approval', () => {
        const approvePermission = vi.fn()
        const denyPermission = vi.fn()

        renderWithI18n(
            <PermissionFooter
                api={{ approvePermission, denyPermission } as never}
                sessionId="session-1"
                metadata={{ path: 'repo', host: 'local', flavor: 'opencode' }}
                tool={makeTool()}
                disabled={false}
                controlledByUser
                onDone={vi.fn()}
            />
        )

        expect(screen.getByText('Approve this in the local terminal, or switch to remote mode first.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
        expect(approvePermission).not.toHaveBeenCalled()
        expect(denyPermission).not.toHaveBeenCalled()
    })

    it('shows remote approval actions when not controlled by user', () => {
        renderWithI18n(
            <PermissionFooter
                api={{ approvePermission: vi.fn(), denyPermission: vi.fn() } as never}
                sessionId="session-1"
                metadata={{ path: 'repo', host: 'local', flavor: 'opencode' }}
                tool={makeTool()}
                disabled={false}
                controlledByUser={false}
                onDone={vi.fn()}
            />
        )

        expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Yes For Session' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy()
    })
})
