import { describe, expect, it } from 'vitest'
import {
    SESSION_JOB_INSTRUCTION,
    withSessionJobInstruction
} from './sessionJobInstruction'

describe('sessionJobInstruction', () => {
    it('prefers job run supervisor and forbids fake percent', () => {
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job run')
        expect(SESSION_JOB_INSTRUCTION).toContain('hapi job update')
        expect(SESSION_JOB_INSTRUCTION).toContain('idle agent cannot')
        expect(SESSION_JOB_INSTRUCTION).toContain('Never invent a fake percent')
        expect(SESSION_JOB_INSTRUCTION).toContain('HAPI_SESSION_ID')
    })

    it('appends after an existing prompt block', () => {
        expect(withSessionJobInstruction('Base.')).toBe(`Base.\n\n${SESSION_JOB_INSTRUCTION}`)
        expect(withSessionJobInstruction('')).toBe(SESSION_JOB_INSTRUCTION)
    })
})
