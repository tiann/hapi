import { describe, expect, it } from 'vitest'
import { unified, type PluggableList } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import remarkBreaks from 'remark-breaks'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'
import remarkRepairTables from '@/lib/remark-repair-tables'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_STANDALONE,
    MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS,
    MARKDOWN_PLUGINS_WITH_BREAKS,
    MARKDOWN_REHYPE_PLUGINS,
    isExternalHttpHref,
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

    it('places remarkCjkFriendly after remarkRepairTables, keeping remarkRepairTables immediately after remarkGfm', () => {
        const idxRepair = MARKDOWN_PLUGINS.indexOf(remarkRepairTables)
        const idxCjk = MARKDOWN_PLUGINS.indexOf(remarkCjkFriendly)
        expect(idxRepair).toBeGreaterThan(0) // not first (remarkGfm slot is first)
        expect(idxCjk).toBeGreaterThan(idxRepair)
    })
})

describe('MARKDOWN_PLUGINS — CJK emphasis flanking', () => {
    // CommonMark fails to close `**` when the closing delimiter run's inner
    // neighbor is punctuation and its outer neighbor is a CJK letter
    // (commonmark/commonmark-spec#650). remark-cjk-friendly repairs exactly
    // that class at parse time. All sentences below are synthetic.
    const pluginVariants = [
        ['default', MARKDOWN_PLUGINS],
        ['standalone', MARKDOWN_PLUGINS_STANDALONE],
        ['with breaks', MARKDOWN_PLUGINS_WITH_BREAKS],
        ['standalone with breaks', MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS],
    ] as const

    it.each(pluginVariants)(
        'closes emphasis runs before CJK particles that directly follow punctuation (%s)',
        (_, plugins) => {
            const cases = [
                // Korean particle after a closing parenthesis
                ['**속도 제한(시속 30km)**은 지켜야 합니다', '<strong>속도 제한(시속 30km)</strong>은 지켜야 합니다'],
                // Korean particle after a closing double quote
                ['**"먼저 확인하세요"**를 누르세요', '<strong>"먼저 확인하세요"</strong>를 누르세요'],
                // Korean particle after a closing single quote
                ["**'조용히 진행하세요'**해 주세요", "<strong>'조용히 진행하세요'</strong>해 주세요"],
                // Korean particle right after sentence-ending punctuation
                ['**먼저 저장하세요.**그 다음에 실행하세요', '<strong>먼저 저장하세요.</strong>그 다음에 실행하세요'],
                // Chinese particle after a full-width quote
                ['**“示例”**的说明如下', '<strong>“示例”</strong>的说明如下'],
                // Japanese particle after a corner bracket
                ['**「注意事項」**を読んでください', '<strong>「注意事項」</strong>を読んでください'],
            ] as const
            for (const [markdown, expectedHtml] of cases) {
                expect(render(markdown, plugins)).toContain(expectedHtml)
            }
        }
    )

    it('keeps already-working space-separated CJK emphasis unchanged', () => {
        expect(render('**속도 제한(시속 30km)** 을 지키세요')).toContain(
            '<strong>속도 제한(시속 30km)</strong> 을 지키세요'
        )
    })
})

describe('MARKDOWN_PLUGINS — Latin emphasis regressions', () => {
    // remark-cjk-friendly only alters runs adjacent to CJK text; Latin and
    // intraword emphasis must render exactly as before the plugin.
    it.each([
        ['plain **english emphasis** text', '<p>plain <strong>english emphasis</strong> text</p>'],
        ['foo**bar**baz', '<p>foo<strong>bar</strong>baz</p>'],
        ['**a**b', '<p><strong>a</strong>b</p>'],
        ['snake_case_name', '<p>snake_case_name</p>'],
        ['2*3*4', '<p>2<em>3</em>4</p>'],
    ])('renders %s unchanged', (markdown, expectedHtml) => {
        expect(render(markdown)).toBe(expectedHtml)
    })
})

function render(markdown: string, plugins: PluggableList = MARKDOWN_PLUGINS): string {
    const processor = unified()
        .use(remarkParse)
        .use(plugins)
        .use(remarkRehype)
        .use(MARKDOWN_REHYPE_PLUGINS)
    const tree = processor.runSync(processor.parse(markdown))
    return toHtml(tree as never)
}

describe('MARKDOWN_PLUGINS — GFM strikethrough', () => {
    const pluginVariants = [
        ['default', MARKDOWN_PLUGINS],
        ['standalone', MARKDOWN_PLUGINS_STANDALONE],
        ['with breaks', MARKDOWN_PLUGINS_WITH_BREAKS],
        ['standalone with breaks', MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS],
    ] as const

    it.each(pluginVariants)(
        'keeps a single tilde literal in terminal prompts (%s)',
        (_, plugins) => {
            const terminalPrompt = 'ims@ims-dev-1:~$ ls\ndev\nims@ims-dev-1:~$'
            const html = render(terminalPrompt, plugins)

            expect(html).not.toContain('<del>')
            expect(html).toContain('ims@ims-dev-1:~$ ls')
            expect(html).toContain('ims@ims-dev-1:~$')
            expect(render('status: ~~removed~~', plugins)).toContain('<del>removed</del>')
        }
    )
})

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

describe('isExternalHttpHref', () => {
    it('is true for http/https links', () => {
        expect(isExternalHttpHref('https://example.com')).toBe(true)
        expect(isExternalHttpHref('http://example.com/path?q=1#frag')).toBe(true)
        expect(isExternalHttpHref('HTTPS://Example.com')).toBe(true)
    })

    it('is false for relative/SPA hrefs', () => {
        expect(isExternalHttpHref('/settings')).toBe(false)
        expect(isExternalHttpHref('./foo')).toBe(false)
        expect(isExternalHttpHref('#section')).toBe(false)
        expect(isExternalHttpHref('?q=1')).toBe(false)
        expect(isExternalHttpHref('/path:colon')).toBe(false)
    })

    it('is false for non-http(s) schemes', () => {
        expect(isExternalHttpHref('mailto:a@b.com')).toBe(false)
        expect(isExternalHttpHref('vscode://file/foo')).toBe(false)
        expect(isExternalHttpHref('javascript:alert(1)')).toBe(false)
    })

    it('is false for Windows drive paths (single-letter scheme, not http/https)', () => {
        expect(isExternalHttpHref('C:\\Users\\ian\\file.txt')).toBe(false)
    })

    it('is false for empty/nullish input', () => {
        expect(isExternalHttpHref('')).toBe(false)
        expect(isExternalHttpHref(null)).toBe(false)
        expect(isExternalHttpHref(undefined)).toBe(false)
    })
})
