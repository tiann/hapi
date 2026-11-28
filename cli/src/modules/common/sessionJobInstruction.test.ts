import { describe, expect, it } from 'vitest'
import {
    SESSION_JOB_INSTRUCTION,
    withSessionJobInstruction
} from './sessionJobInstruction'

describe('sessionJobInstruction', () => {
    it('defaults to not attaching and points at the full rules', () => {
        expect(SESSION_JOB_INSTRUCTION).toMatch(/default is NOT/)
        expect(SESSION_JOB_INSTRUCTION).toMatch(/never tests or builds/)
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job run')
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job --help')
        expect(SESSION_JOB_INSTRUCTION).not.toMatch(/REQUIRED|MUST|FORBIDDEN/)
    })

    it('stays small', () => {
        expect(SESSION_JOB_INSTRUCTION.length).toBeLessThanOrEqual(200)
    })

    it('appends after an existing prompt block', () => {
        expect(withSessionJobInstruction('Base.')).toBe(`Base.\n\n${SESSION_JOB_INSTRUCTION}`)
        expect(withSessionJobInstruction('')).toBe(SESSION_JOB_INSTRUCTION)
    })
})
