import { describe, expect, it } from 'vitest'
import { prepareMermaidSvgForLightbox, uniqueifyMermaidSvgIds } from '@/components/assistant-ui/mermaid-diagram'

describe('uniqueifyMermaidSvgIds', () => {
    it('rewrites ids and url(#) references for a lightbox clone', () => {
        const svg = `<svg id="root"><defs><marker id="arrowhead"/><clipPath id="clip"><rect/></clipPath></defs><path marker-end="url(#arrowhead)" clip-path="url(#clip)"/></svg>`
        const scoped = uniqueifyMermaidSvgIds(svg, 'abc')

        expect(scoped).toContain('id="mermaid-lb-abc-root"')
        expect(scoped).toContain('id="mermaid-lb-abc-arrowhead"')
        expect(scoped).toContain('url(#mermaid-lb-abc-arrowhead)')
        expect(scoped).not.toContain('url(#arrowhead)')
    })

    it('replaces width="100%" with explicit viewBox dimensions for lightbox layout', () => {
        const svg = '<svg id="root" viewBox="0 0 200 80" width="100%" style="max-width: 320px;"><rect width="10"/></svg>'
        const prepared = prepareMermaidSvgForLightbox(svg, 'x')

        expect(prepared).not.toContain('width="100%"')
        expect(prepared).toContain('width:200px')
        expect(prepared).toContain('height:80px')
    })
})
