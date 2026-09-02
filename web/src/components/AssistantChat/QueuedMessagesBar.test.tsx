import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import {
    computeCanCancel,
    computeEditPendingSchedule,
    getQueuedMessageEditText,
    getQueuedMessagePreview,
    QueuedMessagesBar,
    sortQueuedMessages,
} from './QueuedMessagesBar'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { clearQueuedEditRecovery, getQueuedEditRecovery } from '@/lib/queued-edit-recovery'

type DeferredCancelResult = { status: 'cancelled' | 'invoked' }

const mocks = vi.hoisted(() => ({
    composerText: '',
    composerSetText: vi.fn(),
    addToast: vi.fn(),
    mutateAsync: vi.fn(),
    resolveCancel: null as ((result: DeferredCancelResult) => void) | null,
    rejectCancel: null as ((reason?: unknown) => void) | null,
    steerMessage: vi.fn(),
    resolveSteer: null as ((result: unknown) => void) | null,
    markMessagesConsumed: vi.fn(),
    saveDraft: vi.fn(),
    messageWindowState: { messages: [] as unknown[] },
}))

vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({
        composer: () => ({
            getState: () => ({ text: mocks.composerText }),
            setText: mocks.composerSetText,
        }),
    }),
    useAuiState: (selector: (state: { composer: { text: string } }) => unknown) => selector({
        composer: { text: mocks.composerText },
    }),
}))

vi.mock('@/lib/message-window-store', () => ({
    getMessageWindowState: () => mocks.messageWindowState,
    subscribeMessageWindow: () => () => {},
    markMessagesConsumed: mocks.markMessagesConsumed,
}))

vi.mock('@/hooks/mutations/useCancelQueuedMessage', () => ({
    useCancelQueuedMessage: () => ({
        isPending: false,
        variables: undefined,
        mutateAsync: mocks.mutateAsync,
    }),
}))

vi.mock('@/lib/composer-drafts', () => ({
    saveDraft: mocks.saveDraft,
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast }),
}))

