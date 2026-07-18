import { describe, expect, it } from 'vitest'
import { shouldEnterInsertNewline } from './composerEnterBehavior'

describe('shouldEnterInsertNewline', () => {
    it('inserts a newline when Shift is held (desktop convention)', () => {
        expect(shouldEnterInsertNewline({ shiftKey: true, isTouch: false })).toBe(true)
    })

    it('sends on bare Enter when on a non-touch device', () => {
        expect(shouldEnterInsertNewline({ shiftKey: false, isTouch: false })).toBe(false)
    })

    it('inserts a newline on bare Enter on touch devices (iOS soft keyboards cannot emit Shift+Enter)', () => {
        expect(shouldEnterInsertNewline({ shiftKey: false, isTouch: true })).toBe(true)
    })

    it('inserts a newline when both Shift and touch are present', () => {
        expect(shouldEnterInsertNewline({ shiftKey: true, isTouch: true })).toBe(true)
    })
})
