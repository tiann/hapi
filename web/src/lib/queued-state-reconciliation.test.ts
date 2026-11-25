import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'

vi.mock('./message-window-store', () => ({
    getMessageWindowState: vi.fn(() => ({ messages: [] })),
    markMessagesDispatching: vi.fn(),
    getQueuedReconcileCandidateLocalIds: vi.fn(),
    markMessagesConsumed: vi.fn(),
    markMessagesIndeterminate: vi.fn(),
    markMessagesRequeued: vi.fn(),
    reconcileQueuedLocalIds: vi.fn(),
    syncTailMessages: vi.fn(),
}))

import {
    getMessageWindowState,
    markMessagesDispatching,
    getQueuedReconcileCandidateLocalIds,
    markMessagesConsumed,
    markMessagesIndeterminate,
    markMessagesRequeued,
    reconcileQueuedLocalIds,
    syncTailMessages,
} from './message-window-store'
import { reconcileQueuedStateAfterConnect } from './queued-state-reconciliation'

const mockSyncTailMessages = vi.mocked(syncTailMessages)
const mockGetCandidates = vi.mocked(getQueuedReconcileCandidateLocalIds)
const mockMarkMessagesConsumed = vi.mocked(markMessagesConsumed)
const mockMarkMessagesIndeterminate = vi.mocked(markMessagesIndeterminate)
const mockMarkMessagesRequeued = vi.mocked(markMessagesRequeued)
const mockReconcileQueuedLocalIds = vi.mocked(reconcileQueuedLocalIds)

function createMockApi(
    getQueuedState: ApiClient['getQueuedState'] = async () => ({
        queuedLocalIds: [],
        invokedLocalMessages: []
    })
): ApiClient {
    return { getQueuedState } as ApiClient
}

describe('reconcileQueuedStateAfterConnect', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockSyncTailMessages.mockResolvedValue(undefined)
        mockGetCandidates.mockReturnValue([])
        mockMarkMessagesIndeterminate.mockClear()
        vi.mocked(markMessagesDispatching).mockClear()
        vi.mocked(getMessageWindowState).mockReturnValue({ messages: [] } as unknown as ReturnType<typeof getMessageWindowState>)
    })

    it('waits for the latest messages before snapshotting and querying queued state', async () => {
        let resolveRefresh: (() => void) | undefined
        mockSyncTailMessages.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                resolveRefresh = resolve
            })
        )
        mockGetCandidates.mockReturnValueOnce(['local-1'])
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: ['local-1'],
            invokedLocalMessages: []
        }))

        const reconciliation = reconcileQueuedStateAfterConnect(
            createMockApi(getQueuedState),
            'session-A'
        )
        await Promise.resolve()

        expect(mockGetCandidates).not.toHaveBeenCalled()
        expect(getQueuedState).not.toHaveBeenCalled()

        resolveRefresh?.()
        await reconciliation

        expect(mockGetCandidates).toHaveBeenCalledWith('session-A')
        expect(mockSyncTailMessages).toHaveBeenCalledWith(
            expect.anything(),
            'session-A',
            { ensureAfterCurrent: true }
        )
        expect(getQueuedState).toHaveBeenCalledWith('session-A', ['local-1'])
    })

    it('passes the exact candidate snapshot to the endpoint and reconciliation', async () => {
        const candidateLocalIds = ['local-1', 'local-2']
        mockGetCandidates.mockReturnValueOnce(candidateLocalIds)
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: []
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-B')

        expect(getQueuedState).toHaveBeenCalledWith('session-B', candidateLocalIds)
        expect(mockMarkMessagesRequeued).toHaveBeenCalledWith('session-B', ['local-2'])
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-B',
            candidateLocalIds,
            ['local-2'],
        )
    })

    it('does not conflate steered and ordinary invocation at the same timestamp', async () => {
        mockGetCandidates.mockReturnValueOnce(['prompt', 'correction'])
        await reconcileQueuedStateAfterConnect(createMockApi(async () => ({
            queuedLocalIds: [],
            invokedLocalMessages: [
                { localId: 'prompt', invokedAt: 1_000 },
                { localId: 'correction', invokedAt: 1_000, steered: true }
            ]
        })), 'session-B')
        expect(mockMarkMessagesConsumed).toHaveBeenCalledWith('session-B', ['prompt'], 1_000)
        expect(mockMarkMessagesConsumed).toHaveBeenCalledWith('session-B', ['correction'], 1_000, true)
    })

    it('applies authoritative invoked timestamps before reconciling absent rows', async () => {
        mockGetCandidates.mockReturnValueOnce(['local-1', 'local-2'])
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: [{ localId: 'local-1', invokedAt: 1_000 }]
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-B')

        expect(mockMarkMessagesConsumed).toHaveBeenCalledWith('session-B', ['local-1'], 1_000)
        expect(mockMarkMessagesConsumed.mock.invocationCallOrder[0]).toBeLessThan(
            mockReconcileQueuedLocalIds.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
        )
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-B',
            ['local-1', 'local-2'],
            ['local-2'],
        )
    })

    it('chunks candidate IDs to stay within the endpoint limit', async () => {
        const candidateLocalIds = Array.from({ length: 1001 }, (_, index) => `local-${index}`)
        mockGetCandidates.mockReturnValueOnce(candidateLocalIds)
        const getQueuedState = vi.fn(async (_sessionId: string, localIds: string[]) => ({
            queuedLocalIds: localIds,
            invokedLocalMessages: []
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-E')

        expect(getQueuedState).toHaveBeenCalledTimes(2)
        expect(getQueuedState.mock.calls[0]?.[1]).toHaveLength(1000)
        expect(getQueuedState.mock.calls[1]?.[1]).toEqual(['local-1000'])
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-E',
            candidateLocalIds,
            candidateLocalIds,
        )
    })

    it('skips the endpoint and reconciliation when there are no candidates', async () => {
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: [],
            invokedLocalMessages: []
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-C')

        expect(getQueuedState).not.toHaveBeenCalled()
        expect(mockReconcileQueuedLocalIds).not.toHaveBeenCalled()
    })

    it('clears a canceled queued row in a stable historical search window', async () => {
        mockGetCandidates.mockReturnValueOnce(['canceled-local'])
        vi.mocked(getMessageWindowState).mockReturnValue({ epoch: 1, requiresLatestReset: true, messages: [] } as unknown as ReturnType<typeof getMessageWindowState>)
        await reconcileQueuedStateAfterConnect(createMockApi(), 'historical-search')
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith('historical-search', ['canceled-local'], [])
    })

    it('ignores queue readback from before the message window was rewound', async () => {
        mockGetCandidates.mockReturnValueOnce(['local-1'])
        const store = vi.mocked(getMessageWindowState)
        store.mockReturnValue({ epoch: 1, messages: [] } as unknown as ReturnType<typeof getMessageWindowState>)
        const api = createMockApi(async () => {
            store.mockReturnValue({ epoch: 2, messages: [] } as unknown as ReturnType<typeof getMessageWindowState>)
            return { queuedLocalIds: [], invokedLocalMessages: [{ localId: 'local-1', invokedAt: 100 }] }
        })
        await reconcileQueuedStateAfterConnect(api, 'rewound')
        expect(mockMarkMessagesConsumed).not.toHaveBeenCalled()
        expect(mockReconcileQueuedLocalIds).not.toHaveBeenCalled()
    })

    it('propagates endpoint failures without reconciling', async () => {
        const endpointError = new Error('queued state unavailable')
        mockGetCandidates.mockReturnValueOnce(['local-1'])
        const getQueuedState = vi.fn(async () => {
            throw endpointError
        })

        await expect(
            reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-D')
        ).rejects.toBe(endpointError)
        expect(mockReconcileQueuedLocalIds).not.toHaveBeenCalled()
    })
})


