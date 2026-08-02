import { describe, expect, it } from 'vitest'
import { migrateSuppressedSendError } from './suppressed-send-error'

type ErrorRecord = { id: number; restoreSuppressed: boolean; label: string }

const suppressed: ErrorRecord = { id: 1, restoreSuppressed: true, label: 'retry A' }
const ordinary: ErrorRecord = { id: 2, restoreSuppressed: false, label: 'ordinary A' }

describe('migrateSuppressedSendError', () => {
    it('moves a suppressed retry record from source to resolved session', () => {
        expect(migrateSuppressedSendError({ A: suppressed }, 'A', 'B')).toEqual({ B: suppressed })
    })

    it('does not move an unsuppressed record', () => {
        const errors = { A: ordinary }
        expect(migrateSuppressedSendError(errors, 'A', 'B')).toBe(errors)
    })

    it('is a no-op when source and resolved session are the same', () => {
        const errors = { A: suppressed }
        expect(migrateSuppressedSendError(errors, 'A', 'A')).toBe(errors)
    })

    it('supersedes a stale target record with the in-flight suppressed retry', () => {
        const target: ErrorRecord = { id: 99, restoreSuppressed: true, label: 'stale B' }
        expect(migrateSuppressedSendError({ A: suppressed, B: target }, 'A', 'B')).toEqual({ B: suppressed })
    })
})
