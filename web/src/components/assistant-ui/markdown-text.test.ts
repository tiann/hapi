import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import remarkBreaks from 'remark-breaks'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_WITH_BREAKS,
    MARKDOWN_REHYPE_PLUGINS,
    normalizeLocalImagePath,
} from '@/components/assistant-ui/markdown-text'

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

function render(markdown: string): string {
    const processor = unified()
        .use(remarkParse)
        .use(MARKDOWN_PLUGINS)
        .use(remarkRehype)
        .use(MARKDOWN_REHYPE_PLUGINS)
    const tree = processor.runSync(processor.parse(markdown))
    return toHtml(tree as never)
}

describe('MARKDOWN_PLUGINS — currency prose vs KaTeX', () => {
    // Regression: prose with multiple "$N" amounts must NOT be eaten by KaTeX.
    // remarkMath is configured with `singleDollarTextMath: false` so single
    // dollar signs are treated as literal text, matching GitHub markdown.

    it('does not render single-$ currency amounts as KaTeX math', () => {
        const md = "The plan is $200/mo and the bill is $80 — total $400 saved."
        const html = render(md)
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<math')
        expect(html).toContain('$200')
        expect(html).toContain('$80')
        expect(html).toContain('$400')
    })

    it('does not render the reported real-world prose as KaTeX', () => {
        // Lifted (paraphrased) from the bug report: paragraph with multiple
        // "$N" amounts and apostrophes that previously collapsed into a single
        // KaTeX block and stripped whitespace from the running text.
        const md = "Cursor's UI quotes the ratio: at least $400 of API usage on a $200 plan. That's 2:1."
        const html = render(md)
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<math')
        expect(html).toContain('$400')
        expect(html).toContain('$200')
    })

    it('still renders block math with $$...$$ on its own lines', () => {
        const md = "Before\n\n$$\nE = mc^2\n$$\n\nAfter"
        const html = render(md)
        expect(html).toContain('class="katex"')
    })
})

describe('normalizeLocalImagePath', () => {
    it('accepts POSIX absolute image paths and strips file URLs', () => {
        expect(normalizeLocalImagePath('/tmp/project/out.png')).toBe('/tmp/project/out.png')
        expect(normalizeLocalImagePath('/home/user/project/out.webp')).toBe('/home/user/project/out.webp')
        expect(normalizeLocalImagePath('file:///tmp/project/out.png')).toBe('/tmp/project/out.png')
    })

    it('rejects relative and non-image paths', () => {
        expect(normalizeLocalImagePath('tmp/project/out.png')).toBeNull()
        expect(normalizeLocalImagePath('/tmp/project/out.txt')).toBeNull()
    })

    it('rejects malformed file URIs instead of throwing during render', () => {
        expect(normalizeLocalImagePath('file:///%E0%A4%A.png')).toBeNull()
    })
})
