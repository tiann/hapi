import { fireEvent, render, screen } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    onShareTurn: vi.fn(),
    state: {
        message: { id: 'tail-answer' },
        thread: {
            messages: [
                { id: 'head-prompt', role: 'user', content: [{ type: 'text', text: 'head prompt' }] },
                { id: '__transcript-gap__601-801', role: 'user', content: [{ type: 'text', text: 'history gap' }] },
                { id: 'tail-answer', role: 'assistant', content: [{ type: 'text', text: 'tail answer' }] }
            ]
        }
    }
}))

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: typeof harness.state) => unknown) => selector(harness.state)
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ onShareTurn: harness.onShareTurn })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('./MessageActionButton', () => ({
    MessageActionButton: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
        <button {...props}>{children}</button>
    )
}))

import { ShareTurnButton } from './ShareTurnButton'

describe('ShareTurnButton', () => {
    beforeEach(() => harness.onShareTurn.mockReset())

    it('does not use a synthetic transcript gap as fallback user text', () => {
        render(<ShareTurnButton messageElementId="tail-answer" />)

        fireEvent.click(screen.getByRole('button'))

        expect(harness.onShareTurn).toHaveBeenCalledWith('tail-answer', 0, undefined)
    })
})