function makeQueuedMessage(
    scheduledAt: number | null = null,
    id = 'server-message-id',
    withAttachments = false,
): DecryptedMessage {
    return {
        id,
        localId: `local-${id}`,
        createdAt: 1000,
        seq: 1,
        scheduledAt,
        invokedAt: null,
        status: 'queued',
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: 'Queued request',
                ...(withAttachments ? {
                    attachments: [{
                        id: 'queued-att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                } : {}),
            },
        },
    } as unknown as DecryptedMessage
}

function renderQueuedMessage(
    scheduledAt: number | null = null,
    pendingSchedule: PendingSchedule | null = null,
    pendingScheduleRevision = 0,
    canSteer = false,
    api: ApiClient | null = null,
    withAttachments = false,
) {
    const onEdit = vi.fn()
    let currentPendingScheduleRevision = pendingScheduleRevision
    mocks.messageWindowState = { messages: [makeQueuedMessage(scheduledAt, 'server-message-id', withAttachments)] }
    // The real useSteerQueuedMessage hook runs inside the bar, so every render
    // needs a QueryClient (its mutations use the tanstack defaults).
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    const view = render(
        <QueryClientProvider client={queryClient}>
            <QueuedMessagesBar
                sessionId="session-1"
                api={api}
                pendingSchedule={pendingSchedule}
                pendingScheduleRevision={currentPendingScheduleRevision}
                onEdit={onEdit}
                canSteer={canSteer}
            />
        </QueryClientProvider>
    )
    return {
        onEdit,
        unmount: view.unmount,
        rerender: (nextPendingSchedule: PendingSchedule | null, nextPendingScheduleRevision = currentPendingScheduleRevision) => {
            currentPendingScheduleRevision = nextPendingScheduleRevision
            view.rerender(
                <QueryClientProvider client={queryClient}>
                    <QueuedMessagesBar
                        sessionId="session-1"
                        api={api}
                        pendingSchedule={nextPendingSchedule}
                        pendingScheduleRevision={currentPendingScheduleRevision}
                        onEdit={onEdit}
                        canSteer={canSteer}
                    />
                </QueryClientProvider>
            )
        },
    }
}

beforeEach(() => {
    mocks.composerText = ''
    mocks.composerSetText.mockReset()
    mocks.addToast.mockReset()
    mocks.mutateAsync.mockReset()
    mocks.resolveCancel = null
    mocks.rejectCancel = null
    mocks.steerMessage.mockReset()
    mocks.resolveSteer = null
    mocks.markMessagesConsumed.mockReset()
    mocks.saveDraft.mockReset()
    mocks.messageWindowState = { messages: [] }
    clearQueuedEditRecovery('session-1')
    mocks.mutateAsync.mockImplementation(() => new Promise<DeferredCancelResult>((resolve, reject) => {
        mocks.resolveCancel = resolve
        mocks.rejectCancel = reject
    }))
})

async function resolveCancel(result: DeferredCancelResult): Promise<void> {
    await act(async () => {
        mocks.resolveCancel?.(result)
        await Promise.resolve()
    })
}

function installManualAnimationFrames() {
    let nextHandle = 1
    const pending = new Map<number, FrameRequestCallback>()
    const history = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const handle = nextHandle++
        pending.set(handle, callback)
        history.set(handle, callback)
        return handle
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        pending.delete(handle)
    })

    return {
        flushPending() {
            while (pending.size > 0) {
                const [handle, callback] = pending.entries().next().value as [number, FrameRequestCallback]
                pending.delete(handle)
                callback(Date.now())
            }
        },
        flushHistory() {
            for (const callback of history.values()) {
                callback(Date.now())
            }
        },
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('QueuedMessagesBar layout', () => {
    it('keeps the queue footer flush with the composer area', () => {
        renderQueuedMessage()

        const bar = screen.getByRole('status')
        const content = bar.firstElementChild

        expect(bar).not.toHaveClass('mb-1')
        expect(content).toHaveClass('pt-2', 'pb-0')
        expect(content).not.toHaveClass('py-2')
    })
})

describe('QueuedMessagesBar edit restore', () => {
    it('disables editing scheduled messages with attachments', () => {
        renderQueuedMessage(Date.now() + 60_000, null, 0, false, null, true)

        expect(screen.getByRole('button', { name: 'Edit queued message' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Cancel queued message' })).not.toBeDisabled()
    })

    it('keeps a newly typed draft and its schedule when the deferred cancel succeeds', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        expect(mocks.resolveCancel).not.toBeNull()

        // The user starts a new draft while DELETE /messages/:id is still pending.
        mocks.composerText = 'New draft typed while cancelling'
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('keeps a newly selected schedule when the composer text is unchanged', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit, rerender } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        // The user changes only the clock selection while DELETE /messages/:id is pending.
        rerender({ type: 'preset', preset: '+30m' }, 1)
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('keeps the current state after selecting and then clearing a schedule', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit, rerender } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        rerender({ type: 'preset', preset: '+30m' }, 1)
        rerender(null, 2)
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('restores both text and schedule when the composer is unchanged', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(mocks.addToast).not.toHaveBeenCalled()
    })

    it('treats structurally equal schedule props as unchanged', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit, rerender } = renderQueuedMessage(scheduledAt, { type: 'preset', preset: '+5m' })

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        rerender({ type: 'preset', preset: '+5m' })
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
    })

    it('globally disables queued operations and keeps the first edit completion', async () => {
        const scheduledAt = Date.now() + 60_000
        const first = makeQueuedMessage(null, 'server-message-a')
        const second = makeQueuedMessage(scheduledAt, 'server-message-b')
        mocks.messageWindowState = { messages: [first, second] }
        const onEdit = vi.fn()
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false } },
        })
        render(
            <QueryClientProvider client={queryClient}>
                <QueuedMessagesBar
                    sessionId="session-1"
                    api={null}
                    pendingSchedule={null}
                    pendingScheduleRevision={0}
                    onEdit={onEdit}
                />
            </QueryClientProvider>
        )

        const editButtons = screen.getAllByRole('button', { name: 'Edit queued message' })
        const cancelButtons = screen.getAllByRole('button', { name: 'Cancel queued message' })
        // QueuedMessagesBar orders immediate rows first, so the scheduled edit is second.
        fireEvent.click(editButtons[1]!)

        await waitFor(() => {
            for (const button of [...screen.getAllByRole('button', { name: 'Edit queued message' }), ...screen.getAllByRole('button', { name: 'Cancel queued message' })]) {
                expect(button).toBeDisabled()
            }
        })
        fireEvent.click(cancelButtons[0]!)
        fireEvent.click(editButtons[0]!)
        expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

        await resolveCancel({ status: 'cancelled' })
        expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
    })

    it('persists an unmounted edit result and restores it after the same session remounts', async () => {
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        unmount()
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.saveDraft).not.toHaveBeenCalled()
        expect(getQueuedEditRecovery('session-1')).toEqual(expect.objectContaining({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
            composerTextAtEdit: '',
            pendingScheduleAtEdit: null,
        }))

        const { onEdit } = renderQueuedMessage(scheduledAt)
        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(getQueuedEditRecovery('session-1')).toBeNull()
    })

    it('notifies a same-session remount that returns before the edit cancellation completes', async () => {
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        unmount()
        const { onEdit } = renderQueuedMessage(scheduledAt)

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Edit queued message' })).toBeDisabled()
            expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeDisabled()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
        expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

        await resolveCancel({ status: 'cancelled' })

        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(getQueuedEditRecovery('session-1')).toBeNull()
    })

    it('keeps a remounted session busy until its queued-edit recovery is consumed', async () => {
        const raf = installManualAnimationFrames()
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        unmount()
        const { onEdit } = renderQueuedMessage(scheduledAt)
        await resolveCancel({ status: 'cancelled' })

        // The mutation token has ended, but the unconsumed recovery keeps Q2 busy.
        expect(screen.getByRole('button', { name: 'Edit queued message' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
        expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

        raf.flushPending()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Edit queued message' })).not.toBeDisabled())
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
    })

    it('ignores overlapping and disposed recovery animation callbacks, then allows a fresh remount to consume', async () => {
        const raf = installManualAnimationFrames()
        const scheduledAt = Date.now() + 60_000
        const first = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        first.unmount()
        const second = renderQueuedMessage(scheduledAt)
        await resolveCancel({ status: 'cancelled' })
        second.unmount()

        raf.flushHistory()
        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(second.onEdit).not.toHaveBeenCalled()
        expect(getQueuedEditRecovery('session-1')).not.toBeNull()

        const third = renderQueuedMessage(scheduledAt)
        raf.flushPending()
        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
        expect(third.onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(getQueuedEditRecovery('session-1')).toBeNull()
    })

    it('clears a conflicting recovery once and never restores it after a later composer clear', async () => {
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        unmount()
        await resolveCancel({ status: 'cancelled' })
        mocks.composerText = 'Current draft wins'

        const { onEdit, rerender } = renderQueuedMessage(scheduledAt)
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        }))
        expect(getQueuedEditRecovery('session-1')).toBeNull()

        mocks.composerText = ''
        rerender(null, 0)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
    })

    it('keeps the already-invoked toast behavior', async () => {
        const { onEdit } = renderQueuedMessage()

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        await resolveCancel({ status: 'invoked' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editAlreadyInvoked',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('does not restore an edit when cancel fails', async () => {
        const { onEdit } = renderQueuedMessage(Date.now() + 60_000)

        fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
        await act(async () => {
            mocks.rejectCancel?.(new Error('network failed'))
            await Promise.resolve()
        })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
    })
})

/**
 * Unit tests for computeCanCancel — the race guard that prevents sending
 * DELETE before the hub has a row to delete (pre-server-echo scenario).
 *
 * Key invariant: useSendMessage.onMutate creates an optimistic message with
 *   { id: localId, localId }
 * so id === localId until the server echo (message-received SSE) arrives and
 * message-window-store replaces the row with the server-assigned UUID id.
 * After that replace, id !== localId.
 *
 * canCancel = hasServerEcho && !isPending
 */
describe('computeCanCancel', () => {
    describe('hasServerEcho detection', () => {
        it('is false when id === localId (purely optimistic, no server echo)', () => {
            // useSendMessage.onMutate sets id = localId before POST /messages completes.
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: false })).toBe(false)
        })

        it('is true when id !== localId (server echo replaced id with server UUID)', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })

        it('is true when localId is undefined/null (server-only row, no local tracking)', () => {
            // Rows from server-loaded history have no localId — treat as already echoed.
            expect(computeCanCancel({ id: 'server-uuid-789', localId: undefined, isPending: false })).toBe(true)
            expect(computeCanCancel({ id: 'server-uuid-789', localId: null, isPending: false })).toBe(true)
        })
    })

    describe('isPending guard', () => {
        it('is false when a cancel mutation is already in-flight, even with server echo', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: true })).toBe(false)
        })

        it('is false when purely optimistic AND isPending', () => {
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: true })).toBe(false)
        })
    })

    describe('combined conditions', () => {
        it('is true only when server echo received AND no in-flight cancel', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            // The normal case: user can click ✕ or ✎
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })
    })
})

