import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { RequestUserInputView } from './RequestUserInputView'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key === 'tool.requestUserInput.otherLabel' ? '以上都不是' : key })
}))

function block(isOther?: boolean): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'block', localId: null, createdAt: 0, children: [],
        tool: {
            id: 'call', name: 'request_user_input', state: 'completed', createdAt: 0,
            startedAt: null, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null,
            input: { questions: [{ id: 'choice', question: 'Choose', isOther, options: [{ label: 'Alpha' }] }] }
        }
    }
}

describe('RequestUserInputView', () => {
    it.each(['live', 'object', 'string'])('shows the selected synthetic option and note from %s answers', (source) => {
        const value = block(true)
        const answers = { choice: { answers: ['None of the above', 'user_note: 自定义\n说明'] } }
        if (source === 'live') {
            value.tool.permission = { id: 'permission', status: 'approved', answers }
            value.tool.result = { answers: { choice: { answers: ['Alpha', 'user_note: stale'] } } }
        } else {
            value.tool.result = source === 'string' ? JSON.stringify({ answers }) : { answers }
        }
        render(<RequestUserInputView block={value} metadata={null} />)
        expect(screen.getByText('以上都不是').closest('.rounded-md')).toHaveClass('border-emerald-500')
        expect(screen.getByText('Alpha').closest('.rounded-md')).not.toHaveClass('border-emerald-500')
        expect(screen.getByText('自定义 说明')).toHaveTextContent('自定义 说明')
        expect(screen.queryByText('stale')).not.toBeInTheDocument()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('does not lose recorded answers missing from the original options, even without isOther', () => {
        const value = block()
        value.tool.result = JSON.stringify({ answers: { choice: { answers: ['None of the above', 'Another answer', 'user_note: keep this'] } } })
        render(<RequestUserInputView block={value} metadata={null} />)
        expect(screen.getByText('None of the above')).toHaveClass('border-emerald-500')
        expect(screen.getByText('Another answer')).toBeInTheDocument()
        expect(screen.getByText('keep this')).toBeInTheDocument()
    })

    it('does not turn a neutral resolution or a prefill into a recorded selection', () => {
        const value = block(true)
        value.tool.result = { status: 'resolved' }
        value.tool.permission = { id: 'permission', status: 'resolved' }
        render(<RequestUserInputView block={value} metadata={null} />)
        expect(screen.getByText('以上都不是').closest('.rounded-md')).not.toHaveClass('border-emerald-500')
        expect(screen.queryByText('user_note:', { exact: false })).not.toBeInTheDocument()
    })

    it('still treats an actual option beginning with user_note as a choice', () => {
        const value = block(true)
        value.tool.input = { questions: [{ id: 'choice', isOther: true, options: [{ label: 'user_note: later' }] }] }
        value.tool.result = { answers: { choice: { answers: ['user_note: later'] } } }
        render(<RequestUserInputView block={value} metadata={null} />)
        expect(screen.getByText('user_note: later').closest('.rounded-md')).toHaveClass('border-emerald-500')
        expect(screen.queryByText('Note:')).not.toBeInTheDocument()
    })
})
