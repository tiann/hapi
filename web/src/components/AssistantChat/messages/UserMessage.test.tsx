import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { findLatestCompletedBoundaryId } from '@/lib/assistant-runtime'
import { HappyUserMessage } from './UserMessage'

const onBranch = vi.fn()
const onFork = vi.fn(async (_localId?: string) => {})
const state = {
    message: { id: 'user-text:interrupted', role: 'user', createdAt: new Date(10),
        content: [{ type: 'text', text: 'Interrupted prompt' }],
        metadata: { custom: { kind: 'user', localId: 'local-interrupted', invokedAt: 10 as number | null } } },
    thread: { isRunning: true, messages: [] }
}
const ctx = {
    metadata: { flavor: 'codex', capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
        conversationHistoryPoints: { 'local-interrupted': true } as Record<string, true> },
    disabled: false, historyActionPending: false, allowInactiveFork: false,
    isLatestCompletedBoundary: (_id: string) => true,
    onBranchConversation: onBranch,
    onForkConversation: onFork, onRewindConversation: async () => {}
}

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (value: typeof state) => unknown) => selector(state),
    MessagePrimitive: { Root: ({ children, ...props }: PropsWithChildren) => <div {...props}>{children}</div> }
}))
vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ctx, useOptionalHappyChatContext: () => null
}))
vi.mock('./MessageAttachments', () => ({ MessageAttachments: () => null }))
vi.mock('./MessageStatusIndicator', () => ({ MessageStatusIndicator: () => null }))
vi.mock('./user-bubble', () => ({
    UserBubbleContent: ({ text }: { text: string }) => <span>{text}</span>,
    getUserBubbleClassName: () => '', shouldShowMessageStatus: () => false
}))
vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: ({ isOpen, confirmLabel, onConfirm }: { isOpen: boolean; confirmLabel: string; onConfirm: () => Promise<void> }) =>
        isOpen ? <div role="dialog"><button onClick={() => void onConfirm()}>{confirmLabel}</button></div> : null
}))

function mount() { render(<I18nProvider><HappyUserMessage /></I18nProvider>) }
async function confirmFork() {
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fork' }))
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1))
}

describe('user-only completed fork boundary', () => {
    beforeEach(() => {
        localStorage.clear()
        onFork.mockClear()
        onBranch.mockClear()
        state.message.metadata.custom.invokedAt = 10
        state.thread.isRunning = true
        ctx.metadata.flavor = 'codex'
        ctx.metadata.capabilities.conversationHistory.forkAtMessage = true
        ctx.metadata.conversationHistoryPoints = { 'local-interrupted': true }
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
        await confirmFork()
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

    it('retains current-fork semantics for the same card when idle', async () => {
        state.thread.isRunning = false
        mount()
        await confirmFork()
        expect(onFork.mock.calls[0]).toEqual([])
    })

    it('offers an archived Codex fork while leaving rewind disabled', async () => {
        state.thread.isRunning = false
        ctx.disabled = true
        ctx.allowInactiveFork = true
        mount()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
        await confirmFork()
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
            await confirmFork()
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
})
