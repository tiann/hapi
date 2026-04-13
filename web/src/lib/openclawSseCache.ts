import type { QueryClient } from '@tanstack/react-query'
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
import { queryKeys } from '@/lib/query-keys'

const DEFAULT_OPENCLAW_PAGE_LIMIT = 50

export function applyOpenClawMessageEvent(
    previous: OpenClawMessagesResponse | undefined,
    message: OpenClawMessage
): OpenClawMessagesResponse {
    if (!previous) {
        return {
            messages: [message],
            page: {
                limit: DEFAULT_OPENCLAW_PAGE_LIMIT,
                beforeSeq: null,
                nextBeforeSeq: null,
                hasMore: false
            }
        }
    }

    const existingIndex = previous.messages.findIndex((item) => item.id === message.id)
    if (existingIndex < 0) {
        return {
            ...previous,
            messages: [...previous.messages, message]
        }
    }

    if (previous.messages[existingIndex] === message) {
        return previous
    }

    const nextMessages = previous.messages.slice()
    nextMessages[existingIndex] = message
    return {
        ...previous,
        messages: nextMessages
    }
}

export function applyOpenClawStateEvent(
    _previous: OpenClawStateResponse | undefined,
    state: OpenClawState
): OpenClawStateResponse {
    return { state }
}

function upsertApproval(
    approvals: OpenClawApprovalRequest[],
    request: OpenClawApprovalRequest
): OpenClawApprovalRequest[] {
    const existingIndex = approvals.findIndex((item) => item.id === request.id)
    if (existingIndex < 0) {
        return [...approvals, request]
    }

    const nextApprovals = approvals.slice()
    nextApprovals[existingIndex] = request
    return nextApprovals
}

export function applyOpenClawApprovalRequestEvent(
    previous: OpenClawStateResponse | undefined,
    request: OpenClawApprovalRequest
): OpenClawStateResponse | undefined {
    if (!previous?.state) {
        return previous
    }

    return {
        state: {
            ...previous.state,
            pendingApprovals: upsertApproval(previous.state.pendingApprovals ?? [], request)
        }
    }
}

export function applyOpenClawApprovalResolvedEvent(
    previous: OpenClawStateResponse | undefined,
    requestId: string,
    _status: 'approved' | 'denied'
): OpenClawStateResponse | undefined {
    if (!previous?.state?.pendingApprovals) {
        return previous
    }

    return {
        state: {
            ...previous.state,
            pendingApprovals: previous.state.pendingApprovals.filter((item) => item.id !== requestId)
        }
    }
}

export function applyOpenClawSyncEvent(queryClient: QueryClient, event: OpenClawSyncEvent): void {
    if (event.type === 'openclaw-message') {
        queryClient.setQueryData<OpenClawMessagesResponse | undefined>(
            queryKeys.openclawMessages(event.conversationId),
            (previous) => applyOpenClawMessageEvent(previous, event.message)
        )
        void queryClient.invalidateQueries({ queryKey: queryKeys.openclawMessages(event.conversationId) })
        return
    }

    if (event.type === 'openclaw-state') {
        queryClient.setQueryData<OpenClawStateResponse | undefined>(
            queryKeys.openclawState(event.conversationId),
            (previous) => applyOpenClawStateEvent(previous, event.state)
        )
        void queryClient.invalidateQueries({ queryKey: queryKeys.openclawState(event.conversationId) })
        return
    }

    if (event.type === 'openclaw-approval-request') {
        queryClient.setQueryData<OpenClawStateResponse | undefined>(
            queryKeys.openclawState(event.conversationId),
            (previous) => applyOpenClawApprovalRequestEvent(previous, event.request)
        )
        void queryClient.invalidateQueries({ queryKey: queryKeys.openclawState(event.conversationId) })
        return
    }

    queryClient.setQueryData<OpenClawStateResponse | undefined>(
        queryKeys.openclawState(event.conversationId),
        (previous) => applyOpenClawApprovalResolvedEvent(previous, event.requestId, event.status)
    )
    void queryClient.invalidateQueries({ queryKey: queryKeys.openclawState(event.conversationId) })
}
