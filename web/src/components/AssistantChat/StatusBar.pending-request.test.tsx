import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { AgentState } from '@/types/api'
import { StatusBar } from './StatusBar'

function renderStatus(requests: AgentState['requests'], onClick = vi.fn()) {
    render(
        <I18nProvider>
            <StatusBar active thinking={false} agentState={{ requests }} onPendingRequestClick={onClick} />
        </I18nProvider>
    )
    return onClick
}

describe('StatusBar pending requests', () => {
    it('labels a question as awaiting an answer and locates it directly', () => {
        const onClick = renderStatus({
            question: { tool: 'request_user_input', arguments: {}, createdAt: 1 },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Awaiting your answer' }))
        expect(onClick).toHaveBeenCalledExactlyOnceWith('question')
        expect(screen.getByText('Awaiting your answer')).toHaveClass('text-[var(--app-badge-warning-text)]')
    })

    it('labels and opens the sole actionable request when another request is hidden', () => {
        const onClick = vi.fn()
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={{ requests: {
                        hiddenQuestion: { tool: 'request_user_input', arguments: {}, createdAt: 1 },
                        approval: { tool: 'Bash', arguments: {}, createdAt: 2 },
                    } }}
                    pendingRequestReceipts={new Map([['hiddenQuestion', 'dismissed']])}
                    onPendingRequestClick={onClick}
                />
            </I18nProvider>
        )

        const shortcut = screen.getByRole('button', { name: 'Approval required' })
        expect(shortcut).toHaveTextContent('Approval required')
        expect(shortcut).toHaveAttribute('title', 'Approval required')
        expect(shortcut).not.toHaveAttribute('aria-haspopup')
        fireEvent.click(shortcut)
        expect(onClick).toHaveBeenCalledExactlyOnceWith('approval')
    })

    const question = { tool: 'request_user_input', arguments: { questions: [{ question: 'Choose a client' }] } }
    const permission = { tool: 'Bash', arguments: { command: 'git status' } }
    const other = { tool: 'Read', arguments: { path: 'README.md' } }
    const waiting = 'Answer sent. Waiting for the agent.'
    const input = 'Awaiting your answer'
    const approval = 'Approval required'
    type MatrixRow = {
        name: string
        requests: NonNullable<AgentState['requests']>
        receipts?: Record<string, 'answered' | 'dismissed' | 'missing'>
        label: string
        targets?: [string, string][]
    }
    const matrix: MatrixRow[] = [
        { name: 'no requests', requests: {}, label: 'online' },
        { name: 'receipt for absent request', requests: {}, receipts: { q: 'answered' }, label: 'online' },
        { name: 'one question', requests: { q: question }, label: input, targets: [['q', 'Choose a client']] },
        { name: 'one permission', requests: { p: permission }, label: approval, targets: [['p', 'git status']] },
        { name: 'one other tool', requests: { o: other }, label: approval, targets: [['o', 'README.md']] },
        { name: 'one answered question', requests: { q: question }, receipts: { q: 'answered' }, label: waiting },
        { name: 'one dismissed question', requests: { q: question }, receipts: { q: 'dismissed' }, label: 'online' },
        { name: 'one missing question', requests: { q: question }, receipts: { q: 'missing' }, label: 'online' },
        {
            name: 'two actionable kinds', requests: { q: question, p: permission }, label: '2 pending requests',
            targets: [['q', 'Choose a client'], ['p', 'git status']]
        },
        {
            name: 'answered beside two actionable tools', requests: { q: question, p: permission, o: other },
            receipts: { q: 'answered' }, label: '2 pending requests', targets: [['p', 'git status'], ['o', 'README.md']]
        },
        {
            name: 'answered beside one actionable tool', requests: { q: question, p: permission },
            receipts: { q: 'answered' }, label: approval, targets: [['p', 'git status']]
        },
        {
            name: 'dismissed beside one actionable tool', requests: { q: question, o: other },
            receipts: { q: 'dismissed' }, label: approval, targets: [['o', 'README.md']]
        },
        {
            name: 'answered and missing', requests: { q: question, q2: question },
            receipts: { q: 'answered', q2: 'missing' }, label: waiting
        },
        {
            name: 'dismissed and missing', requests: { q: question, q2: question },
            receipts: { q: 'dismissed', q2: 'missing' }, label: 'online'
        },
    ]

    it.each(matrix.flatMap(row => [true, false].map(click => ({ ...row, click }))))(
        '$name (navigation callback: $click)',
        ({ requests, receipts, click, label, targets = [] }) => {
            const onClick = vi.fn()
            const pendingRequestReceipts = new Map(Object.entries(receipts ?? {}))
            render(
                <I18nProvider>
                    <StatusBar
                        active
                        thinking={false}
                        agentState={{ requests }}
                        pendingRequestReceipts={pendingRequestReceipts}
                        onPendingRequestClick={click ? onClick : undefined}
                    />
                </I18nProvider>
            )

            const text = screen.getByText(label, { exact: true })
            const dot = text.previousElementSibling
            expect(dot).toHaveClass(label === 'online' ? 'bg-[#34C759]'
                : label === waiting ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-warning-text)]')
            if (label === 'online') expect(dot).not.toHaveClass('animate-pulse')
            else expect(dot).toHaveClass('animate-pulse')

            if (!click || targets.length === 0) {
                expect(text.closest('button')).toBeNull()
                expect(onClick).not.toHaveBeenCalled()
                return
            }

            const shortcut = screen.getByRole('button', { name: label })
            expect(shortcut).toHaveAttribute('title', label)
            if (targets.length === 1) {
                expect(shortcut).not.toHaveAttribute('aria-haspopup')
                fireEvent.click(shortcut)
                expect(onClick).toHaveBeenCalledExactlyOnceWith(targets[0]![0])
                return
            }

            expect(shortcut).toHaveAttribute('aria-haspopup', 'dialog')
            fireEvent.click(shortcut)
            expect(onClick).not.toHaveBeenCalled()
            const menu = within(screen.getByRole('dialog'))
            expect(menu.getAllByRole('button')).toHaveLength(targets.length)
            for (const [, description] of targets) expect(menu.getByText(description)).toBeVisible()
            const [id, description] = targets[0]!
            fireEvent.click(menu.getByText(description))
            expect(onClick).toHaveBeenCalledExactlyOnceWith(id)
        }
    )

    it('labels Cursor questions as awaiting an answer', () => {
        renderStatus({
            cursor: { tool: 'CursorAskQuestion', arguments: { prompt: 'Choose one' }, createdAt: 1 },
        })
        expect(screen.getByText('Awaiting your answer')).toBeInTheDocument()
    })
    it('uses an approval label for permission requests', () => {
        renderStatus({
            approval: { tool: 'Bash', arguments: {}, createdAt: 1 },
        })
        expect(screen.getByText('Approval required')).toBeInTheDocument()
    })

    it('lets mixed requests be selected individually', () => {
        const onClick = renderStatus({
            approval: {
                tool: 'Bash',
                arguments: { command: 'git status --short' },
                createdAt: 1,
            },
            question: {
                tool: 'request_user_input',
                arguments: {
                    questions: [
                        { question: 'Which implementation approach should I use?' },
                        { question: 'Should I add screenshots?' },
                    ],
                },
                createdAt: 2,
            },
        })
        fireEvent.click(screen.getByRole('button', { name: '2 pending requests' }))
        const popover = screen.getByRole('dialog')
        expect(within(popover).queryByText('2 pending requests')).not.toBeInTheDocument()
        expect(screen.getByText('Which implementation approach should I use?')).toBeInTheDocument()
        expect(screen.getByText('More questions: 1')).toBeInTheDocument()
        expect(screen.getByText('git status --short')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', {
            name: 'Awaiting your answer Which implementation approach should I use? More questions: 1',
        }))
        expect(onClick).toHaveBeenCalledExactlyOnceWith('question')
    })
})