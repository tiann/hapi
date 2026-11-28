import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'
import { I18nProvider } from '@/lib/i18n-context'
import { findLatestCompletedBoundaryId, type HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { HappyUserMessage } from './UserMessage'

const onBranch = vi.fn()
const onFork = vi.fn(async (_localId?: string) => {})
const state = {
    message: { id: 'user-text:interrupted', role: 'user', createdAt: new Date(10),
        content: [{ type: 'text', text: 'Interrupted prompt' }],
        metadata: { custom: { kind: 'user', localId: 'local-interrupted' as string | null, sourceMessageId: 'stored-message', invokedAt: 10 as number | null | undefined, isTranscriptEcho: false } as {
            kind: string; localId: string | null; sourceMessageId?: string; invokedAt?: number | null;
            status?: HappyChatMessageMetadata['status']; steered?: boolean; isTranscriptEcho: boolean
        } } },
    thread: { isRunning: true, messages: [] }
}
type ContextMetadata = NonNullable<HappyChatContextValue['metadata']>
type UserMessageTestContext = Pick<HappyChatContextValue,
    'disabled' | 'historyActionPending' | 'inputTranslationEnabled' | 'allowInactiveFork' | 'isLatestCompletedBoundary'
    | 'onBranchConversation' | 'onForkConversation' | 'onRewindConversation'
> & {
    metadata: Pick<ContextMetadata,
        'flavor' | 'conversationHistoryPoints' | 'conversationHistoryDiverged' | 'claudeRewind'
    > & {
        capabilities: {
            conversationHistory: Required<NonNullable<NonNullable<ContextMetadata['capabilities']>['conversationHistory']>>
        }
    }
}
const ctx: UserMessageTestContext = {
    metadata: { flavor: 'codex', capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
        conversationHistoryPoints: { 'local-interrupted': true } as Record<string, true> },
    disabled: false, historyActionPending: false, allowInactiveFork: false,
    isLatestCompletedBoundary: (_id: string) => true,
    onBranchConversation: onBranch,
    onForkConversation: onFork, onRewindConversation: async () => {}
}

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (value: typeof state) => unknown) => selector(state),
    MessagePrimitive: { Root: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div> }
}))
vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ctx,
    useOptionalHappyChatContext: () => null
}))
vi.mock('./MessageAttachments', () => ({ MessageAttachments: () => null }))
vi.mock('./MessageStatusIndicator', () => ({ MessageStatusIndicator: () => null }))
vi.mock('./user-bubble', () => ({
    UserBubbleContent: ({ text }: { text: string }) => <span>{text}</span>,
    getUserBubbleClassName: () => '',
    shouldShowMessageStatus: () => false
}))
vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: () => null
}))
vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: ({ isOpen, confirmLabel, onConfirm }: { isOpen: boolean; confirmLabel: string; onConfirm: () => Promise<void> }) =>
        isOpen ? <div role="dialog"><button onClick={() => void onConfirm()}>{confirmLabel}</button></div> : null
}))

function mount() {
    return render(<I18nProvider><HappyUserMessage /></I18nProvider>)
}
async function requestFork() {
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1))
}

describe('HappyUserMessage turn-input anchor', () => {
    beforeEach(() => {
        state.message.metadata.custom = {
            kind: 'user',
            localId: 'local-interrupted',
            sourceMessageId: 'stored-message',
            isTranscriptEcho: false,
            status: 'sent',
            invokedAt: undefined
        }
    })

    it('keeps omitted invokedAt values eligible as already-invoked prompts', () => {
        const { container } = mount()

        expect(container.querySelector('[data-hapi-turn-input="true"]')).not.toBeNull()
    })

    it('leaves an invoked steer out of the navigable turn inputs', () => {
        state.message.metadata.custom.steered = true
        const { container } = mount()
        expect(container.querySelector('[data-hapi-turn-input]')).toBeNull()
    })

    it('does not mark queued messages as turn inputs', () => {
        state.message.metadata.custom = {
            kind: 'user',
            localId: 'local-interrupted',
            sourceMessageId: 'stored-message',
            isTranscriptEcho: false,
            status: 'queued',
            invokedAt: null
        }

        const { container } = mount()

        expect(container.querySelector('[data-hapi-turn-input]')).toBeNull()
    })
})

