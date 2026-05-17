import { describe, expect, it } from 'vitest'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'
import { MARKDOWN_PLUGINS } from '@/components/assistant-ui/markdown-text'

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
})
