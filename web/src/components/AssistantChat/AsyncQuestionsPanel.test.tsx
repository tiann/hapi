import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { AgentState } from '@/types/api'
import { AsyncQuestionsPanel } from './AsyncQuestionsPanel'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: vi.fn(), selection: vi.fn() } })
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

function question(text: string, createdAt: number, isBlocking: unknown = false) {
    return {
        tool: 'request_user_input', toolCallId: `tool-${text}`, createdAt,
        arguments: { isBlocking, questions: [{ id: 'answer', question: text, options: [] }] }
    }
}

function setup(requests: AgentState['requests']) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn().mockResolvedValue(undefined)
    const props = {
        api: { approvePermission, denyPermission } as unknown as ApiClient,
        sessionId: 'session-1', requests, disabled: false, onRefresh: vi.fn()
    }
    return { ...render(<AsyncQuestionsPanel {...props} />), props, approvePermission, denyPermission }
}

function expand() {
    fireEvent.click(screen.getByRole('button', { name: /chat.asyncQuestions.title/ }))
}

describe('AsyncQuestionsPanel', () => {
    it('lists every optional question in time order without requiring transcript messages', () => {
        setup({
            later: question('Later question', 20),
            earlier: question('Earlier question', 10),
            blocking: question('Blocking question', 1, true),
            unknown: { tool: 'request_user_input', arguments: { questions: [] } },
            permission: { tool: 'Bash', arguments: { isBlocking: false } }
        })
        expect(screen.getByRole('button', { name: /chat.asyncQuestions.title/ })).toHaveTextContent('2')
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        expand()
        expect(screen.getAllByText(/^(Earlier|Later) question$/, { selector: 'summary' }).map((node) => node.textContent))
            .toEqual(['Earlier question', 'Later question'])
        expect(screen.queryByText('Blocking question')).not.toBeInTheDocument()
        fireEvent.click(screen.getByText('Earlier question', { selector: 'summary' }))
        fireEvent.click(screen.getByText('Later question', { selector: 'summary' }))
        expect(screen.getAllByRole('button', { name: 'button.dismiss' })).toHaveLength(2)
    })

    it('preserves drafts across collapse and SSE updates, and answers using the request key', async () => {
        const { props, rerender, approvePermission } = setup({ request: question('Question', 1) })
        expand()
        fireEvent.click(screen.getByText('Question', { selector: 'summary' }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My answer' } })
        expand()
        expect(screen.getByRole('button', { name: /chat.asyncQuestions.title/ })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        rerender(<AsyncQuestionsPanel {...props} requests={structuredClone(props.requests)} />)
        expand()
        expect(screen.getByRole('textbox')).toHaveValue('My answer')
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledExactlyOnceWith('session-1', 'request', {
            answers: { answer: { answers: ['user_note: My answer'] } }
        }))
        expect(props.onRefresh).toHaveBeenCalledOnce()
    })

    it('dismisses one request and follows authoritative updates, including replies elsewhere', async () => {
        const { props, rerender, denyPermission } = setup({ first: question('First', 1), second: question('Second', 2) })
        expand()
        fireEvent.click(screen.getByText('First', { selector: 'summary' }))
        fireEvent.click(within(screen.getByText('First', { selector: 'summary' }).parentElement!).getByRole('button', { name: 'button.dismiss' }))
        await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce())
        expect(denyPermission).toHaveBeenCalledExactlyOnceWith('session-1', 'first')
        rerender(<AsyncQuestionsPanel {...props} requests={{ second: question('Second', 2) }} />)
        expect(screen.queryByText('First')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /chat.asyncQuestions.title/ })).toHaveTextContent('1')
        rerender(<AsyncQuestionsPanel {...props} requests={{}} />)
        expect(screen.queryByRole('region')).not.toBeInTheDocument()
    })

    it('disables actions for inactive sessions and does not carry answers into another session', () => {
        const { props, rerender } = setup({ request: question('Question', 1) })
        expand()
        fireEvent.click(screen.getByText('Question', { selector: 'summary' }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Session one draft' } })
        rerender(<AsyncQuestionsPanel {...props} disabled />)
        expect(screen.getByRole('button', { name: 'tool.submit' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'button.dismiss' })).toBeDisabled()
        rerender(<AsyncQuestionsPanel {...props} sessionId="session-2" />)
        fireEvent.click(screen.getByText('Question', { selector: 'summary' }))
        expect(screen.getByRole('textbox')).toHaveValue('')
    })

    it.each([null, undefined, {}])('renders nothing with no optional requests (%s)', (requests) => {
        setup(requests)
        expect(screen.queryByRole('region')).not.toBeInTheDocument()
    })
})
