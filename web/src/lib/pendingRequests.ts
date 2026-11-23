import {
    classifyKind,
    type AgentStateRequest,
    type PendingRequestKind
} from '@hapi/protocol'
import type { AgentState } from '@/types/api'

export type PendingRequestEntry = {
    id: string
    tool: string
    kind: PendingRequestKind
    createdAt: number
    arguments: unknown
}

/** Pending requests in the order they arrived, with a stable id tie-breaker. */
export function getPendingRequestEntries(
    requests: AgentState['requests'] | null | undefined
): PendingRequestEntry[] {
    return Object.entries(requests ?? {})
        .map(([id, request]) => ({
            id,
            tool: request.tool,
            kind: classifyKind(request.tool),
            createdAt: request.createdAt ?? 0,
            arguments: request.arguments,
        }))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

export function getPendingRequestStatusText(
    requests: readonly PendingRequestEntry[],
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    if (requests.length === 0) return null
    if (requests.length === 1) {
        return requests[0]!.kind === 'input'
            ? t('misc.inputRequired')
            : t('misc.permissionRequired')
    }
    return t('misc.pendingRequests', { count: requests.length })
}

export type PendingRequestNavigationTarget =
    | { kind: 'async' }
    | { kind: 'message'; messageId: string }

/** Replies use the request key; transcript navigation uses the correlated tool id. */
export function getPendingRequestReferenceId(requestId: string, request: AgentStateRequest): string {
    return request.toolCallId?.trim() || requestId
}

/** Choose the live question panel for async input, otherwise the correlated tool card. */
export function getPendingRequestNavigationTarget(
    requestId: string,
    request: AgentStateRequest,
    isAsyncInput: boolean
): PendingRequestNavigationTarget {
    if (isAsyncInput) return { kind: 'async' }
    return {
        kind: 'message',
        messageId: `tool-call:${getPendingRequestReferenceId(requestId, request)}`,
    }
}
export type PendingRequestDetail = {
    text: string
    moreCount: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Human-readable secondary line for a pending request. Full text remains
 * available to callers as a title; the popover truncates it to one line. */
export function getPendingRequestDetail(request: PendingRequestEntry): PendingRequestDetail {
    const args = asRecord(request.arguments)

    if (request.kind === 'input') {
        const questions = Array.isArray(args?.questions) ? args.questions : []
        const firstQuestion = asRecord(questions[0])
        const text = nonEmptyString(firstQuestion?.question)
            ?? nonEmptyString(firstQuestion?.prompt)
            ?? nonEmptyString(firstQuestion?.header)
            ?? nonEmptyString(args?.question)
            ?? nonEmptyString(args?.prompt)
        if (text) {
            return { text, moreCount: Math.max(0, questions.length - 1) }
        }
    }

    const text = nonEmptyString(args?.command)
        ?? nonEmptyString(args?.description)
        ?? nonEmptyString(args?.path)
        ?? nonEmptyString(args?.file_path)
        ?? request.tool
    return { text, moreCount: 0 }
}