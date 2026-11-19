import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { SessionResponse } from '@/types/api'
import type { ChatToolCall } from '@/chat/types'
import type { RequestUserInputAnswers } from './requestUserInput'

export type CodexQuestionSubmission =
    | { status: 'answered'; answers: RequestUserInputAnswers }
    | { status: 'dismissed' }
    | { status: 'missing' }

type Receipt = { requestId: string; instanceId: string; submission: CodexQuestionSubmission }
type SessionSubmissions = Map<string, Receipt>

// Key both parts so a late reply for a superseded issuance cannot overwrite the current one.
function receiptKey(requestId: string, instanceId: string): string {
    return JSON.stringify([requestId, instanceId])
}

const SubmissionContext = createContext<{
    sessions: ReadonlyMap<string, SessionSubmissions>
    record: (sessionId: string, id: string, instanceId: string, submission: CodexQuestionSubmission) => void
} | null>(null)

export function CodexQuestionSubmissionProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient()
    const [sessions, setSessions] = useState<ReadonlyMap<string, SessionSubmissions>>(() => new Map())
    const record = useCallback((sessionId: string, id: string, instanceId: string, submission: CodexQuestionSubmission) => {
        const detail = queryClient.getQueryData<SessionResponse>(queryKeys.session(sessionId))
        if (detail?.session.agentState?.requests?.[id]?.instanceId !== instanceId) return

        const key = receiptKey(id, instanceId)
        setSessions(current => {
            const receipts = current.get(sessionId)
            const previous = receipts?.get(key)?.submission
            if (submission.status === 'missing' && previous && previous.status !== 'missing') return current

            const next = new Map(receipts).set(key, { requestId: id, instanceId, submission })
            return new Map(current).set(sessionId, next)
        })
    }, [queryClient])

    useEffect(() => queryClient.getQueryCache().subscribe(event => {
        const [scope, sessionId, ...rest] = event.query.queryKey
        if (scope !== queryKeys.sessionDetails[0] || typeof sessionId !== 'string' || rest.length) return
        const removed = event.type === 'removed'
        if (!removed && (event.type !== 'updated' || event.action.type !== 'success')) return
        const detail = event.query.state.data as SessionResponse | undefined
        const agentState = detail?.session.agentState
        if (!removed && !agentState) return

        setSessions(current => {
            const receipts = current.get(sessionId)
            if (!receipts) return current
            const remaining = removed ? [] : [...receipts].filter(([, receipt]) =>
                agentState?.requests?.[receipt.requestId]?.instanceId === receipt.instanceId
            )
            if (remaining.length === receipts.size) return current
            const next = new Map(current)
            if (remaining.length) next.set(sessionId, new Map(remaining))
            else next.delete(sessionId)
            return next
        })
    }), [queryClient])

    return <SubmissionContext.Provider value={{ sessions, record }}>{children}</SubmissionContext.Provider>
}

export function useCodexQuestionSubmission(sessionId: string) {
    const context = useContext(SubmissionContext)
    return { submissions: context?.sessions.get(sessionId), record: context?.record }
}

export function getCodexQuestionSubmission(submissions: SessionSubmissions | undefined, id: string, instanceId: string | undefined) {
    return instanceId ? submissions?.get(receiptKey(id, instanceId))?.submission : undefined
}

export function isHiddenCodexQuestionSubmission(status: CodexQuestionSubmission['status'] | undefined): boolean {
    return status === 'dismissed' || status === 'missing'
}

/** Keep the local receipt until agentState stops advertising the request. */
export function applyCodexQuestionSubmission(tool: ChatToolCall, submission: CodexQuestionSubmission): ChatToolCall {
    if (!tool.permission || tool.permission.status !== 'pending') return tool
    if (submission.status === 'missing') return { ...tool, permission: undefined }
    if (submission.status === 'dismissed') {
        return { ...tool, permission: { ...tool.permission, status: 'canceled' } }
    }
    return {
        ...tool,
        permission: { ...tool.permission, status: 'resolved', answers: submission.answers, answerSubmitted: true }
    }
}
