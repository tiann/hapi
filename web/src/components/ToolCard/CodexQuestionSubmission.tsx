import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AgentState } from '@/types/api'
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
    prune: (sessionId: string, requests: AgentState['requests']) => void
} | null>(null)

export function CodexQuestionSubmissionProvider({ children }: { children: ReactNode }) {
    const [sessions, setSessions] = useState<ReadonlyMap<string, SessionSubmissions>>(() => new Map())
    const record = useCallback((sessionId: string, id: string, instanceId: string, submission: CodexQuestionSubmission) => {
        const key = receiptKey(id, instanceId)
        setSessions(current => {
            const receipts = current.get(sessionId)
            const previous = receipts?.get(key)?.submission
            if (submission.status === 'missing' && previous && previous.status !== 'missing') return current

            const next = new Map(receipts).set(key, { requestId: id, instanceId, submission })
            return new Map(current).set(sessionId, next)
        })
    }, [])
    const prune = useCallback((sessionId: string, requests: AgentState['requests']) => {
        setSessions(current => {
            const submissions = current.get(sessionId)
            if (!submissions) return current
            const remaining = new Map([...submissions].filter(([, receipt]) => requests?.[receipt.requestId]?.instanceId === receipt.instanceId))
            if (remaining.size === submissions.size) return current
            const next = new Map(current)
            if (remaining.size) next.set(sessionId, remaining)
            else next.delete(sessionId)
            return next
        })
    }, [])
    return <SubmissionContext.Provider value={{ sessions, record, prune }}>{children}</SubmissionContext.Provider>
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

export function usePruneCodexQuestionSubmissions(sessionId: string, agentState: AgentState | null | undefined) {
    const context = useContext(SubmissionContext)
    const submissions = context?.sessions.get(sessionId)
    const prune = context?.prune
    useEffect(() => {
        if (submissions && agentState) prune?.(sessionId, agentState.requests)
    }, [agentState, prune, sessionId, submissions])
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