describe('user-only completed fork boundary', () => {
    beforeEach(() => {
        localStorage.clear()
        onFork.mockClear()
        onBranch.mockClear()
        state.message.metadata.custom.invokedAt = 10
        state.message.metadata.custom.localId = 'local-interrupted'
        state.message.metadata.custom.isTranscriptEcho = false
        state.message.metadata.custom.status = undefined
        state.thread.isRunning = true
        ctx.metadata.flavor = 'codex'
        ctx.metadata.capabilities.conversationHistory.forkAtMessage = true
        ctx.metadata.capabilities.conversationHistory.rewindToMessage = true
        ctx.metadata.conversationHistoryPoints = { 'local-interrupted': true }
        delete ctx.metadata.conversationHistoryDiverged
        delete ctx.metadata.claudeRewind
        ctx.disabled = false
        ctx.allowInactiveFork = false
        ctx.historyActionPending = false
    })

    it('forks before an interrupted user-only boundary while the next turn runs', async () => {
        // No assistant block was produced by the interrupted first turn.
        const boundary = findLatestCompletedBoundaryId([
            { kind: 'user-text', id: 'interrupted', localId: 'local-interrupted', text: 'Interrupted prompt', createdAt: 10, invokedAt: 10 },
            { kind: 'user-text', id: 'running', localId: 'local-running', text: 'Next prompt', createdAt: 20, invokedAt: 20 }
        ], true, 20)
        expect(boundary).toBe(state.message.id)
        mount()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
        await requestFork()
        expect(onFork).toHaveBeenCalledWith('local-interrupted')
    })

    it('offers a portable historical branch without native points, including inactive sources', () => {
        state.thread.isRunning = false
        ctx.disabled = true
        ctx.metadata.flavor = 'claude'
        ctx.metadata.conversationHistoryPoints = {}
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Branch with options' }))
        expect(onBranch).toHaveBeenCalledWith('local-interrupted')
    })

    it('never offers a queued user message as a branch boundary', () => {
        state.thread.isRunning = false
        state.message.metadata.custom.invokedAt = null
        mount()
        expect(screen.queryByRole('button', { name: 'Branch with options' })).toBeNull()
    })

    it('offers a portable branch for an invoked terminal message without a local id', () => {
        state.message.metadata.custom.localId = null
        state.thread.isRunning = false
        ctx.metadata.flavor = 'claude'
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Branch with options' }))
        expect(onBranch).toHaveBeenCalledWith(undefined, 'stored-message')
    })

    it('does not offer a branch on a transcript echo', () => {
        state.message.metadata.custom.localId = null
        state.message.metadata.custom.isTranscriptEcho = true
        state.thread.isRunning = false
        ctx.metadata.flavor = 'claude'
        mount()
        expect(screen.queryByRole('button', { name: 'Branch with options' })).toBeNull()
    })

    it('retains current-fork semantics for the same card when idle', async () => {
        state.thread.isRunning = false
        mount()
        await requestFork()
        expect(onFork.mock.calls[0]).toEqual([])
    })

    it('offers an archived Codex fork while leaving rewind disabled', async () => {
        state.thread.isRunning = false
        ctx.disabled = true
        ctx.allowInactiveFork = true
        mount()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
        await requestFork()
        expect(onFork.mock.calls[0]).toEqual([])
    })

    it('uses inactive-fork support when cached live capabilities no longer advertise fork', async () => {
        state.thread.isRunning = false
        ctx.disabled = true
        ctx.allowInactiveFork = true
        ctx.metadata.capabilities.conversationHistory.forkCurrent = false
        ctx.metadata.capabilities.conversationHistory.forkAtMessage = false
        try {
            mount()
            await requestFork()
        } finally { ctx.metadata.capabilities.conversationHistory.forkCurrent = true }
    })

    it.each(['claude', 'pi', 'agy', 'dsh'])('does not unlock a running %s current fork', flavor => {
        ctx.metadata.flavor = flavor
        mount()
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
    })

    it.each(['point', 'capability', 'disabled', 'pending'])('keeps the %s guard', guard => {
        if (guard === 'point') ctx.metadata.conversationHistoryPoints = {}
        if (guard === 'capability') ctx.metadata.capabilities.conversationHistory.forkAtMessage = false
        if (guard === 'disabled') ctx.disabled = true
        if (guard === 'pending') ctx.historyActionPending = true
        mount()
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
        expect(onFork).not.toHaveBeenCalled()
    })

    it.each(['claudeRewind', 'diverged'] as const)(
        'hides Fork and Rewind actions when %s blocks history mutations',
        blocker => {
            state.thread.isRunning = false
            ctx.metadata.flavor = 'claude'
            if (blocker === 'claudeRewind') {
                ctx.metadata.claudeRewind = {
                    targetLocalId: 'local-interrupted',
                    truncateFromLocalId: 'local-next',
                    keepBoundary: 'keep-1',
                    droppedPrompts: ['drop-1']
                }
            } else {
                ctx.metadata.conversationHistoryDiverged = true
            }
            mount()
            expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
            expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
        }
    )

    it('hides archived Codex Fork when conversationHistoryDiverged is true', () => {
        state.thread.isRunning = false
        ctx.disabled = true
        ctx.allowInactiveFork = true
        ctx.metadata.conversationHistoryDiverged = true
        mount()
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
    })
})

