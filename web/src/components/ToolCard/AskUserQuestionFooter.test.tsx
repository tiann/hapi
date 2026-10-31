import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: vi.fn(), selection: vi.fn() } })
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { AskUserQuestionFooter } from './AskUserQuestionFooter'

function makeTool(id: string): ChatToolCall {
    return {
        id, name: 'AskUserQuestion', state: 'pending',
        input: { questions: [{ question: 'Pick one', options: [{ label: 'Alpha', description: null }, { label: 'Beta', description: null }], multiSelect: false }] },
        createdAt: 1, startedAt: null, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null,
        permission: { id: 'permission-1', status: 'pending' }
    } as unknown as ChatToolCall
}

function renderFooter(sessionId: string, tool: ChatToolCall, approvePermission = vi.fn().mockResolvedValue(undefined)) {
    return {
        ...render(
            <AskUserQuestionFooter
                api={{ approvePermission } as unknown as ApiClient}
                sessionId={sessionId}
                tool={tool}
                disabled={false}
                onDone={vi.fn()}
            />
        ),
        approvePermission,
    }
}

// SessionChat.tsx keys the whole chat subtree by `session.id`, so switching
// sessions unmounts and remounts everything under it — this wrapper mirrors
// that exactly rather than just re-rendering with new props.
function SessionKeyedWrapper(props: { sessionId: string; tool: ChatToolCall }) {
    return (
        <div key={props.sessionId}>
            <AskUserQuestionFooter
                api={{ approvePermission: vi.fn() } as unknown as ApiClient}
                sessionId={props.sessionId}
                tool={props.tool}
                disabled={false}
                onDone={vi.fn()}
            />
        </div>
    )
}

describe('AskUserQuestionFooter draft persistence (hapi#1734)', () => {
    it('restores an in-progress answer after a session-switch remount', () => {
        const tool = makeTool('tool-1')
        const { rerender } = render(<SessionKeyedWrapper sessionId="session-A" tool={tool} />)

        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')

        rerender(<SessionKeyedWrapper sessionId="session-B" tool={tool} />) // switch away
        rerender(<SessionKeyedWrapper sessionId="session-A" tool={tool} />) // switch back

        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('still resets to blank when the same instance moves to a different tool call', () => {
        const { rerender } = renderFooter('session-A', makeTool('tool-1'))
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')

        rerender(
            <AskUserQuestionFooter
                api={{ approvePermission: vi.fn() } as unknown as ApiClient}
                sessionId="session-A"
                tool={makeTool('tool-2')}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false')
    })

    it('restores an in-progress answer after a session-switch remount under StrictMode', () => {
        // Dev-only StrictMode replays this effect as setup -> cleanup -> setup
        // right on mount, before the setState calls in setup have flowed
        // through a render. A naive cleanup would read pre-restore ref values
        // and, being blank, delete the draft its own setup just loaded —
        // caught by review on tiann/hapi#1853.
        const tool = makeTool('tool-1')
        const { rerender } = render(
            <StrictMode><SessionKeyedWrapper sessionId="session-A" tool={tool} /></StrictMode>
        )

        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')

        rerender(<StrictMode><SessionKeyedWrapper sessionId="session-B" tool={tool} /></StrictMode>) // switch away
        rerender(<StrictMode><SessionKeyedWrapper sessionId="session-A" tool={tool} /></StrictMode>) // switch back

        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('clears the stored draft once the answer is submitted', async () => {
        const tool = makeTool('tool-1')
        const { approvePermission, rerender } = renderFooter('session-A', tool)

        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await vi.waitFor(() => expect(approvePermission).toHaveBeenCalled())

        // Re-mount the same session/tool pair as if the widget were shown again
        rerender(<SessionKeyedWrapper sessionId="session-A" tool={tool} />)
        expect(screen.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false')
    })
})
