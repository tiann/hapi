import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import type { AgentState } from '@/types/api'
import {
    CodexQuestionSubmissionProvider,
    type CodexQuestionSubmission,
    getCodexQuestionSubmission,
    useCodexQuestionSubmission
} from './CodexQuestionSubmission'

const state = (instanceId: string): AgentState => ({
    requests: { question: { tool: 'request_user_input', arguments: {}, instanceId } }
})

function setup(instanceId: string) {
    const client = createQueryClient()
    const key = queryKeys.session('session')
    let agentStateVersion = 0
    const write = (agentState: AgentState | null) =>
        client.setQueryData(key, { session: { id: 'session', agentStateVersion: ++agentStateVersion, agentState } })
    write(state(instanceId))
    const { result } = renderHook(() => useCodexQuestionSubmission('session'), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}><CodexQuestionSubmissionProvider>{children}</CodexQuestionSubmissionProvider></QueryClientProvider>
        )
    })
    return {
        write,
        record: (submission: CodexQuestionSubmission) => result.current.record!('session', 'question', instanceId, submission),
        lookup: (id = instanceId) => getCodexQuestionSubmission(result.current.submissions, 'question', id)
    }
}

it('matches the issuance both before pruning and when pruning a replaced request', () => {
    const { record, write, lookup } = setup('original')
    const receipt: CodexQuestionSubmission = { status: 'answered', answers: { q: { answers: ['Web'] } } }
    act(() => record(receipt))
    expect(lookup()).toEqual(receipt)
    expect(lookup('replacement')).toBeUndefined()

    act(() => { write(state('replacement')) })
    expect(lookup()).toBeUndefined()
})

it('reconciles a cached session update without mounting a chat', () => {
    const { record, write, lookup } = setup('issuance')
    act(() => record({ status: 'dismissed' }))
    act(() => { write(null) })
    expect(lookup()).toEqual({ status: 'dismissed' })
    act(() => { write({}) })
    expect(lookup()).toBeUndefined()
    act(() => record({ status: 'dismissed' }))
    expect(lookup()).toBeUndefined()
})

it('retains an accepted dismissal when the same issuance returns missing later', () => {
    const { record, lookup } = setup('issuance')
    act(() => {
        record({ status: 'dismissed' })
        record({ status: 'missing' })
    })
    expect(lookup()).toEqual({ status: 'dismissed' })
})
