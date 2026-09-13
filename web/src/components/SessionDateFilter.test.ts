import { describe, expect, it } from 'vitest'
import { getSessionDatePickerPosition } from './SessionDateFilter'

describe('getSessionDatePickerPosition', () => {
    it('keeps the picker inside the viewport and below the menu item when space allows', () => {
        expect(getSessionDatePickerPosition(
            { top: 100, bottom: 132, right: 380 },
            { width: 288, height: 360 },
            { width: 400, height: 800 }
        )).toEqual({
            top: 140,
            left: 92,
            width: 288,
            maxHeight: 360
        })
    })

    it('opens above the menu item when the remaining space below is too small', () => {
        expect(getSessionDatePickerPosition(
            { top: 650, bottom: 682, right: 380 },
            { width: 288, height: 360 },
            { width: 400, height: 800 }
        )).toEqual({
            top: 282,
            left: 92,
            width: 288,
            maxHeight: 360
        })
    })

    it('shrinks and clamps the picker for a narrow viewport', () => {
        expect(getSessionDatePickerPosition(
            { top: 100, bottom: 132, right: 40 },
            { width: 288, height: 720 },
            { width: 240, height: 400 }
        )).toEqual({
            top: 8,
            left: 8,
            width: 224,
            maxHeight: 384
        })
    })

    it('centers the picker on the session list instead of the filter row', () => {
        expect(getSessionDatePickerPosition(
            { top: 100, bottom: 132, right: 380, center: 200 },
            { width: 288, height: 360 },
            { width: 800, height: 800 }
        )).toEqual({
            top: 140,
            left: 56,
            width: 288,
            maxHeight: 360
        })
    })

    it('keeps the session-list-centered picker inside narrow viewport edges', () => {
        expect(getSessionDatePickerPosition(
            { top: 100, bottom: 132, right: 380, center: 50 },
            { width: 288, height: 360 },
            { width: 400, height: 800 }
        ).left).toBe(8)
    })

    it('falls back to the date row when no session-list center is provided', () => {
        expect(getSessionDatePickerPosition(
            { top: 100, bottom: 132, right: 380 },
            { width: 288, height: 360 },
            { width: 400, height: 800 }
        ).left).toBe(92)
    })
})
