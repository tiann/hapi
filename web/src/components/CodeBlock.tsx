import type { CSSProperties, ReactNode } from 'react'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useCodeWrap } from '@/hooks/useCodeWrap'
import { useShikiHighlightedLines, splitCodeLines } from '@/lib/shiki'
import { CopyIcon, CheckIcon, WrapIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

const DEFAULT_COLLAPSE_LINE_THRESHOLD = 18
const DEFAULT_COLLAPSE_CHAR_THRESHOLD = 1800
const DEFAULT_COLLAPSED_HEIGHT = 260
const DEFAULT_SCROLL_HEIGHT = 420

function shouldCollapseCode(code: string, lineThreshold: number, charThreshold: number): boolean {
    if (code.length > charThreshold) return true
    return code.split('\n').length > lineThreshold
}

function formatCodeLabel(language?: string, title?: string): string {
    if (title && title.trim().length > 0) return title
    if (!language || language === 'unknown') return 'Code'
    return language
}

export function CodeBlock(props: {
    code: string
    language?: string
    title?: string
    showCopyButton?: boolean
    showWrapToggle?: boolean
    collapseLongContent?: boolean
    collapsedHeight?: number
    maxHeight?: number
    scrollY?: boolean
    size?: 'compact' | 'comfortable'
    collapseLineThreshold?: number
    collapseCharThreshold?: number
}) {
    const { t } = useTranslation()
    const showCopyButton = props.showCopyButton ?? true
    // The wrap toggle is a <button>. Callsites that render CodeBlock inside
    // an interactive ancestor (a DialogTrigger button, a role="button"
    // inline preview) must pass false to avoid nesting interactive elements
    // (invalid HTML / hydration violation). Default on for standalone use.
    const showWrapToggle = props.showWrapToggle ?? true
    const { copied, copy } = useCopyToClipboard()
    const { codeWrap, setCodeWrap } = useCodeWrap()
    const highlightedLines = useShikiHighlightedLines(props.code, props.language)
    const isCollapsed = Boolean(props.collapseLongContent) && shouldCollapseCode(
        props.code,
        props.collapseLineThreshold ?? DEFAULT_COLLAPSE_LINE_THRESHOLD,
        props.collapseCharThreshold ?? DEFAULT_COLLAPSE_CHAR_THRESHOLD
    )
    const collapsedHeight = props.collapsedHeight ?? DEFAULT_COLLAPSED_HEIGHT
    const scrollHeight = props.maxHeight ?? DEFAULT_SCROLL_HEIGHT
    const codeTextClass = props.size === 'comfortable'
        ? 'text-sm leading-5'
        : 'text-xs'
    // Render one grid row per logical line: a line-number cell and a code
    // cell that are siblings in the same row. Because they share a grid row,
    // the line number stays aligned with its line even when the code cell
    // wraps (the row grows taller and the number pins to the top) -- the
    // GitHub / VS Code diff behavior. This replaces the earlier two-<pre>
    // approach whose independent text flows drifted out of alignment while
    // wrapped.
    //
    // `highlightedLines` (one ReactNode per line) is null while shiki is
    // pending or for unsupported languages; fall back to the raw code split
    // on newlines using the same normalization, so line numbers match.
    const fallbackLines = splitCodeLines(props.code)
    const codeLines: ReactNode[] = highlightedLines ?? fallbackLines
    const lineNumberWidth = Math.max(String(codeLines.length).length, 3)
    const label = formatCodeLabel(props.language, props.title)
    // First track sizes to the line-number column; the code column takes the
    // rest. When wrapped the code column is capped to the container width
    // (minmax(0,1fr)) so long lines wrap instead of overflowing; unwrapped it
    // grows to its content (max-content) inside the horizontal-scroll body.
    const codeGridStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch ${codeWrap ? 'minmax(0, 1fr)' : 'max-content'}`
    } satisfies CSSProperties
    const codeCellStyle = codeWrap
        ? { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }
        : { whiteSpace: 'pre' as const }
    const bodyStyle = isCollapsed
        ? { maxHeight: collapsedHeight, overflowY: 'hidden' as const }
        : props.scrollY
            ? { maxHeight: scrollHeight, overflowY: 'auto' as const }
            : { overflowY: 'hidden' as const }

    return (
        <div className="aui-code-surface relative min-w-0 max-w-full overflow-hidden rounded-xl bg-[var(--app-code-bg)] shadow-none">
            <div className="aui-code-surface-header flex items-center justify-between gap-3 bg-[var(--app-code-header-bg)] px-3 py-2">
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">
                    {label}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {showWrapToggle ? (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation()
                                setCodeWrap(!codeWrap)
                            }}
                            className={`rounded-md p-1 transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)] ${codeWrap ? 'text-[var(--app-fg)]' : 'text-[var(--app-code-header-fg)]'}`}
                            title={t(codeWrap ? 'code.wrap.disable' : 'code.wrap.enable')}
                            aria-pressed={codeWrap}
                        >
                            <WrapIcon className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                    {showCopyButton ? (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation()
                                copy(props.code)
                            }}
                            className="rounded-md p-1 text-[var(--app-code-header-fg)] transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)]"
                            title={t('code.copy')}
                        >
                            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                        </button>
                    ) : null}
                </div>
            </div>

            <div
                className={`min-w-0 w-full max-w-full ${codeWrap ? '' : 'overflow-x-auto'}`}
                style={bodyStyle}
            >
                <pre
                    className={`shiki m-0 grid ${codeWrap ? 'w-full' : 'w-max min-w-full'} font-mono ${codeTextClass}`}
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
                                <span data-code-cell className={`pl-4 pr-8 ${rowPad}`} style={codeCellStyle}>
                                    {line}
                                </span>
                            </span>
                        )
                    })}
                </pre>
            </div>
            {isCollapsed ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-[var(--app-code-bg)] via-[var(--app-code-bg)]/94 to-transparent px-2 pb-2 pt-10">
                    <span className="rounded-full bg-[var(--app-chat-user-chip-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)] shadow-none">
                        {t('code.truncated')}
                    </span>
                </div>
            ) : null}
        </div>
    )
}
