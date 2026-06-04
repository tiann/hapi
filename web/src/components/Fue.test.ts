import { describe, expect, it } from 'vitest'
import { computeFueCalloutPlacement } from './Fue'

const VIEWPORT = { width: 1024, height: 768 }

describe('computeFueCalloutPlacement', () => {
    it('floats above the anchor when there is room', () => {
        const result = computeFueCalloutPlacement({
            anchor: { top: 600, left: 100, right: 132, bottom: 632 },
            panelWidth: 256,
            panelHeight: 96,
            viewport: VIEWPORT,
            gap: 8,
        })
        expect(result.placement).toBe('above')
        // top = anchor.top - gap - panelHeight = 600 - 8 - 96 = 496
        expect(result.top).toBe(496)
        // left aligns with anchor.left when on-screen
        expect(result.left).toBe(100)
    })

    it('drops below the anchor when there is not enough room above', () => {
        const result = computeFueCalloutPlacement({
            anchor: { top: 20, left: 100, right: 132, bottom: 52 },
            panelWidth: 256,
            panelHeight: 96,
            viewport: VIEWPORT,
            gap: 8,
        })
        expect(result.placement).toBe('below')
        // top = anchor.bottom + gap = 52 + 8 = 60 (clamped to fit viewport)
        expect(result.top).toBe(60)
    })

    it('clamps left edge to viewport margin when anchor is at the left edge', () => {
        const result = computeFueCalloutPlacement({
            anchor: { top: 600, left: 0, right: 32, bottom: 632 },
            panelWidth: 256,
            panelHeight: 96,
            viewport: VIEWPORT,
            margin: 8,
        })
        // anchor.left=0, but margin=8 means minLeft=8
        expect(result.left).toBe(8)
    })

    it('clamps left edge so panel does not overflow right viewport edge', () => {
        const result = computeFueCalloutPlacement({
            anchor: { top: 600, left: 900, right: 932, bottom: 632 },
            panelWidth: 256,
            panelHeight: 96,
            viewport: VIEWPORT,
            margin: 8,
        })
        // maxLeft = viewportRight - panelWidth - margin = 1024 - 256 - 8 = 760
        expect(result.left).toBe(760)
    })

    it('respects viewport offset (e.g. visualViewport on mobile keyboards)', () => {
        const result = computeFueCalloutPlacement({
            anchor: { top: 600, left: 100, right: 132, bottom: 632 },
            panelWidth: 256,
            panelHeight: 96,
            viewport: { width: 1024, height: 600, offsetTop: 0, offsetLeft: 0 },
            gap: 8,
            margin: 8,
        })
        expect(result.placement).toBe('above')
        expect(result.top).toBeGreaterThanOrEqual(8)
    })
})