describe('pending readback reconciliation', () => {
    beforeEach(() => { vi.clearAllMocks(); mockSyncTailMessages.mockResolvedValue(undefined); vi.mocked(getMessageWindowState).mockReturnValue({ messages: [] } as unknown as ReturnType<typeof getMessageWindowState>) })
    it('separates live dispatches from genuine unknown rows while retaining both conservatively', async () => {
        mockGetCandidates.mockReturnValue(['pending', 'unknown'])
        await reconcileQueuedStateAfterConnect(createMockApi(async () => ({ queuedLocalIds: [], indeterminateLocalIds: ['pending', 'unknown'], dispatchingLocalIds: ['pending'], invokedLocalMessages: [] })), 'pending-test')
        expect(markMessagesDispatching).toHaveBeenCalledWith('pending-test', ['pending'])
        expect(mockMarkMessagesIndeterminate).toHaveBeenCalledWith('pending-test', ['unknown'])
    })

    it('does not apply a stale pending snapshot after an SSE state transition', async () => {
        const oldMessage = { localId: 'pending' }
        const changedMessage = { ...oldMessage, deliveryState: 'indeterminate' }
        vi.mocked(getMessageWindowState)
            .mockReturnValueOnce({ messages: [oldMessage] } as unknown as ReturnType<typeof getMessageWindowState>)
            .mockReturnValueOnce({ messages: [changedMessage] } as unknown as ReturnType<typeof getMessageWindowState>)
        mockGetCandidates.mockReturnValue(['pending'])
        await reconcileQueuedStateAfterConnect(createMockApi(async () => ({ queuedLocalIds: [], indeterminateLocalIds: ['pending'], dispatchingLocalIds: ['pending'], invokedLocalMessages: [] })), 'stale-test')
        expect(markMessagesDispatching).toHaveBeenCalledWith('stale-test', [])
    })
})
