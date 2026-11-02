import { afterEach, describe, expect, it } from 'vitest'
import {
    applyHubSessionSummaryContract,
    buildSessionSummaryInstruction,
    isSessionSummaryContractEnabled,
    resetSessionSummaryContractForTests,
    SESSION_SUMMARY_CONTRACT_LINE,
    sessionSummaryInstructionOrEmpty,
    withSessionSummaryInstruction
} from './sessionSummaryInstruction'

const USER_LANGUAGE_INSTRUCTION = [
    'Use the language used by the user in the current conversation for the',
    'human-readable "action" and "summary" values.'
].join('\n')

describe('sessionSummaryInstruction', () => {
    afterEach(() => {
        resetSessionSummaryContractForTests()
    })

    it('is disabled by default (upstream opt-in)', () => {
        expect(isSessionSummaryContractEnabled({})).toBe(false)
        expect(isSessionSummaryContractEnabled({ HAPI_SESSION_SUMMARY_CONTRACT: '' })).toBe(false)
        expect(sessionSummaryInstructionOrEmpty({})).toBe('')
    })

    it('enables when hub preference is applied', () => {
        applyHubSessionSummaryContract(true)
        expect(isSessionSummaryContractEnabled({})).toBe(true)
        expect(sessionSummaryInstructionOrEmpty({})).toContain(SESSION_SUMMARY_CONTRACT_LINE)

        applyHubSessionSummaryContract(false)
        expect(isSessionSummaryContractEnabled({})).toBe(false)
    })

    it('lets explicit env override hub preference', () => {
        applyHubSessionSummaryContract(true)
        expect(isSessionSummaryContractEnabled({ HAPI_SESSION_SUMMARY_CONTRACT: '0' })).toBe(false)
        applyHubSessionSummaryContract(false)
        expect(isSessionSummaryContractEnabled({ HAPI_SESSION_SUMMARY_CONTRACT: '1' })).toBe(true)
        expect(isSessionSummaryContractEnabled({ HAPI_SESSION_SUMMARY_CONTRACT: 'true' })).toBe(true)
    })

    it('treats common falsy env spellings as off', () => {
        for (const value of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
            expect(isSessionSummaryContractEnabled({ HAPI_SESSION_SUMMARY_CONTRACT: value })).toBe(false)
        }
    })

    it('builds the canonical contract line without surveillance framing', () => {
        const body = buildSessionSummaryInstruction()
        expect(body).toContain(SESSION_SUMMARY_CONTRACT_LINE)
        expect(body.toLowerCase()).toContain('session tracking')
        expect(body.toLowerCase()).not.toContain('overseer')
        expect(body.toLowerCase()).not.toContain('surveillance')
    })

    it('limits summaries to the final answer while preserving language and footer guidance', () => {
        applyHubSessionSummaryContract(true)
        const body = sessionSummaryInstructionOrEmpty({})
        expect(body).toContain('At the end of each turn, append exactly one')
        expect(body).toContain('final answer only')
        expect(body).toContain('Do not emit this line in commentary, progress updates, or before tool calls.')
        expect(body).toContain(USER_LANGUAGE_INSTRUCTION)
        expect(body).not.toContain('End every response')
    })

    it('preserves the exact machine-readable footer format', () => {
        expect(SESSION_SUMMARY_CONTRACT_LINE).toBe(
            'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"<agent-id>","project":"<project>","status":"done|blocked|needs_review|needs_decision|failed|stalled","action":"<=12 words","summary":"one-line triage"}'
        )
    })

    it('appends to an existing base prompt when enabled', () => {
        applyHubSessionSummaryContract(true)
        const out = withSessionSummaryInstruction('Be helpful.', {})
        expect(out.startsWith('Be helpful.')).toBe(true)
        expect(out).toContain(SESSION_SUMMARY_CONTRACT_LINE)
    })

    it('leaves base unchanged when disabled', () => {
        expect(withSessionSummaryInstruction('Be helpful.', {})).toBe('Be helpful.')
        expect(withSessionSummaryInstruction('Be helpful.', { HAPI_SESSION_SUMMARY_CONTRACT: '0' }))
            .toBe('Be helpful.')
    })
})
