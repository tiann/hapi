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
        expect(screen.getByText('Tokens: 125 total (100 in / 25 out)')).toBeTruthy()
        expect(screen.queryByText(/^Invoke:/)).toBeNull()
    })

    it('omits the info action when no display metadata exists', () => {
        renderActions({ align: 'end', copyText: 'message body', metadata: {} })

        expect(screen.queryByRole('button', { name: 'Message details' })).toBeNull()
    })

    it('keeps the info button reachable on touch devices (no hover-only class)', () => {
        renderActions({
            align: 'start',
            copyText: 'message body',
            metadata: { durationMs: 1250, model: 'gpt-5.2-codex' }
        })

        const button = screen.getByRole('button', { name: 'Message details' })
        expect(button.className.split(' ')).not.toContain('happy-message-actions-desktop-only')
    })

    it('keeps the action row reachable on touch devices for tool-only messages with metadata', () => {
        // Tool-only assistant turns (no trailing text) have no copyText, but
        // can still carry model/duration metadata from the first tool block
        // in the response group (see assistant-runtime.ts toThreadMessageLike).
        renderActions({
            align: 'start',
            copyText: undefined,
            metadata: { durationMs: 1250, model: 'gpt-5.2-codex' }
        })

        const button = screen.getByRole('button', { name: 'Message details' })
        const row = button.closest('.happy-message-actions')
        expect(row).not.toBeNull()
        expect(row!.className.split(' ')).not.toContain('happy-message-actions-desktop-only-row')
    })

    it('keeps the timestamp reachable on touch devices (no hover-only class)', () => {
        renderActions({ align: 'start', copyText: 'message body' })

        const time = document.querySelector('time')
        expect(time).not.toBeNull()
        const wrapper = time!.parentElement!
        expect(wrapper.className.split(' ')).not.toContain('happy-message-actions-desktop-only')
    })

    it('keeps the row reachable on touch devices even with neither copy text nor metadata (timestamp-only row)', () => {
        // DesktopTimestamp always renders inside the row regardless of
        // canCopy/hasMetadata, so the row is never actually empty -- hiding
        // it via the hover-only row class would hide a real timestamp.
        renderActions({ align: 'end', copyText: undefined, metadata: undefined })

        const time = document.querySelector('time')
        expect(time).not.toBeNull()
        const row = time!.closest('.happy-message-actions')
        expect(row).not.toBeNull()
        expect(row!.className.split(' ')).not.toContain('happy-message-actions-desktop-only-row')
    })
})
