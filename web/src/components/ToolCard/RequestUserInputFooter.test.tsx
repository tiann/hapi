import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_ASYNC_QUESTION_REQUEST_PREFIX } from '@hapi/protocol/rpcMethods'
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
import { AskUserQuestionFooter } from './AskUserQuestionFooter'

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
    it('clears an unsent selection and note only when the question is reissued', () => {
        const { props, rerender, approvePermission } = renderFooter({ isBlocking: false, questions: [choice] })
        const renderIssuance = (instanceId: string) => rerender(<RequestUserInputFooter
            {...props}
            tool={{ ...props.tool, permission: { id: 'permission-1', status: 'pending', instanceId } }}
        />)

        renderIssuance('original')
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.requestUserInput.addNote' }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old note' } })

        renderIssuance('original')
        expect(screen.getByRole('radio', { name: /Alpha/ })).toBeChecked()
        expect(screen.getByRole('textbox')).toHaveValue('old note')

        renderIssuance('replacement')
        expect(screen.getByRole('radio', { name: /Alpha/ })).not.toBeChecked()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.getByText('tool.selectOption')).toBeVisible()
    })

    it('requires a nonblank note for the generated Codex async question option', async () => {
        const { props, rerender, approvePermission } = renderFooter({ isBlocking: false, questions: [choice] })
        const id = `${CODEX_ASYNC_QUESTION_REQUEST_PREFIX}test`
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, permission: { id, status: 'pending' } }} />)
        fireEvent.click(screen.getByRole('radio', { name: /以上都不是/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(approvePermission).not.toHaveBeenCalled()

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A different answer' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledExactlyOnceWith('session-1', id, {
            answers: { choice: { answers: ['None of the above', 'user_note: A different answer'] } }
        }))
    })

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
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.requestUserInput.addNote' }))
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
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
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
        const { approvePermission } = renderFooter({ questions: [{ ...choice, prefill: 'custom' }] })
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

    it('collapses the note textarea initially for options questions', () => {
        renderFooter()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.requestUserInput.addNote' })).not.toBeInTheDocument()
    })

    it('shows the add-note control after selecting an option and expands with focus on click', async () => {
        const { approvePermission } = renderFooter()
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        const addNoteButton = screen.getByRole('button', { name: 'tool.requestUserInput.addNote' })
        const actionsRow = screen.getByTestId('request-user-input-actions')
        const submitButton = screen.getByRole('button', { name: 'tool.submit' })
        expect(actionsRow).toContainElement(addNoteButton)
        expect(actionsRow).toContainElement(submitButton)
        expect(addNoteButton.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        fireEvent.click(addNoteButton)
        expect(screen.queryByRole('button', { name: 'tool.requestUserInput.addNote' })).not.toBeInTheDocument()
        const textarea = screen.getByRole('textbox')
        expect(textarea).toHaveFocus()
        fireEvent.change(textarea, { target: { value: 'extra context' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['Alpha', 'user_note: extra context'] } }
        }))
    })

    it('expands and focuses the note textarea immediately when selecting the isOther option', () => {
        renderFooter()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: /以上都不是/ }))
        const textarea = screen.getByRole('textbox')
        expect(textarea).toBeInTheDocument()
        expect(textarea).toHaveFocus()
    })

    it('keeps the note textarea expanded when a draft note already has content', () => {
        renderFooter({ questions: [{ ...choice, prefill: 'Saved draft note' }] })
        const textarea = screen.getByRole('textbox')
        expect(textarea).toBeInTheDocument()
        expect(textarea).toHaveValue('Saved draft note')
        expect(screen.queryByRole('button', { name: 'tool.requestUserInput.addNote' })).not.toBeInTheDocument()
    })

    it('keeps per-question note expansion independent across step navigation', () => {
        renderFooter({ questions: [choice, { ...choice, id: 'second', question: 'Second' }] })
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.requestUserInput.addNote' }))
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: /Beta/ }))
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'tool.requestUserInput.addNote' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'tool.prev' }))
        expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('renders the textarea immediately for pure-text questions', () => {
        renderFooter({ questions: [{ id: 'free-text', question: 'Provide details', options: [] }] })
        expect(screen.getByRole('textbox')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.requestUserInput.addNote' })).not.toBeInTheDocument()
    })
})

// Browser translation can replace React's text node with <font> elements.
// Exercise both the start and finish of submission with those nodes displaced.
it.each([RequestUserInputFooter, AskUserQuestionFooter])('submits and recovers from failure after browser translation replaces button text (%#)', async (Footer) => {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    render(<Footer
        api={{ approvePermission } as unknown as ApiClient}
        sessionId="session-1"
        tool={{ ...makeTool({ questions: [choice] }), name: Footer === AskUserQuestionFooter ? 'AskUserQuestion' : 'request_user_input' }}
        disabled={false}
        onDone={vi.fn()}
    />)
    let rejectSubmission!: (reason: Error) => void
    approvePermission.mockImplementationOnce(() => new Promise((_, reject) => { rejectSubmission = reject }))
    fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    const button = screen.getByRole('button', { name: 'tool.submit' })
    const translateLabel = () => {
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
        let text = walker.nextNode()
        while (text && !text.textContent?.startsWith('tool.')) text = walker.nextNode()
        expect(text).not.toBeNull()
        const font = document.createElement('font')
        font.textContent = '确认'
        text!.parentNode!.replaceChild(font, text!)
    }
    translateLabel()
    fireEvent.click(button)
    expect(approvePermission).toHaveBeenCalledOnce()
    expect(button).toHaveAttribute('aria-busy', 'true')
    translateLabel()
    rejectSubmission(new Error('Try again'))
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'false'))
    expect(screen.getByText('Try again')).toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() => expect(approvePermission).toHaveBeenCalledTimes(2))
})
