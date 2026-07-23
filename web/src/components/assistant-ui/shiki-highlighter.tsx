import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import type { CSSProperties, ReactNode } from 'react'
import { useShikiHighlightedLines, splitCodeLines } from '@/lib/shiki'
import { useCodeWrap } from '@/hooks/useCodeWrap'

// `@assistant-ui/react-markdown`'s DefaultCodeBlock renders this component
// (not `Pre`) for every fenced code block that declares a language — i.e.
// almost every real assistant-message code block. `Pre` only covers the
// languageless fallback path. Uses the same per-line row layout as
// CodeBlock: a line-number cell and a code cell share each grid row, so the
// number stays aligned with its line even when the code cell wraps.
export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    const highlightedLines = useShikiHighlightedLines(props.code, props.language)
    const { codeWrap } = useCodeWrap()
    const codeLines: ReactNode[] = highlightedLines ?? splitCodeLines(props.code)
    const lineNumberWidth = Math.max(String(codeLines.length).length, 3)
    const codeGridStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch ${codeWrap ? 'minmax(0, 1fr)' : 'max-content'}`
    } satisfies CSSProperties
    // Inline style, not a Tailwind class: `.aui-md :where(pre)
    // { white-space: pre }` in index.css is unlayered CSS that outranks any
    // `@layer` regardless of specificity. The grid container below is a <pre>
    // (so it matches that rule), but an element's own inline style always wins
    // over a stylesheet rule, so the code cells' inline whiteSpace controls
    // wrapping regardless.
    const codeCellStyle = codeWrap
        ? { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }
        : { whiteSpace: 'pre' as const }

    return (
        <div className={`aui-md-codeblock min-w-0 w-full max-w-full overflow-y-hidden rounded-b-xl bg-[var(--app-code-bg)] ${codeWrap ? '' : 'overflow-x-auto'}`}>
            <pre
                className={`shiki m-0 grid ${codeWrap ? 'w-full' : 'w-max min-w-full'} text-sm font-mono`}
                style={codeGridStyle}
            >
                {codeLines.map((line, index) => {
                    // py lives on the first/last row cells (not the container)
                    // so the gutter background reaches the top and bottom edges.
                    const rowPad = `${index === 0 ? 'pt-3' : ''} ${index === codeLines.length - 1 ? 'pb-3' : ''}`
                    return (
                        <span key={index} className="contents">
                            <span
                                data-line-number
                                aria-hidden="true"
                                className={`select-none bg-[var(--app-code-header-bg)] px-3 text-right text-[var(--app-hint)]/70 ${rowPad}`}
                            >
                                {index + 1}
                            </span>
                            <span data-code-cell className={`pl-4 pr-4 ${rowPad}`} style={codeCellStyle}>
                                {line}
                            </span>
                        </span>
                    )
                })}
            </pre>
        </div>
    )
}
