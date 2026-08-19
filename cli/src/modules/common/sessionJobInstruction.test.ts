import { describe, expect, it } from 'vitest'
import {
    SESSION_JOB_INSTRUCTION,
    withSessionJobInstruction
} from './sessionJobInstruction'

describe('sessionJobInstruction', () => {
    it('requires job run and forbids MCP set / fake percent', () => {
        expect(SESSION_JOB_INSTRUCTION).toContain('session_job')
        expect(SESSION_JOB_INSTRUCTION).toContain('ping_peer')
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job run')
        expect(SESSION_JOB_INSTRUCTION).toContain('idle agents cannot')
        expect(SESSION_JOB_INSTRUCTION).toMatch(/action=set \(refused\)/)
        expect(SESSION_JOB_INSTRUCTION).toContain('Never invent a fake percent')
        expect(SESSION_JOB_INSTRUCTION).toContain('HAPI_SESSION_ID')
        expect(SESSION_JOB_INSTRUCTION).toMatch(/operator chat URL uuid|URL uuid explicitly/i)
    })

    it('appends after an existing prompt block', () => {
        expect(withSessionJobInstruction('Base.')).toBe(`Base.\n\n${SESSION_JOB_INSTRUCTION}`)
        expect(withSessionJobInstruction('')).toBe(SESSION_JOB_INSTRUCTION)
    })
})
