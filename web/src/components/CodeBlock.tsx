import type { CSSProperties } from 'react'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useShikiHighlighter } from '@/lib/shiki'
import { CopyIcon, CheckIcon } from '@/components/icons'
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

function countCodeLines(code: string): number {
    if (code.length === 0) return 1
    const lines = code.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    return Math.max(lines.length, 1)
}

export function CodeBlock(props: {
    code: string
    language?: string
    title?: string
    showCopyButton?: boolean
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
    const { copied, copy } = useCopyToClipboard()
    const highlighted = useShikiHighlighter(props.code, props.language)
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
    const lineCount = countCodeLines(props.code)
    const lineNumberWidth = Math.max(String(lineCount).length, 3)
    const lineNumbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')
    const label = formatCodeLabel(props.language, props.title)
    const codeGridStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch max-content`
    } satisfies CSSProperties
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
                {showCopyButton ? (
                    <button
                        type="button"
                        onClick={() => copy(props.code)}
                        className="shrink-0 rounded-md p-1 text-[var(--app-code-header-fg)] transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)]"
                        title={t('code.copy')}
                    >
                        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                ) : null}
            </div>

            <div
                className="min-w-0 w-full max-w-full overflow-x-auto"
                style={bodyStyle}
            >
                <div className={`grid w-max min-w-full font-mono ${codeTextClass}`} style={codeGridStyle}>
                    <pre
                        aria-hidden="true"
                        className="m-0 select-none px-3 py-3 text-left text-[var(--app-hint)]/70"
                    >
                        {lineNumbers}
                    </pre>
                    <pre className="shiki m-0 px-4 py-3 pr-8">
                        <code className="block">{highlighted ?? props.code}</code>
                    </pre>
                </div>
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
