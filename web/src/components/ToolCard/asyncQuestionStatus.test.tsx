import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock, ToolPermission } from '@/chat/types'
import { ToolCard } from './ToolCard'
import { permissionFooterContent } from './PermissionFooter'
import { I18nProvider } from '@/lib/i18n-context'

const asyncInput = { isBlocking: false, questions: [{ id: 'q', question: 'Optional question', options: [] }] }
const claudeInput = {
    questions: [{
        header: 'Database',
        multiSelect: false,
        options: [{ description: 'Local file', label: 'SQLite' }, { description: 'Server', label: 'Postgres' }],
        question: 'Which database?'
    }]
}

// A pending question keeps the 'running' tool state until its reply lands in
// the transcript (reducerTools seeds running from the pending permission), so
// the pending fixture models running with no completion time.
function question(status: ToolPermission['status'], reason?: string, name: 'request_user_input' | 'AskUserQuestion' = 'request_user_input'): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'q', localId: null, createdAt: 1_000,
        tool: {
            id: 'q', name, state: status === 'pending' ? 'running' : 'completed',
            input: name === 'request_user_input' ? asyncInput : claudeInput,
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

    it('shows the waiting sentence in the open answer area without timing labels', () => {
        render(card(question('pending')))
        expect(screen.getByText('Waiting for your reply')).toBeVisible()
        expect(screen.queryByText('Started')).toBeNull()
        expect(screen.queryByText('Duration')).toBeNull()
    })

    it('carries the waiting sentence in the open answer area, not the header', () => {
        const { container } = render(card(question('pending')))
        const waiting = screen.getByText('Waiting for your reply')
        expect(waiting.closest('div[class*="rounded-lg"]')).not.toBeNull()
        expect(waiting).toHaveClass('mb-2')
        const cardRoot = waiting.closest('div[class*="rounded-[20px]"]')
        expect(cardRoot).not.toBeNull()
        expect(cardRoot!.firstElementChild!.contains(waiting)).toBe(false)
    })

    it('counts the elapsed waiting time in the status row while pending', () => {
        const { container } = render(card(question('pending')))
        const elapsed = container.querySelector('span[title*="Duration"]')
        expect(elapsed).not.toBeNull()
        expect(elapsed!.parentElement).toHaveClass('items-center')
        expect(elapsed!.parentElement).toHaveClass('shrink-0')
    })

    it('does the same for Claude-shaped pending questions', () => {
        const { container } = render(card(question('pending', undefined, 'AskUserQuestion')))
        const waiting = screen.getByText('Waiting for your reply')
        expect(waiting.closest('div[class*="rounded-2xl"]')).not.toBeNull()
        const cardRoot = waiting.closest('div[class*="rounded-[20px]"]')
        expect(cardRoot!.firstElementChild!.contains(waiting)).toBe(false)
        expect(container.querySelector('span[title*="Duration"]')).not.toBeNull()
    })

    it('hides the question text from the header while pending; the open body shows it', () => {
        render(card(question('pending')))
        expect(screen.getAllByText('Optional question')).toHaveLength(1)
    })

    it('shows the question text in the header again once the question settles', () => {
        render(card(question('resolved')))
        expect(screen.getByText('Optional question')).toBeVisible()
    })

    it('keeps the timing summary once the question settles', () => {
        render(card(question('resolved')))
        expect(screen.queryByText('Waiting for your reply')).toBeNull()
    })
})
