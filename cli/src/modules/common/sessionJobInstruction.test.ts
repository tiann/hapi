import { describe, expect, it } from 'vitest'
import {
    SESSION_JOB_INSTRUCTION,
    withSessionJobInstruction
} from './sessionJobInstruction'

describe('sessionJobInstruction', () => {
    it('prefers MCP session_job + job run supervisor and forbids fake percent', () => {
        expect(SESSION_JOB_INSTRUCTION).toContain('session_job')
        expect(SESSION_JOB_INSTRUCTION).toContain('ping_peer')
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job run')
        expect(SESSION_JOB_INSTRUCTION).toContain('idle agents cannot')
        expect(SESSION_JOB_INSTRUCTION).toContain('Never invent a fake percent')
        expect(SESSION_JOB_INSTRUCTION).toContain('HAPI_SESSION_ID')
    })

    it('appends after an existing prompt block', () => {
        expect(withSessionJobInstruction('Base.')).toBe(`Base.\n\n${SESSION_JOB_INSTRUCTION}`)
        expect(withSessionJobInstruction('')).toBe(SESSION_JOB_INSTRUCTION)
    })
})
