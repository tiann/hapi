import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type {
    OpenClawApprovalRequest,
    OpenClawMessage,
    OpenClawSyncEvent,
    OpenClawState
} from '@hapi/protocol/types'
import type {
    OpenClawMessagesResponse,
    OpenClawStateResponse
} from '@/types/api'
import {
    applyOpenClawApprovalRequestEvent,
    applyOpenClawApprovalResolvedEvent,
    applyOpenClawMessageEvent,
    applyOpenClawSyncEvent,
    applyOpenClawStateEvent
} from './openclawSseCache'
import { queryKeys } from '@/lib/query-keys'

function makeMessage(id: string, overrides: Partial<OpenClawMessage> = {}): OpenClawMessage {
    return {
        id,
        conversationId: 'conv-1',
        role: 'assistant',
        text: `message ${id}`,
        createdAt: 1,
        status: 'streaming',
        ...overrides
    }
}

function makeMessagesResponse(messages: OpenClawMessage[]): OpenClawMessagesResponse {
    return {
        messages,
        page: {
            limit: 50,
            beforeSeq: null,
            nextBeforeSeq: null,
            hasMore: false
        }
    }
}

function makeApproval(id: string): OpenClawApprovalRequest {
    return {
        id,
        conversationId: 'conv-1',
        title: `Approval ${id}`,
        status: 'pending',
        createdAt: 1
    }
}

function makeState(overrides: Partial<OpenClawState> = {}): OpenClawState {
    return {
        conversationId: 'conv-1',
        connected: true,
        thinking: false,
        lastError: null,
        pendingApprovals: [],
        ...overrides
    }
}

describe('applyOpenClawMessageEvent', () => {
    it('upserts messages without invalidating the query', () => {
        const previous = makeMessagesResponse([makeMessage('msg-1', { text: 'partial' })])

        const next = applyOpenClawMessageEvent(previous, makeMessage('msg-1', {
            text: 'partial and more',
            status: 'completed'
        }))

        expect(next.messages).toHaveLength(1)
        expect(next.messages[0]?.text).toBe('partial and more')
        expect(next.messages[0]?.status).toBe('completed')
    })

    it('creates a minimal cache payload when the query has not loaded yet', () => {
        const next = applyOpenClawMessageEvent(undefined, makeMessage('msg-1'))

        expect(next.messages).toHaveLength(1)
        expect(next.page.limit).toBe(50)
    })
})

describe('applyOpenClawStateEvent', () => {
    it('replaces the cached state with the SSE payload', () => {
        const state = makeState({ thinking: true })

        expect(applyOpenClawStateEvent(undefined, state)).toEqual({ state })
    })
})

describe('approval state patch helpers', () => {
    it('adds pending approvals directly into cached state', () => {
        const previous: OpenClawStateResponse = {
            state: makeState()
        }

        const next = applyOpenClawApprovalRequestEvent(previous, makeApproval('req-1'))

        expect(next?.state.pendingApprovals).toHaveLength(1)
        expect(next?.state.pendingApprovals?.[0]?.id).toBe('req-1')
    })

    it('removes resolved approvals from cached state', () => {
        const previous: OpenClawStateResponse = {
            state: makeState({
                pendingApprovals: [makeApproval('req-1'), makeApproval('req-2')]
            })
        }

        const next = applyOpenClawApprovalResolvedEvent(previous, 'req-1', 'approved')

        expect(next?.state.pendingApprovals).toHaveLength(1)
        expect(next?.state.pendingApprovals?.[0]?.id).toBe('req-2')
    })
})

describe('applyOpenClawSyncEvent', () => {
    it('patches and revalidates message queries after an SSE message update', async () => {
        const queryClient = new QueryClient()
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
        const existing = makeMessagesResponse([makeMessage('msg-1', { text: 'partial' })])
        queryClient.setQueryData(queryKeys.openclawMessages('conv-1'), existing)

        const event: OpenClawSyncEvent = {
            type: 'openclaw-message',
            conversationId: 'conv-1',
            message: makeMessage('msg-1', {
                text: 'partial and more',
                status: 'completed'
            })
        }

        applyOpenClawSyncEvent(queryClient, event)

        const next = queryClient.getQueryData<OpenClawMessagesResponse>(queryKeys.openclawMessages('conv-1'))
        expect(next?.messages[0]?.text).toBe('partial and more')
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.openclawMessages('conv-1') })
    })

    it('revalidates state queries after approval events', async () => {
        const queryClient = new QueryClient()
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
        queryClient.setQueryData<OpenClawStateResponse>(queryKeys.openclawState('conv-1'), {
            state: makeState()
        })

        const event: OpenClawSyncEvent = {
            type: 'openclaw-approval-request',
            conversationId: 'conv-1',
            request: makeApproval('req-1')
        }

        applyOpenClawSyncEvent(queryClient, event)

        const next = queryClient.getQueryData<OpenClawStateResponse>(queryKeys.openclawState('conv-1'))
        expect(next?.state.pendingApprovals?.[0]?.id).toBe('req-1')
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.openclawState('conv-1') })
    })
})
