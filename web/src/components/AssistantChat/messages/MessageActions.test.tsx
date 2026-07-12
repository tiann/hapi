import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { MessageActions } from './MessageActions'

const copy = vi.fn()

vi.mock('@assistant-ui/react', () => ({
    useAssistantState: (selector: (state: { message: { createdAt: Date } }) => unknown) => selector({
        message: { createdAt: new Date(2026, 6, 12, 10, 30) }
    })
}))

vi.mock('@radix-ui/react-popover', () => ({
    Root: ({ children }: PropsWithChildren) => <>{children}</>,
    Trigger: ({ children }: PropsWithChildren) => <>{children}</>,
    Portal: ({ children }: PropsWithChildren) => <>{children}</>,
    Content: ({ children }: PropsWithChildren) => <div>{children}</div>
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({ copied: false, copy })
}))

function renderActions(props: ComponentProps<typeof MessageActions>) {
    return render(
        <I18nProvider>
            <MessageActions {...props} />
        </I18nProvider>
    )
}

describe('MessageActions', () => {
    beforeEach(() => {
        copy.mockReset()
        localStorage.clear()
    })

    it('copies the supplied message text', () => {
        renderActions({ align: 'start', copyText: 'message body' })

        fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

        expect(copy).toHaveBeenCalledWith('message body')
    })

    it('shows meaningful assistant metadata in a popover without invoke time', () => {
        renderActions({
            align: 'start',
            metadata: {
                durationMs: 1250,
                model: 'gpt-5.2-codex',
                usage: { input_tokens: 100, output_tokens: 25 }
            }
        })

        expect(screen.getByRole('button', { name: 'Message details' })).toBeTruthy()
        expect(screen.getByText('Duration: 1.3s')).toBeTruthy()
        expect(screen.getByText('Model: gpt-5.2-codex')).toBeTruthy()
        expect(screen.getByText('Usage: 125 billable tokens (100 in / 25 out)')).toBeTruthy()
        expect(screen.queryByText(/^Invoke:/)).toBeNull()
    })

    it('omits the info action when no display metadata exists', () => {
        renderActions({ align: 'end', copyText: 'message body', metadata: {} })

        expect(screen.queryByRole('button', { name: 'Message details' })).toBeNull()
    })
})
