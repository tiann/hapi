import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock, ToolPermission } from '@/chat/types'
import { ToolCard } from './ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function question(id: string, status: ToolPermission['status'] = 'pending', reason?: string): ToolCallBlock {
    return {
        kind: 'tool-call', id, localId: null, createdAt: 1_000,
        tool: {
            id, name: 'request_user_input', state: status === 'pending' ? 'pending' : 'completed',
            input: { isBlocking: false, questions: [{ id, question: `Question ${id}`, options: [] }] },
            createdAt: 1_000, startedAt: 1_000, completedAt: status === 'pending' ? null : 2_000,
            execStartedAt: null, execCompletedAt: null, description: null,
            permission: { id: `request-${id}`, status, ...(reason ? { reason } : {}) }
        }, children: []
    }
}

function cards(blocks: ToolCallBlock[], api = {} as ApiClient, onDone = () => {}) {
    return <I18nProvider>{blocks.map((block) => <div key={block.id} data-testid={block.id}>
        <ToolCard api={api} sessionId="session-1" metadata={null} terminalToolDisplayMode="compact" disabled={false} onDone={onDone} block={block} />
    </div>)}</I18nProvider>
}

describe('async question transcript status', () => {
    it('can dismiss a second question while the first answer is in flight and shows its authoritative cancellation', async () => {
        let finishAnswer!: () => void
        const approvePermission = vi.fn(() => new Promise<void>((resolve) => { finishAnswer = resolve }))
        const denyPermission = vi.fn().mockResolvedValue(undefined)
        const api = { approvePermission, denyPermission } as unknown as ApiClient
        const onDone = vi.fn()
        const first = question('first')
        const { rerender } = render(cards([first, question('second')], api, onDone))
        const firstCard = within(screen.getByTestId('first'))
        const secondCard = within(screen.getByTestId('second'))

        fireEvent.change(firstCard.getByRole('textbox'), { target: { value: 'First answer' } })
        fireEvent.click(firstCard.getByRole('button', { name: 'Submit' }))
        expect(firstCard.getByRole('button', { name: 'Submitting…' })).toBeDisabled()
        expect(secondCard.getByRole('button', { name: 'Dismiss' })).toBeEnabled()
        fireEvent.click(secondCard.getByRole('button', { name: 'Dismiss' }))
        await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
        expect(denyPermission).toHaveBeenCalledExactlyOnceWith('session-1', 'request-second')
        // Only an authoritative update, not a successful HTTP acknowledgement,
        // settles the question. Keep history visible and remove its form.
        rerender(cards([first, question('second', 'canceled')], api, onDone))
        expect(secondCard.getByText('Canceled')).toBeVisible()
        expect(secondCard.getByText('Question second')).toBeVisible()
        expect(secondCard.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
        expect(secondCard.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
        expect(secondCard.queryByRole('textbox')).not.toBeInTheDocument()
        expect(firstCard.getByRole('button', { name: 'Submitting…' })).toBeDisabled()

        finishAnswer()
        await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2))
        rerender(cards([question('first', 'resolved'), question('second', 'canceled')], api, onDone))
        expect(firstCard.getByText('Resolved in Codex')).toBeVisible()
        expect(secondCard.getByText('Canceled')).toBeVisible()
    })

    it('shows a supplied cancellation reason when loading historical questions', () => {
        render(cards([question('old', 'canceled', 'Request withdrawn')]))
        expect(screen.getByText('Canceled: Request withdrawn')).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    })

    it.each([true, undefined])('does not change cancellation feedback for other question types (%s)', (isBlocking) => {
        const block = question('blocking', 'canceled')
        block.tool.input = { isBlocking, questions: [{ id: 'blocking', question: 'Blocking question', options: [] }] }
        render(cards([block]))
        expect(screen.queryByText('Canceled')).not.toBeInTheDocument()
    })
})
