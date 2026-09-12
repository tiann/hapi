import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import {
    MessageActions,
    selectThreadIsRunning,
} from './MessageActions'
import { MESSAGE_ACTION_BUTTON_CLASS } from './MessageActionButton'

const copy = vi.fn()
const onShareTurn = vi.fn()
const auiState = {
    message: { id: 'msg-1', createdAt: new Date(2026, 6, 12, 10, 30) },
    thread: {
        isRunning: false,
        messages: [],
    },
}

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState)
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: (props: {
        isOpen: boolean
        title: string
        description: string
        confirmLabel: string
        confirmingLabel: string
        onConfirm: () => Promise<void>
        onClose: () => void
        isPending: boolean
    }) => props.isOpen ? (
        <div role="dialog">
            <div>{props.title}</div>
            <div>{props.description}</div>
            <button type="button" onClick={() => void props.onConfirm()}>
                {props.isPending ? props.confirmingLabel : props.confirmLabel}
            </button>
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

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ onShareTurn })
}))

function renderActions(props: ComponentProps<typeof MessageActions>) {
    return render(
        <I18nProvider>
            <MessageActions {...props} />
        </I18nProvider>
    )
}

describe('MessageActions useAuiState selector (#1380)', () => {
    it('returns an Object.is-stable primitive so useSyncExternalStore cannot loop', () => {
        const state = {
            message: { id: 'msg-1' },
            thread: { isRunning: false },
        }

        const runningA = selectThreadIsRunning(state)
        const runningB = selectThreadIsRunning(state)

        expect(Object.is(runningA, runningB)).toBe(true)
        expect(runningA).toBe(false)
    })
})

describe('MessageActions', () => {
    beforeEach(() => {
        copy.mockReset()
        onShareTurn.mockReset()
        localStorage.clear()
        auiState.thread.isRunning = false
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

    it('localizes Fork and Rewind labels in Simplified Chinese', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')

        renderActions({
            align: 'end',
            copyText: 'body',
            showFork: true,
            showRewind: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        expect(screen.getByRole('button', { name: '回退' })).toHaveAttribute('title', '回退')
        expect(screen.getByRole('button', { name: '分叉' })).toHaveAttribute('title', '分叉')
    })

    it('localizes the Fork confirmation dialog in Simplified Chinese', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        let resolveFork: (() => void) | undefined
        const onFork = vi.fn(() => new Promise<void>((resolve) => {
            resolveFork = resolve
        }))

        renderActions({
            align: 'end',
            copyText: 'body',
            showFork: true,
            onFork
        })

        fireEvent.click(screen.getByRole('button', { name: '分叉' }))
        const dialog = screen.getByRole('dialog')
        expect(dialog.textContent).toContain('分叉对话')
        expect(dialog.textContent).toContain('从此处创建新会话？')
        expect(dialog.textContent).toContain('当前会话不会被修改。')

        fireEvent.click(within(dialog).getByRole('button', { name: '分叉' }))
        expect(onFork).toHaveBeenCalledTimes(1)
        expect(within(dialog).getByRole('button', { name: '分叉中…' })).not.toBeNull()

        resolveFork?.()
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('localizes the Rewind confirmation dialog in Simplified Chinese', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        let resolveRewind: (() => void) | undefined
        const onRewind = vi.fn(() => new Promise<void>((resolve) => {
            resolveRewind = resolve
        }))

        renderActions({
            align: 'end',
            copyText: 'body',
            showRewind: true,
            onRewind
        })

        fireEvent.click(screen.getByRole('button', { name: '回退' }))
        const dialog = screen.getByRole('dialog')
        expect(dialog.textContent).toContain('回退对话')
        expect(dialog.textContent).toContain('将此会话回退到此处？')
        expect(dialog.textContent).toContain('之后的对话历史将永久移除。文件不会被修改。')

        fireEvent.click(within(dialog).getByRole('button', { name: '回退' }))
        expect(onRewind).toHaveBeenCalledTimes(1)
        expect(within(dialog).getByRole('button', { name: '回退中…' })).not.toBeNull()

        resolveRewind?.()
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('hides Fork and Rewind while the thread is running', () => {
        auiState.thread.isRunning = true

        renderActions({
            align: 'end',
            copyText: 'body',
            showFork: true,
            showRewind: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
    })

    it('keeps the share action visible while the thread is running', () => {
        auiState.thread.isRunning = true

        renderActions({
            align: 'end',
            copyText: 'partial response',
            messageElementId: 'message-running'
        })

        fireEvent.click(screen.getByRole('button', { name: 'Share turn as image' }))

        expect(onShareTurn).toHaveBeenCalledWith('message-running', 0, {
            html: '',
            text: 'partial response',
            role: 'assistant'
        })
    })

    it('hides Fork and Rewind while a history action is pending', () => {
        renderActions({
            align: 'end',
            copyText: 'body',
            showFork: true,
            showRewind: true,
            historyActionPending: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
    })

    it('hides all history actions while a confirmation is pending', async () => {
        let resolveFork: (() => void) | undefined
        const onFork = vi.fn(() => new Promise<void>((resolve) => {
            resolveFork = resolve
        }))

        renderActions({
            align: 'end',
            copyText: 'body',
            showFork: true,
            showRewind: true,
            onFork,
            onRewind: async () => {}
        })

        fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
        fireEvent.click(screen.getAllByRole('button', { name: 'Fork' }).at(-1)!)

        await waitFor(() => {
            expect(document.querySelector('.happy-message-actions')?.querySelectorAll('button')).toHaveLength(1)
        })
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()

        resolveFork?.()
        await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1))
    })

    it('orders user actions as Share, Rewind, Fork, Copy', () => {
        renderActions({
            align: 'end',
            copyText: 'body',
            messageElementId: 'message-1',
            showFork: true,
            showRewind: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        const row = document.querySelector('.happy-message-actions')
        expect(row).not.toBeNull()
        expect(Array.from(row!.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))).toEqual([
            'Share turn as image',
            'Rewind',
            'Fork',
            'Copy'
        ])
    })

    it('uses the shared compact style and matching accessible hover labels', () => {
        renderActions({
            align: 'end',
            copyText: 'body',
            messageElementId: 'message-1',
            showFork: true,
            showRewind: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        const buttons = ['Share turn as image', 'Rewind', 'Fork', 'Copy'].map((name) =>
            screen.getByRole('button', { name })
        )
        expect(new Set(buttons.map((button) => button.className))).toEqual(new Set([MESSAGE_ACTION_BUTTON_CLASS]))
        for (const button of buttons) {
            expect(button).toHaveAttribute('title', button.getAttribute('aria-label'))
        }
        expect(buttons[0].querySelector('svg')).toHaveAttribute('class', 'h-3.5 w-3.5')
    })

    it('localizes every message action hover label in Simplified Chinese', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')

        renderActions({
            align: 'end',
            copyText: 'body',
            messageElementId: 'message-1',
            showFork: true,
            showRewind: true,
            onFork: async () => {},
            onRewind: async () => {}
        })

        for (const name of ['将本轮对话分享为图片', '回退', '分叉', '复制']) {
            expect(screen.getByRole('button', { name })).toHaveAttribute('title', name)
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
