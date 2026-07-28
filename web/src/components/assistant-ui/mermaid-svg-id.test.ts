import { describe, expect, it } from 'vitest'
import {
    getMermaidSvgLayoutSize,
    normalizeMermaidSvgForStandaloneDisplay,
} from '@/components/assistant-ui/mermaid-diagram'

describe('getMermaidSvgLayoutSize', () => {
    it('reads simple unsigned viewBox', () => {
        expect(getMermaidSvgLayoutSize('<svg viewBox="0 0 200 80"></svg>')).toEqual({ width: 200, height: 80 })
    })

    it('accepts signed origin values (negative offsets)', () => {
        expect(getMermaidSvgLayoutSize('<svg viewBox="-8 -8 640 480"></svg>')).toEqual({ width: 640, height: 480 })
    })

    it('accepts single-quoted attribute and comma separators', () => {
        expect(getMermaidSvgLayoutSize("<svg viewBox='0,0,300,150'></svg>")).toEqual({ width: 300, height: 150 })
    })

    it('rejects malformed viewBox (NaN, missing dim, zero size)', () => {
        expect(getMermaidSvgLayoutSize('<svg viewBox="0 0 NaN 100"></svg>')).toBeNull()
        expect(getMermaidSvgLayoutSize('<svg viewBox="0 0 200"></svg>')).toBeNull()
        expect(getMermaidSvgLayoutSize('<svg viewBox="0 0 0 100"></svg>')).toBeNull()
    })

    it('returns null when no viewBox attribute exists', () => {
        expect(getMermaidSvgLayoutSize('<svg width="100"></svg>')).toBeNull()
    })
})

describe('normalizeMermaidSvgForStandaloneDisplay', () => {
    it('replaces width="100%" with explicit viewBox dimensions', () => {
        const svg = '<svg id="root" viewBox="0 0 200 80" width="100%" style="max-width: 320px;"><rect width="10"/></svg>'
        const prepared = normalizeMermaidSvgForStandaloneDisplay(svg)

        expect(prepared).not.toContain('width="100%"')
        expect(prepared).toContain('width:200px')
        expect(prepared).toContain('height:80px')
    })

    it('normalizes width/height for SVGs with negative viewBox origins', () => {
        const svg = '<svg viewBox="-50 -50 800 600" width="100%" height="100%"><g/></svg>'
        const prepared = normalizeMermaidSvgForStandaloneDisplay(svg)

        expect(prepared).not.toContain('width="100%"')
        expect(prepared).toContain('width="800"')
        expect(prepared).toContain('height="600"')
    })
})
