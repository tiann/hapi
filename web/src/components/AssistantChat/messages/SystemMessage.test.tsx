import type { HTMLAttributes } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { HappySystemMessage } from './SystemMessage'

const { message } = vi.hoisted(() => ({
    message: {
        role: 'system', id: 'status-example',
        content: [] as { type: string; text: string }[],
        metadata: { custom: {} as Record<string, unknown> }
    }
}))
vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: { message: typeof message }) => unknown) => selector({ message }),
    MessagePrimitive: { Root: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} /> }
}))
vi.mock('./MessageTimestamp', () => ({ MessageTimestamp: () => <span>12:00</span> }))

const goal = {
    threadId: 'thread-example-1', objective: 'Compare the options and validate the chosen approach.',
    status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
    createdAt: 1704067200, updatedAt: 1704067200
}
function show(text: string, eventType = 'message', kind = 'event') {
    message.content = [{ type: 'text', text }]
    message.metadata.custom = { kind, event: { type: eventType, message: text } }
    return render(<I18nProvider><HappySystemMessage /></I18nProvider>)
}

beforeEach(() => { message.role = 'system' })

describe('slash-command goal status messages', () => {
    it('renders the actual event/message response as a goal snapshot card', () => {
        const raw = JSON.stringify({ goal })
        const { container } = show(raw)
        expect(screen.getByText('Goal')).toBeInTheDocument()
        expect(screen.getByText(goal.objective)).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        expect(screen.getByText('0 tokens')).toBeInTheDocument()
        expect(screen.getByText('No limit')).toBeInTheDocument()
        expect(screen.getByText('0.0s')).toBeInTheDocument()
        expect(container.querySelector('[data-goal-status="active"]')).not.toBeNull()
        const details = screen.getByText('Raw JSON').closest('details')!
        expect(details.open).toBe(false)
        fireEvent.click(screen.getByText('Raw JSON'))
        expect(details.open).toBe(true)
        expect(details.textContent).toContain('thread-example-1')
        expect(details.textContent).toContain(raw)
    })

    it('shows an explicitly empty goal', () => {
        show('{"goal":null}')
        expect(screen.getByText('No goal set')).toBeInTheDocument()
    })

    it.each(['Goal cleared', '{broken', '{"objective":"ordinary data"}', JSON.stringify({ goal, error: 'denied' })])
        ('preserves ordinary and malformed status text', (text) => {
            const { container } = show(text)
            expect(screen.getByText(text)).toBeInTheDocument()
            expect(container.querySelector('[data-goal-status]')).toBeNull()
        })

    it.each([['error', 'event'], ['message', 'other']])('only formats confirmed message events', (eventType, kind) => {
        const raw = JSON.stringify({ goal })
        const { container } = show(raw, eventType, kind)
        expect(screen.getByText(raw)).toBeInTheDocument()
        expect(container.querySelector('[data-goal-status]')).toBeNull()
    })

    it('does not format ordinary assistant content', () => {
        message.role = 'assistant'
        const { container } = show(JSON.stringify({ goal }))
        expect(container).toBeEmptyDOMElement()
    })
})
