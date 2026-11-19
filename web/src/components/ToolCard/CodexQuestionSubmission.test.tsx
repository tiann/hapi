import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { AgentState } from '@/types/api'
import {
    CodexQuestionSubmissionProvider,
    type CodexQuestionSubmission,
    getCodexQuestionSubmission,
    useCodexQuestionSubmission,
    usePruneCodexQuestionSubmissions
} from './CodexQuestionSubmission'

it('matches the issuance both before pruning and when pruning a replaced request', () => {
    const state = (instanceId: string): AgentState => ({
        requests: { question: { tool: 'request_user_input', arguments: {}, instanceId } }
    })
    const { result, rerender } = renderHook((agentState: AgentState) => {
        usePruneCodexQuestionSubmissions('session', agentState)
        return useCodexQuestionSubmission('session')
    }, { initialProps: state('original'), wrapper: CodexQuestionSubmissionProvider })

    const receipt: CodexQuestionSubmission = { status: 'answered', answers: { q: { answers: ['Web'] } } }
    act(() => result.current.record!('session', 'question', 'original', receipt))
    expect(getCodexQuestionSubmission(result.current.submissions, 'question', 'original')).toEqual(receipt)
    expect(getCodexQuestionSubmission(result.current.submissions, 'question', 'replacement')).toBeUndefined()

    rerender(state('replacement'))
    expect(getCodexQuestionSubmission(result.current.submissions, 'question', 'original')).toBeUndefined()
})
