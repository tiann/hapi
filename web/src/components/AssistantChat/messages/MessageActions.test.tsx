import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import {
    MessageActions,
    selectHideShareButton,
    selectThreadIsRunning,
} from './MessageActions'

const copy = vi.fn()
const auiState = {
    message: { id: 'msg-1', createdAt: new Date(2026, 6, 12, 10, 30) },
    thread: {
        isRunning: false,
        extras: {
            shareHiddenByMessageId: new Set<string>(),
        },
    },
}

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState)
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: (props: {
        isOpen: boolean
        title: string
        confirmLabel: string
        onConfirm: () => Promise<void>
        onClose: () => void
    }) => props.isOpen ? (
        <div>
            <div>{props.title}</div>
            <button type="button" onClick={() => void props.onConfirm()}>{props.confirmLabel}</button>
            <button type="button" onClick={props.onClose}>Cancel</button>
        </div>
    ) : null
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

describe('MessageActions useAuiState selectors (#1380)', () => {
    const base = {
        message: { id: 'msg-1' },
        thread: {
            isRunning: false,
            extras: { shareHiddenByMessageId: new Set<string>(['msg-hidden']) },
        },
    }

    it('returns Object.is-stable primitives so useSyncExternalStore cannot loop', () => {
        const hideA = selectHideShareButton(base)
        const hideB = selectHideShareButton(base)
        const runningA = selectThreadIsRunning(base)
        const runningB = selectThreadIsRunning(base)

        expect(Object.is(hideA, hideB)).toBe(true)
        expect(Object.is(runningA, runningB)).toBe(true)
        expect(hideA).toBe(false)
        expect(runningA).toBe(false)
    })

    it('hides share for ids in shareHiddenByMessageId; falls back to isRunning when extras are absent', () => {
        expect(selectHideShareButton({
            message: { id: 'msg-hidden' },
            thread: base.thread,
        })).toBe(true)
        // When extras exist, `.has()` false is kept (?? does not fall through to isRunning).
        expect(selectHideShareButton({
            message: { id: 'msg-1' },
            thread: { ...base.thread, isRunning: true },
        })).toBe(false)
        expect(selectHideShareButton({
            message: { id: 'msg-1' },
            thread: { isRunning: true },
        })).toBe(true)
        expect(selectThreadIsRunning({
            message: { id: 'msg-1' },
            thread: { ...base.thread, isRunning: true },
        })).toBe(true)
    })
})

describe('MessageActions', () => {
    beforeEach(() => {
        copy.mockReset()
        localStorage.clear()
        auiState.thread.isRunning = false
        auiState.thread.extras.shareHiddenByMessageId = new Set()
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

    it('hides Fork and Rewind when capabilities are off', () => {
        renderActions({ align: 'end', copyText: 'body' })
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
    })

    it('renders Fork and Rewind as compact icon actions', () => {
        renderActions({
            align: 'end',
            copyText: 'body',
            showFork: true,
            showRewind: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        for (const name of ['Fork', 'Rewind']) {
            const button = screen.getByRole('button', { name })
            expect(button.className.split(' ')).toContain('w-5')
            expect(button.querySelector('svg')).not.toBeNull()
        }
    })

    it('shows Fork confirm dialog and calls onFork only after confirm', async () => {
        const onFork = vi.fn(async () => {})
        renderActions({ align: 'start', copyText: 'body', showFork: true, onFork })

        fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
        expect(onFork).not.toHaveBeenCalled()
        expect(screen.getByText('Fork conversation')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onFork).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
        fireEvent.click(screen.getAllByRole('button', { name: 'Fork' }).at(-1)!)
        expect(onFork).toHaveBeenCalledTimes(1)
    })

    it('shows Rewind destructive confirm and calls onRewind only after confirm', async () => {
        const onRewind = vi.fn(async () => {})
        renderActions({ align: 'end', copyText: 'body', showRewind: true, onRewind })

        fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
        expect(onRewind).not.toHaveBeenCalled()
        expect(screen.getByText('Rewind conversation')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onRewind).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
        fireEvent.click(screen.getAllByRole('button', { name: 'Rewind' }).at(-1)!)
        expect(onRewind).toHaveBeenCalledTimes(1)
    })
})
