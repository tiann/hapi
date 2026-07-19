import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'

vi.mock('./message-window-store', () => ({
    fetchLatestMessages: vi.fn(),
    getQueuedReconcileCandidateLocalIds: vi.fn(),
    markMessagesConsumed: vi.fn(),
    reconcileQueuedLocalIds: vi.fn(),
}))

import {
    fetchLatestMessages,
    getQueuedReconcileCandidateLocalIds,
    markMessagesConsumed,
    reconcileQueuedLocalIds,
} from './message-window-store'
import { reconcileQueuedStateAfterConnect } from './queued-state-reconciliation'

const mockFetchLatestMessages = vi.mocked(fetchLatestMessages)
const mockGetCandidates = vi.mocked(getQueuedReconcileCandidateLocalIds)
const mockMarkMessagesConsumed = vi.mocked(markMessagesConsumed)
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
        mockFetchLatestMessages.mockResolvedValue(undefined)
        mockGetCandidates.mockReturnValue([])
    })

    it('waits for the latest messages before snapshotting and querying queued state', async () => {
        let resolveRefresh: (() => void) | undefined
        mockFetchLatestMessages.mockImplementationOnce(
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
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-B',
            candidateLocalIds,
            ['local-2'],
        )
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
