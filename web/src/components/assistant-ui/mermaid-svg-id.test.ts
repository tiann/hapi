import { describe, expect, it } from 'vitest'
import { uniqueifyMermaidSvgIds } from '@/components/assistant-ui/mermaid-diagram'

describe('uniqueifyMermaidSvgIds', () => {
    it('rewrites ids and url(#) references for a lightbox clone', () => {
        const svg = `<svg id="root"><defs><marker id="arrowhead"/><clipPath id="clip"><rect/></clipPath></defs><path marker-end="url(#arrowhead)" clip-path="url(#clip)"/></svg>`
        const scoped = uniqueifyMermaidSvgIds(svg, 'abc')

        expect(scoped).toContain('id="mermaid-lb-abc-root"')
        expect(scoped).toContain('id="mermaid-lb-abc-arrowhead"')
        expect(scoped).toContain('url(#mermaid-lb-abc-arrowhead)')
        expect(scoped).not.toContain('url(#arrowhead)')
    })
})
