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