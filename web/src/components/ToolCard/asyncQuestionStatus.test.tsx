import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock, ToolPermission } from '@/chat/types'
import { ToolCard } from './ToolCard'
import { permissionFooterContent } from './PermissionFooter'
import { I18nProvider } from '@/lib/i18n-context'

const asyncInput = { isBlocking: false, questions: [{ id: 'q', question: 'Optional question', options: [] }] }

function question(status: ToolPermission['status'], reason?: string): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'q', localId: null, createdAt: 1_000,
        tool: {
            id: 'q', name: 'request_user_input', state: status === 'pending' ? 'pending' : 'completed',
            input: asyncInput,
            createdAt: 1_000, startedAt: 1_000, completedAt: status === 'pending' ? null : 2_000,
            execStartedAt: null, execCompletedAt: null, description: null,
            permission: { id: 'request-q', status, ...(reason ? { reason } : {}) }
        }, children: []
    }
}

function card(block: ToolCallBlock) {
    return <I18nProvider>
        <ToolCard api={{} as ApiClient} sessionId="session-1" metadata={null} terminalToolDisplayMode="compact" disabled={false} onDone={() => {}} block={block} />
    </I18nProvider>
}

describe('async question transcript status', () => {
    it('shows Canceled and removes reply controls once a dismissal settles without a reason', () => {
        const { rerender } = render(card(question('pending')))
        expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible()

        rerender(card(question('canceled')))
        expect(screen.getByText('Canceled')).toBeVisible()
        expect(screen.getByText('Optional question')).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('shows a supplied cancellation reason when loading historical questions', () => {
        render(card(question('canceled', 'Request withdrawn')))
        expect(screen.getByText('Canceled: Request withdrawn')).toBeVisible()
    })

    it('keeps other settled permissions unchanged', () => {
        expect(permissionFooterContent({ id: 'p', status: 'canceled' }, 'Bash', {})).toBeNull()
        expect(permissionFooterContent({ id: 'p', status: 'denied' }, 'Bash', {})).toBeNull()
        expect(permissionFooterContent({ id: 'p', status: 'approved' }, 'Bash', {})).toBeNull()
        expect(permissionFooterContent({ id: 'p', status: 'canceled', reason: 'Aborted' }, 'Bash', {})).toBe('reason')
        expect(permissionFooterContent({ id: 'p', status: 'resolved' }, 'request_user_input', asyncInput)).toBe('status')
    })
})