describe('HAPI system notes', () => {
    beforeEach(() => {
        localStorage.clear()
        state.thread.isRunning = false
        state.message = {
            id: 'user-text:job-wake',
            role: 'user',
            createdAt: new Date(10),
            content: [{ type: 'text', text: '[hapi job] Attached job "batch" reached status=completed.' }],
            metadata: { custom: { kind: 'system-note' } }
        } as typeof state.message
    })

    it('renders a job wake as a status line, not an operator bubble', () => {
        mount()
        const root = document.querySelector('[data-hapi-message-role="system-note"]')
        expect(root).not.toBeNull()
        expect(screen.getByText(/Attached job "batch"/)).toBeTruthy()
        expect(document.querySelector('[data-hapi-message-role="user"]')).toBeNull()
    })
})

describe('translated user prompt', () => {
    it('shows the original by default and reveals the English sent to the agent', () => {
        const previous = state.message
        state.message = {
            id: 'user-text:translated', role: 'user', createdAt: new Date(10),
            content: [{ type: 'text', text: 'Fix the login bug' }],
            metadata: { custom: { kind: 'user', localId: 'local-translated', sourceMessageId: 'stored-translated', invokedAt: 10, isTranscriptEcho: false, translatedFrom: '修复登录 bug' } as typeof previous.metadata.custom }
        }
        try {
            mount()
            expect(screen.getByText('修复登录 bug')).toBeTruthy()
            expect(screen.queryByText('Fix the login bug')).toBeNull()
            fireEvent.click(screen.getByRole('button', { name: /Show English sent to agent/ }))
            expect(screen.getByText('Fix the login bug')).toBeTruthy()
        } finally {
            state.message = previous
        }
    })

    it('marks a prompt the provider could not translate', () => {
        const previous = state.message
        state.message = {
            id: 'user-text:fallback', role: 'user', createdAt: new Date(10),
            content: [{ type: 'text', text: '修复登录 bug' }],
            metadata: { custom: { kind: 'user', localId: 'local-fallback', sourceMessageId: 'stored-fallback', invokedAt: 10, isTranscriptEcho: false, translationFailed: true } as typeof previous.metadata.custom }
        }
        try {
            mount()
            expect(screen.getByText('Not translated')).toBeTruthy()
        } finally {
            state.message = previous
        }
    })

    it('labels an in-flight send as translating while translation is on', () => {
        const previous = state.message
        state.message = {
            id: 'user-text:sending', role: 'user', createdAt: new Date(10),
            content: [{ type: 'text', text: '修复登录 bug' }],
            metadata: { custom: { kind: 'user', localId: 'local-sending', sourceMessageId: undefined, invokedAt: null, isTranscriptEcho: false, status: 'sending' } as unknown as typeof previous.metadata.custom }
        }
        try {
            ctx.inputTranslationEnabled = true
            mount()
            expect(screen.getByText('Translating…')).toBeTruthy()
        } finally {
            ctx.inputTranslationEnabled = undefined
            state.message = previous
        }
    })
})
