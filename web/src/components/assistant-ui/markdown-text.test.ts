import { describe, expect, it } from 'vitest'
import remarkBreaks from 'remark-breaks'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'
import { MARKDOWN_PLUGINS, MARKDOWN_PLUGINS_WITH_BREAKS } from '@/components/assistant-ui/markdown-text'

describe('MARKDOWN_PLUGINS integration', () => {
    it('includes remarkNonHttpsAutolink', () => {
        expect(MARKDOWN_PLUGINS).toContain(remarkNonHttpsAutolink)
    })

    it('places remarkNonHttpsAutolink BEFORE remarkStripCjkAutolink so CJK strip sees new links', () => {
        const idxAutolink = MARKDOWN_PLUGINS.indexOf(remarkNonHttpsAutolink)
        const idxCjk = MARKDOWN_PLUGINS.indexOf(remarkStripCjkAutolink)
        expect(idxAutolink).toBeGreaterThan(0) // not first (remarkGfm is first)
        expect(idxAutolink).toBeLessThan(idxCjk) // autolink before CJK strip
    })

    it('keeps hard-break parsing scoped to opt-in user prompt rendering', () => {
        expect(MARKDOWN_PLUGINS).not.toContain(remarkBreaks)
        expect(MARKDOWN_PLUGINS_WITH_BREAKS).toContain(remarkBreaks)
    })
})