// ---------------------------------------------------------------------------
// #4 computeEditPendingSchedule — edit restores scheduledAt as absolute pending
// ---------------------------------------------------------------------------

describe('computeEditPendingSchedule', () => {
    it('returns null for immediate-queued message (no scheduledAt)', () => {
        const now = Date.now()
        expect(computeEditPendingSchedule(null, now)).toBeNull()
        expect(computeEditPendingSchedule(undefined, now)).toBeNull()
    })

    it('returns null for scheduledAt in the past (message matured)', () => {
        const now = Date.now()
        const past = now - 5000 // 5 seconds ago
        expect(computeEditPendingSchedule(past, now)).toBeNull()
    })

    it('returns absolute PendingSchedule for future scheduledAt', () => {
        const now = Date.now()
        const future = now + 60_000 // 1 minute from now
        const result = computeEditPendingSchedule(future, now)
        expect(result).not.toBeNull()
        expect(result?.type).toBe('absolute')
        if (result?.type === 'absolute') {
            expect(result.ms).toBe(future)
        }
    })
})

describe('sortQueuedMessages', () => {
    const make = (id: string, createdAt: number, scheduledAt: number | null = null): DecryptedMessage => ({
        id,
        localId: id,
        createdAt,
        seq: createdAt,
        scheduledAt,
        invokedAt: null,
        content: { role: 'user', content: { type: 'text', text: id } },
    } as unknown as DecryptedMessage)

    it('places immediate-queued messages before scheduled ones', () => {
        const a = make('a-immediate', 1000)
        const b = make('b-scheduled-soon', 500, Date.now() + 60_000)
        const result = sortQueuedMessages([b, a])
        expect(result.map((m) => m.id)).toEqual(['a-immediate', 'b-scheduled-soon'])
    })

    it('orders immediate-queued messages by createdAt ascending', () => {
        const older = make('older', 1000)
        const newer = make('newer', 2000)
        const result = sortQueuedMessages([newer, older])
        expect(result.map((m) => m.id)).toEqual(['older', 'newer'])
    })

    it('orders scheduled messages by scheduledAt ascending (soonest first)', () => {
        const later = make('fires-later', 1000, 10_000)
        const sooner = make('fires-sooner', 2000, 5_000)
        const result = sortQueuedMessages([later, sooner])
        expect(result.map((m) => m.id)).toEqual(['fires-sooner', 'fires-later'])
    })

    it('combined: immediate first, then scheduled in fire-time order', () => {
        const im1 = make('im1', 1000)
        const im2 = make('im2', 2000)
        const sched1 = make('sched-near', 500, 5_000)
        const sched2 = make('sched-far', 600, 10_000)
        const result = sortQueuedMessages([sched2, im2, sched1, im1])
        expect(result.map((m) => m.id)).toEqual(['im1', 'im2', 'sched-near', 'sched-far'])
    })
})

