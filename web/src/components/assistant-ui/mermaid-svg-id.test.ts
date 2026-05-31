import { describe, expect, it } from 'vitest'
import {
    mermaidSvgToDataUrl,
    normalizeMermaidSvgForStandaloneDisplay,
} from '@/components/assistant-ui/mermaid-diagram'

describe('normalizeMermaidSvgForStandaloneDisplay', () => {
    it('replaces width="100%" with explicit viewBox dimensions', () => {
        const svg = '<svg id="root" viewBox="0 0 200 80" width="100%" style="max-width: 320px;"><rect width="10"/></svg>'
        const prepared = normalizeMermaidSvgForStandaloneDisplay(svg)

        expect(prepared).not.toContain('width="100%"')
        expect(prepared).toContain('width:200px')
        expect(prepared).toContain('height:80px')
    })
})

describe('mermaidSvgToDataUrl', () => {
    it('returns a data URL without duplicating SVG nodes in the document', () => {
        const svg = '<svg viewBox="0 0 120 40" width="100%"><text>A</text></svg>'
        const url = mermaidSvgToDataUrl(svg)

        expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
        expect(decodeURIComponent(url.split(',')[1] ?? '')).toContain('width="120"')
    })
})
