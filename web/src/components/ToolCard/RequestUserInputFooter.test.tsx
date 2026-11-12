import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
            selection: vi.fn()
        }
    })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key === 'tool.requestUserInput.otherLabel' ? '以上都不是' : key })
}))

import { RequestUserInputFooter } from './RequestUserInputFooter'

const choice = { id: 'choice', question: 'Choose', isOther: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }

function renderFooter(input: unknown = { questions: [choice] }) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn().mockResolvedValue(undefined)
    const props = {
        api: { approvePermission, denyPermission } as unknown as ApiClient,
        sessionId: 'session-1', tool: makeTool(input), disabled: false, onDone: vi.fn()
    }
    return { ...render(<RequestUserInputFooter {...props} />), props, approvePermission, denyPermission }
}

function makeTool(input: unknown): ChatToolCall {
    return {
        id: 'request-1',
        name: 'request_user_input',
        state: 'pending',
        input,
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        permission: {
            id: 'permission-1',
            status: 'pending'
        }
    }
}

describe('RequestUserInputFooter', () => {
    it('dismisses only the optional request without validating or submitting answers', async () => {
        const { props, denyPermission, approvePermission } = renderFooter({ isBlocking: false, questions: [choice] })
        fireEvent.click(screen.getByRole('button', { name: 'button.dismiss' }))
        await waitFor(() => expect(props.onDone).toHaveBeenCalledOnce())
        expect(denyPermission).toHaveBeenCalledExactlyOnceWith('session-1', 'permission-1')
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.queryByText('tool.selectOption')).not.toBeInTheDocument()
    })

    it.each([true, undefined, 'false'])('does not offer dismissal without explicit non-blocking status (%s)', (isBlocking) => {
        renderFooter({ isBlocking, questions: [choice] })
        expect(screen.queryByRole('button', { name: 'button.dismiss' })).not.toBeInTheDocument()
    })

    it('prevents concurrent actions during dismissal and keeps the draft on failure', async () => {
        const { props, rerender, denyPermission, approvePermission } = renderFooter({ isBlocking: false, questions: [choice] })
        let fail!: (reason: Error) => void
        denyPermission.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep my draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'button.dismiss' }))
        expect(screen.getByRole('button', { name: 'button.dismiss' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'tool.submitting' })).toBeDisabled()
        fail(new Error('Connection lost'))
        await screen.findByText('Connection lost')
        expect(props.onDone).not.toHaveBeenCalled()
        expect(screen.getByRole('textbox')).toHaveValue('keep my draft')
        expect(screen.getByRole('button', { name: 'button.dismiss' })).toBeEnabled()
        rerender(<RequestUserInputFooter {...props} disabled />)
        fireEvent.click(screen.getByRole('button', { name: 'button.dismiss' }))
        expect(denyPermission).toHaveBeenCalledOnce()
        expect(approvePermission).not.toHaveBeenCalled()
    })

    it.each(['', ' \n ', '  自定义\n说明  '])('focuses notes without submitting and posts canonical values (%j)', async (note) => {
        const { approvePermission } = renderFooter()
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('radio', { name: /以上都不是/ }))
        expect(screen.getByRole('textbox')).toHaveFocus()
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false')
        expect(screen.getByRole('radio', { name: /以上都不是/ })).toHaveAttribute('aria-checked', 'true')
        expect(approvePermission).not.toHaveBeenCalled()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: note } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['None of the above', ...(note.trim() ? [`user_note: ${note.trim()}`] : [])] } }
        }))
    })

    it('retains notes across choices, questions, and SSE rerenders without auto-advancing', async () => {
        const { props, rerender, approvePermission } = renderFooter({ questions: [choice, { ...choice, id: 'second', question: 'Second' }] })
        fireEvent.click(screen.getByRole('radio', { name: /以上都不是/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this note' } })
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        expect(screen.getByRole('radio', { name: /以上都不是/ })).toHaveAttribute('aria-checked', 'false')
        expect(screen.getByRole('textbox')).toHaveValue('keep this note')
        fireEvent.click(screen.getByRole('radio', { name: /以上都不是/ }))
        expect(screen.getByText('Choose')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.click(screen.getByRole('radio', { name: /Beta/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.prev' }))
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, input: structuredClone(props.tool.input) }} />)
        expect(screen.getByRole('textbox')).toHaveValue('keep this note')
        expect(screen.getByRole('radio', { name: /以上都不是/ })).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['None of the above', 'user_note: keep this note'] }, second: { answers: ['Beta'] } }
        }))
    })

    it('does not interpret a note alone as None of the above', () => {
        const { approvePermission } = renderFooter()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'custom' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.getByText('tool.selectOption')).toBeInTheDocument()
    })

    it.each([false, undefined])('does not add other to Pi or MCP choices (%s)', (isOther) => {
        renderFooter({ questions: [{ ...choice, isOther }] })
        expect(screen.queryByRole('radio', { name: /以上都不是/ })).not.toBeInTheDocument()
    })

    it('exposes shared radio/checkbox option semantics', () => {
        renderFooter({ questions: [choice, { ...choice, id: 'second', question: 'Second', multiple: true }] })
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        expect(screen.getByRole('checkbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(screen.getByRole('checkbox', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('checkbox', { name: /Beta/ }))
        expect(screen.getByRole('checkbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('checkbox', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('renders option labels and descriptions as Markdown', () => {
        const { container } = renderFooter({
            questions: [{
                id: 'md',
                question: 'Pick a target',
                isOther: true,
                options: [{ label: 'Deploy to **staging**', description: 'Runs `bun test` first' }]
            }]
        })
        expect(container.querySelector('strong')).not.toBeNull()
        expect(container.querySelector('code')).not.toBeNull()
        expect(screen.queryByText('Deploy to **staging**')).toBeNull()
    })

    it('retains the answer on failure and removes controls when resolved elsewhere', async () => {
        const { props, rerender, approvePermission } = renderFooter()
        approvePermission.mockRejectedValueOnce(new Error('try again'))
        fireEvent.click(screen.getByRole('radio', { name: /以上都不是/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await screen.findByText('try again')
        expect(screen.getByRole('textbox')).toHaveValue('draft')
        expect(screen.getByRole('radio', { name: /以上都不是/ })).toHaveAttribute('aria-checked', 'true')
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, permission: { id: 'permission-1', status: 'resolved' } }} />)
        expect(screen.queryByRole('button', { name: 'tool.submit' })).not.toBeInTheDocument()
        expect(approvePermission).toHaveBeenCalledTimes(1)
    })

    it('uses a Pi extension pure-text placeholder and prefill when initializing the request', () => {
        render(
            <RequestUserInputFooter
                api={{} as ApiClient}
                sessionId="session-1"
                tool={makeTool({
                    questions: [{
                        id: 'comment',
                        question: 'Comment',
                        options: [],
                        placeholder: 'Describe the change',
                        prefill: 'Initial draft'
                    }]
                })}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        const textarea = screen.getByRole('textbox')
        expect(textarea).toHaveAttribute('placeholder', 'Describe the change')
        expect(textarea).toHaveValue('Initial draft')
    })
})