describe('getQueuedMessagePreview', () => {
    it('keeps attachment names with a text prompt', () => {
        const message = {
            id: 'queued-with-image',
            localId: 'queued-with-image',
            createdAt: 1000,
            seq: null,
            invokedAt: null,
            status: 'queued',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Analyze this screenshot',
                    attachments: [{
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                },
            },
        } as unknown as DecryptedMessage

        expect(getQueuedMessagePreview(message)).toEqual({
            text: 'Analyze this screenshot',
            attachmentNames: ['image.png'],
        })
    })

    it('uses attachment names for attachment-only queued messages', () => {
        const message = {
            id: 'queued-image-only',
            localId: 'queued-image-only',
            createdAt: 1000,
            seq: null,
            invokedAt: null,
            status: 'queued',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: '',
                    attachments: [{
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                },
            },
        } as unknown as DecryptedMessage

        expect(getQueuedMessagePreview(message)).toEqual({
            text: '',
            attachmentNames: ['image.png'],
        })
    })
})

describe('getQueuedMessageEditText', () => {
    it('keeps the prompt text when queued message has both text and attachments', () => {
        expect(getQueuedMessageEditText({
            text: 'Analyze this screenshot',
            attachmentNames: ['image.png'],
        })).toBe('Analyze this screenshot')
    })

    it('falls back to attachment names for attachment-only queued messages', () => {
        expect(getQueuedMessageEditText({
            text: '',
            attachmentNames: ['image.png', 'trace.log'],
        })).toBe('image.png, trace.log')
    })
})

