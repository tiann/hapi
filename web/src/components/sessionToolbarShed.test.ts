import { describe, expect, it } from 'vitest'
import { shedToolbarSlots, toolbarActionBudget, TOOLBAR_ICON_PX } from './sessionToolbarShed'

const icon = (id: string, keep: number) => ({ id, keep, widthPx: TOOLBAR_ICON_PX })

describe('shedToolbarSlots', () => {
    const slots = [
        icon('unread', 5),
        icon('mark-all', 7),
        icon('new', 4),
        icon('settings', 6),
        icon('browse', 8)
    ]

    it('keeps every slot when the row has room', () => {
        const result = shedToolbarSlots(slots, 400)
        expect(result.overflowIds).toEqual([])
        expect(result.visibleIds).toEqual(['unread', 'mark-all', 'new', 'settings', 'browse'])
    })

    it('sheds browse, then mark-all, then settings — new stays', () => {
        // More is the same width as an icon, so shedding one control does
        // not free a slot. Three survivors + More is the first fit.
        const threePlusMore = 40 * 3 + 40 + 4 * 3
        const tight = shedToolbarSlots(slots, threePlusMore)
        expect(tight.visibleIds).toEqual(['unread', 'new', 'settings'])
        expect(tight.overflowIds).toEqual(['mark-all', 'browse'])

        const twoPlusMore = 40 * 2 + 40 + 4 * 2
        const tighter = shedToolbarSlots(slots, twoPlusMore)
        expect(tighter.visibleIds).toEqual(['unread', 'new'])
        expect(tighter.overflowIds).toEqual(['mark-all', 'settings', 'browse'])
    })

    it('uses the measured More width and gap instead of 16px constants', () => {
        const slots = [icon('new', 4), icon('filter', 5), icon('browse', 8)]
        // 130px fits all three icons at a 4px gap (128) but not at a 5.2px gap
        // (130.4), and a 47px More cannot replace one of them either.
        const atScale = shedToolbarSlots(slots, 130, { morePx: 47, gapPx: 5.2 })
        expect(atScale.visibleIds).toEqual(['new'])
        expect(atScale.overflowIds).toEqual(['filter', 'browse'])
        const atDefault = shedToolbarSlots(slots, 130, { morePx: 40, gapPx: 4 })
        expect(atDefault.visibleIds).toEqual(['new', 'filter', 'browse'])
        expect(atDefault.overflowIds).toEqual([])
    })

    it('drops new only after the lower-priority controls are already in More', () => {
        // New + More. A single equal-width icon cannot be swapped for More
        // without also shedding the next one — More occupies a slot too.
        const result = shedToolbarSlots(slots, 40 + 40 + 4)
        expect(result.visibleIds).toEqual(['new'])
        expect(result.overflowIds).toEqual(['unread', 'mark-all', 'settings', 'browse'])
    })
})

describe('toolbarActionBudget', () => {
    it('leaves a Quest-width empty row enough room for the daily controls', () => {
        expect(toolbarActionBudget(400, false)).toBeGreaterThan(200)
        expect(toolbarActionBudget(320, false)).toBeGreaterThan(200)
    })

    it('reserves only the compact query chip, not a 200px desert', () => {
        // max-w-[9rem] + clear ≈ 152. Old 200 left empty space after More on Quest.
        expect(toolbarActionBudget(400, true)).toBeGreaterThanOrEqual(220)
        expect(toolbarActionBudget(320, true)).toBeGreaterThanOrEqual(140)
        expect(toolbarActionBudget(320, true)).toBeLessThan(toolbarActionBudget(320, false))
    })

    it('keeps daily controls before the row has been measured', () => {
        expect(toolbarActionBudget(0, false)).toBe(Number.POSITIVE_INFINITY)
        expect(toolbarActionBudget(0, true)).toBe(220)
    })
})
