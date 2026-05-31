import { describe, expect, it } from 'vitest'
import { normalizeMermaidSvgForStandaloneDisplay } from '@/components/assistant-ui/mermaid-diagram'

describe('normalizeMermaidSvgForStandaloneDisplay', () => {
    it('replaces width="100%" with explicit viewBox dimensions', () => {
        const svg = '<svg id="root" viewBox="0 0 200 80" width="100%" style="max-width: 320px;"><rect width="10"/></svg>'
        const prepared = normalizeMermaidSvgForStandaloneDisplay(svg)

        expect(prepared).not.toContain('width="100%"')
        expect(prepared).toContain('width:200px')
        expect(prepared).toContain('height:80px')
    })
})