// ---------------------------------------------------------------------------
// formatScheduledTime — cross-year support (#8)
// ---------------------------------------------------------------------------

describe('formatScheduledTime', () => {
    it('omits year for a date in the current year', () => {
        const now = new Date()
        // Use a date 1 month ahead in the same year, guarding against Dec edge case
        const sameYearDate = new Date(now.getFullYear(), now.getMonth() + 1 < 12 ? now.getMonth() + 1 : 0, 15, 10, 30)
        if (sameYearDate.getFullYear() !== now.getFullYear()) {
            // Wrapped to next year — skip (edge case in late December)
            return
        }
        const result = formatScheduledTime(sameYearDate.getTime())
        // Year digits should not appear
        expect(result).not.toContain(String(now.getFullYear()))
    })

    it('includes year for a date in a different year', () => {
        const nextYear = new Date().getFullYear() + 1
        const crossYearDate = new Date(nextYear, 0, 15, 10, 30) // Jan 15 next year
        const result = formatScheduledTime(crossYearDate.getTime())
        expect(result).toContain(String(nextYear))
    })
})

describe('QueuedMessagesBar steer action', () => {
    // The real useSteerQueuedMessage hook runs here (only the cancel hook is
    // module-mocked); pass a fake api whose steerMessage resolves on demand.
    function renderSteerable(canSteer = true) {
        mocks.steerMessage.mockImplementation(() => new Promise((resolve) => {
            mocks.resolveSteer = resolve
        }))
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        const view = renderQueuedMessage(null, null, 0, canSteer, api)
        return { unmount: view.unmount }
    }

    it('shows the Steer button only when canSteer is set and the row is immediate', () => {
        const immediate = renderSteerable(true)
        expect(screen.getByRole('button', { name: 'Steer queued message' })).toBeTruthy()
        immediate.unmount()

        renderSteerable(false)
        expect(screen.queryByRole('button', { name: 'Steer queued message' })).toBeNull()
    })

    it('hides the Steer button on future-scheduled rows', () => {
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        renderQueuedMessage(Date.now() + 60_000, null, 0, true, api)
        expect(screen.queryByRole('button', { name: 'Steer queued message' })).toBeNull()
    })

    it('calls the steer api with the session and message id', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'Steer queued message' }))

        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalledWith('session-1', 'server-message-id'))
        // Settle the pending mutation so the queued-operation token releases;
        // otherwise the next test would see the session as busy.
        await act(async () => {
            mocks.resolveSteer?.({ status: 'steered', localId: 'local-server-message-id' })
            await Promise.resolve()
        })
    })

    it('toasts when the steer fails and leaves the row queued', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'Steer queued message' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalled())
        await act(async () => {
            mocks.resolveSteer?.({ status: 'failed', error: 'Session is not streaming', localId: 'local-server-message-id' })
            await Promise.resolve()
        })

        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.steerFailed',
            body: 'Session is not streaming',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('does not toast on a successful steer (the consumed event clears the row)', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'Steer queued message' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalled())
        await act(async () => {
            mocks.resolveSteer?.({ status: 'steered', localId: 'local-server-message-id' })
            await Promise.resolve()
        })

        expect(mocks.addToast).not.toHaveBeenCalled()
    })

    it('reconciles a stale queued row when the steer returns invoked (missed consumption SSE)', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'Steer queued message' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalled())
        await act(async () => {
            mocks.resolveSteer?.({
                status: 'invoked',
                message: { localId: 'local-server-message-id', invokedAt: 5_000 },
            })
            await Promise.resolve()
        })

        expect(mocks.markMessagesConsumed).toHaveBeenCalledWith(
            'session-1',
            ['local-server-message-id'],
            5_000,
        )
        expect(mocks.addToast).not.toHaveBeenCalled()
    })
})
