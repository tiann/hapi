import { describe, expect, it } from 'vitest'
import {
    SESSION_JOB_INSTRUCTION,
    withSessionJobInstruction
} from './sessionJobInstruction'

describe('sessionJobInstruction', () => {
    it('defaults to not attaching and names short work as excluded', () => {
        expect(SESSION_JOB_INSTRUCTION).toMatch(/default is NOT/)
        expect(SESSION_JOB_INSTRUCTION).toMatch(/within this turn/)
        expect(SESSION_JOB_INSTRUCTION).toMatch(/If unsure, do not attach/)
        expect(SESSION_JOB_INSTRUCTION).not.toMatch(/REQUIRED|MUST|FORBIDDEN/)
    })

    it('shows the run command and keeps wake opt-in', () => {
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job run')
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job --help')
        expect(SESSION_JOB_INSTRUCTION).toMatch(/--wake-on-terminal unless the operator asked/)
    })

    it('stays small', () => {
        expect(SESSION_JOB_INSTRUCTION.length).toBeLessThan(900)
    })

    it('appends after an existing prompt block', () => {
        expect(withSessionJobInstruction('Base.')).toBe(`Base.\n\n${SESSION_JOB_INSTRUCTION}`)
        expect(withSessionJobInstruction('')).toBe(SESSION_JOB_INSTRUCTION)
    })
})
