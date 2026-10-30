import { describe, expect, it } from 'vitest'
import { unified, type PluggableList } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkLatexBracketMath from './remark-latex-bracket-math'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_STANDALONE,
    MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS,
    MARKDOWN_PLUGINS_WITH_BREAKS,
    MARKDOWN_REHYPE_PLUGINS,
} from '@/components/assistant-ui/markdown-text'

function render(markdown: string, plugins: PluggableList = MARKDOWN_PLUGINS): string {
    const processor = unified()
        .use(remarkParse)
        .use(plugins)
        .use(remarkRehype)
        .use(MARKDOWN_REHYPE_PLUGINS)
    const tree = processor.parse(markdown)
    return toHtml(processor.runSync(tree, markdown) as never)
}

const pluginVariants = [
    ['default', MARKDOWN_PLUGINS],
    ['standalone', MARKDOWN_PLUGINS_STANDALONE],
    ['with breaks', MARKDOWN_PLUGINS_WITH_BREAKS],
    ['standalone with breaks', MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS],
] as const

describe('remarkLatexBracketMath', () => {
    it('is included before remarkMath in every production plugin variant', () => {
        for (const [, plugins] of pluginVariants) {
            const bracketIndex = plugins.indexOf(remarkLatexBracketMath)
            const mathIndex = plugins.findIndex((plugin) => Array.isArray(plugin) && plugin[0] === remarkMath)
            expect(bracketIndex).toBeGreaterThanOrEqual(0)
            expect(mathIndex).toBeGreaterThanOrEqual(0)
            expect(bracketIndex).toBeLessThan(mathIndex)
        }
    })

    it.each(pluginVariants)('renders display bracket math in the %s pipeline', (_, plugins) => {
        const html = render(String.raw`\[E = mc^2\]`, plugins)

        expect(html).toContain('class="katex-display"')
        expect(html).toContain('class="katex"')
        expect(html).not.toContain('\\[E = mc^2\\]')
    })

    it.each(pluginVariants)('renders parenthesized inline math in the %s pipeline', (_, plugins) => {
        const html = render(String.raw`Result: \(x^2 + y^2\).`, plugins)

        expect(html).toContain('class="katex"')
        expect(html).not.toContain('katex-display')
        expect(html).not.toContain('\\(x^2 + y^2\\)')
    })

    it('renders multiline display math before optional hard-break processing', () => {
        const markdown = String.raw`Before

\[
E = mc^2
\]

After`

        for (const [, plugins] of pluginVariants) {
            const html = render(markdown, plugins)
            expect(html).toContain('class="katex-display"')
            expect(html).toContain('Before')
            expect(html).toContain('After')
        }
    })

    it('renders multiple inline formulas in one paragraph', () => {
        const html = render(String.raw`Compare \(a^2\) with \(b^2\).`)

        expect(html.match(/class="katex"/g)).toHaveLength(2)
    })

    it('renders aligned display math with TeX line breaks and indentation', () => {
        const html = render(String.raw`\[
\begin{aligned}
f(x) &= x^2+2x+1 \\
     &= (x+1)^2
\end{aligned}
\]`)

        expect(html).toContain('class="katex-display"')
        expect(html).toContain('class="katex"')
        expect(html).not.toContain('<p>[\\begin{aligned}')
    })

    it('hoists display math out of surrounding prose', () => {
        const html = render(String.raw`Before \[x^2\] after`)

        expect(html).toContain('<p>Before </p>')
        expect(html).toContain('<p> after</p>')
        expect(html).toContain('class="katex-display"')
    })

    it('preserves common LaTeX commands inside display math', () => {
        const html = render(String.raw`\[
\lim_{x\to 0}\frac{\sin x}{x}=1
\]`)

        expect(html).toContain('class="katex-display"')
        expect(html).toContain('mfrac')
    })

    it('renders the multiline transfer-function formulas from the real session', () => {
        const html = render(String.raw`\[
\Phi(s)=
\frac{\dfrac{K^*(s+4)}{s(s+2)(s+3)}}
{1+\dfrac{K^*}{s(s+3)}}
\]

\[
\Phi(s)
=
\frac{K^*(s+4)}
{(s+2)\left[s(s+3)+K^*\right]}
\]

\[
\Phi(s)=
\frac{9(s+4)}
{(s+2)(s^2+3s+9)}
\]

\[
\Phi(s)
=
\frac{9}{s^2+3s+9}
\frac{s+4}{s+2}
\]`)

        expect(html.match(/class="katex"/g)).toHaveLength(4)
        expect(html).not.toContain('<p>[\n')
        expect(html).not.toContain('<h1>[\n')
    })

    it('renders percent and text commands from the real session', () => {
        const html = render(String.raw`标准二阶系统超调量：

\[
\sigma\% =
e^{-\frac{\pi\zeta}{\sqrt{1-\zeta^2}}}\times100\%
\]

\[
t_s\approx\frac{4}{0.5\times3}
\approx2.67\text{ s}
\]`)

        expect(html.match(/class="katex"/g)).toHaveLength(2)
        expect(html).not.toContain('<p>[\n')
        expect(html).not.toContain('<h1>[\n')
    })

    it('recurses through inline formatting while keeping the display node block-level', () => {
        const html = render(String.raw`**Before \(x^2\) after**`)

        expect(html).toContain('<strong>')
        expect(html).toContain('class="katex"')
    })

    it.each([
        ['inline code', 'Use `\\(x^2\\)` here.'],
        ['fenced code', '```latex\n\\[x^2\\]\n```'],
        ['escaped delimiters', String.raw`Literal \\(x^2\\) and \\[y^2\\]`],
        ['unclosed delimiter', String.raw`Literal \(x^2`],
    ])('leaves %s as text', (_, markdown) => {
        const html = render(markdown)

        expect(html).not.toContain('class="katex"')
    })

    it('does not let an unmatched opener consume a protected code block', () => {
        const html = render([
            String.raw`Literal \(`,
            '```latex',
            String.raw`\[x^2\]`,
            '```',
            '',
            String.raw`\(y^2\)`,
        ].join('\n'))

        expect(html).toContain('<pre><code class="language-latex">\\[x^2\\]\n</code></pre>')
        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('Literal (')
        expect(html).not.toContain('\uE000')
    })

    it('preserves quoted fences and multiline code spans as literal Markdown', () => {
        const quotedFence = [
            '> ```latex',
            '> \\[x^2\\]',
            '> ````',
        ].join('\n')
        const quotedFenceHtml = render(quotedFence)
        expect(quotedFenceHtml).not.toContain('class="katex"')
        expect(quotedFenceHtml).toContain('\\[x^2\\]')

        const multilineCodeSpan = [
            'Use `before',
            String.raw`\[x^2\]`,
            'after` here.',
        ].join('\n')
        const multilineCodeSpanHtml = render(multilineCodeSpan)
        expect(multilineCodeSpanHtml).not.toContain('class="katex"')
        expect(multilineCodeSpanHtml).toContain('\\[x^2\\]')
    })

    it('removes blockquote prefixes from multiline bracket math', () => {
        const html = render([
            '> \\[',
            '> x = 1',
            '> \\]',
        ].join('\n'))

        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('<annotation encoding="application/x-tex">x = 1</annotation>')
        expect(html).not.toContain('<annotation encoding="application/x-tex">&gt; x = 1')
    })

    it('preserves blockquote prefixes when prose precedes multiline bracket math', () => {
        const html = render([
            '> Result: \\[',
            '> x = 1',
            '> \\]',
        ].join('\n'))

        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('<annotation encoding="application/x-tex">x = 1</annotation>')
        expect(html).not.toContain('<annotation encoding="application/x-tex">&gt; x = 1')
    })

    it('keeps mathematical greater-than signs in unquoted multiline bracket math', () => {
        const html = render([
            '\\[',
            'x',
            '> 0',
            '\\]',
        ].join('\n'))

        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('<annotation encoding="application/x-tex">x\n> 0</annotation>')
        expect(html).not.toContain('\uE000')
    })

    it('preserves list-contained fences and renders following bracket math', () => {
        const html = render([
            '- ```latex',
            '  \\[x^2\\]',
            '  ````',
            '',
            String.raw`\(y^2\)`,
        ].join('\n'))

        expect(html).toContain('<pre><code class="language-latex">\\[x^2\\]\n</code></pre>')
        expect(html.match(/class="katex"/g)).toHaveLength(1)
    })

    it('keeps escaped parentheses in link, image, and definition destinations', () => {
        const linkHtml = render(String.raw`[source](https://example.com/foo\(bar\).ts)`)
        expect(linkHtml).toContain('href="https://example.com/foo(bar).ts"')
        expect(linkHtml).not.toContain('class="katex"')

        const imageHtml = render(String.raw`![source](https://example.com/foo\(bar\).png)`)
        expect(imageHtml).toContain('src="https://example.com/foo(bar).png"')
        expect(imageHtml).not.toContain('class="katex"')

        const definitionHtml = render([
            '[source][id]',
            '',
            String.raw`[id]: https://example.com/foo\(bar\).ts`,
        ].join('\n'))
        expect(definitionHtml).toContain('href="https://example.com/foo(bar).ts"')
        expect(definitionHtml).not.toContain('class="katex"')
    })

    it('preserves image alt text and reference identifiers containing delimiters', () => {
        const imageHtml = render(String.raw`![\(x\)](https://example.com/image.png)`)
        expect(imageHtml).toContain('alt="(x)"')
        expect(imageHtml).not.toContain('\uE000')

        const referenceHtml = render([
            String.raw`[source][\(id\)]`,
            '',
            String.raw`[\(id\)]: https://example.com/foo`,
        ].join('\n'))
        expect(referenceHtml).toContain('href="https://example.com/foo"')
        expect(referenceHtml).not.toContain('\uE000')
    })

    it('preserves reference-image alt text and implicit link identifiers', () => {
        const imageReferenceHtml = render([
            String.raw`![\(x\)][id]`,
            '',
            '[id]: https://example.com/image.png',
        ].join('\n'))
        expect(imageReferenceHtml).toContain('alt="(x)"')
        expect(imageReferenceHtml).toContain('src="https://example.com/image.png"')
        expect(imageReferenceHtml).not.toContain('\uE000')

        const collapsedLinkHtml = render([
            String.raw`[\(x\)][]`,
            '',
            String.raw`[\(x\)]: https://example.com`,
        ].join('\n'))
        expect(collapsedLinkHtml).toContain('href="https://example.com"')
        expect(collapsedLinkHtml).not.toContain('\uE000')

        const shortcutLinkHtml = render([
            String.raw`[\(x\)]`,
            '',
            String.raw`[\(x\)]: https://example.com`,
        ].join('\n'))
        expect(shortcutLinkHtml).toContain('href="https://example.com"')
        expect(shortcutLinkHtml).not.toContain('\uE000')
    })

    it('renders bracket math across an empty TeX line', () => {
        const html = render([
            '\\[',
            'a',
            '',
            '+ b',
            '\\]',
        ].join('\n'))

        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('<annotation encoding="application/x-tex">a\n\n+ b</annotation>')
        expect(html).not.toContain('\uE000')
    })

    it('recognizes ordered-list fence indentation before following bracket math', () => {
        const html = render([
            '10. ```latex',
            '    \\[x^2\\]',
            '    ````',
            '',
            String.raw`\(y^2\)`,
        ].join('\n'))

        expect(html).toContain('<pre><code class="language-latex">\\[x^2\\]\n</code></pre>')
        expect(html.match(/class="katex"/g)).toHaveLength(1)
    })

    it('allows a list-relative closing fence indentation', () => {
        const html = render([
            '- ```latex',
            '  \\[x^2\\]',
            '    ````',
            '',
            String.raw`\(y^2\)`,
        ].join('\n'))

        expect(html).toContain('<pre><code class="language-latex">\\[x^2\\]\n</code></pre>')
        expect(html.match(/class="katex"/g)).toHaveLength(1)
    })

    it('keeps multiline bracket math inside a list item', () => {
        const html = render([
            '- \\[',
            '  x = 1',
            '  \\]',
        ].join('\n'))

        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('<annotation encoding="application/x-tex">x = 1</annotation>')
        expect(html).not.toContain('\uE000')
    })

    it('normalizes nested list and blockquote prefixes in multiline bracket math', () => {
        const html = render([
            '- > \\[',
            '  > x = 1',
            '  > \\]',
        ].join('\n'))

        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('<annotation encoding="application/x-tex">x = 1</annotation>')
        expect(html).not.toContain('<annotation encoding="application/x-tex">&gt; x = 1')
        expect(html).not.toContain('\uE000')
    })

    it('keeps currency prose literal while preserving existing dollar math', () => {
        const currency = render('The plan is $200/mo and the bill is $80.')
        expect(currency).not.toContain('class="katex"')
        expect(currency).toContain('$200')
        expect(currency).toContain('$80')

        const dollarMath = render(String.raw`$$
E = mc^2
$$`)
        expect(dollarMath).toContain('class="katex-display"')
    })

    it('preserves bracket-like TeX commands inside existing dollar math', () => {
        const html = render(String.raw`$$\verb|\(x\)|$$`)

        expect(html).toContain('\\(x\\)')
        expect(html).not.toContain('\uE000')
    })

    it('keeps bracket math after the existing table source repair', () => {
        const markdown = [
            '| A | B | C |',
            '|---|---|',
            '| x | y | z |',
            '',
            String.raw`\[E = mc^2\]`,
        ].join('\n')

        const html = render(markdown)
        expect(html).toContain('<table>')
        expect(html).toContain('class="katex-display"')
    })

    it('does not add hard-break parsing to the default pipeline', () => {
        expect(MARKDOWN_PLUGINS).not.toContain(remarkBreaks)
        expect(MARKDOWN_PLUGINS_WITH_BREAKS).toContain(remarkBreaks)
    })
})
