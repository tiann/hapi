import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useShikiHighlighter } from '@/lib/shiki'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

const DEFAULT_COLLAPSE_LINE_THRESHOLD = 18
const DEFAULT_COLLAPSE_CHAR_THRESHOLD = 1800
const DEFAULT_COLLAPSED_HEIGHT = 260

function shouldCollapseCode(code: string, lineThreshold: number, charThreshold: number): boolean {
    if (code.length > charThreshold) return true
    return code.split('\n').length > lineThreshold
}

export function CodeBlock(props: {
    code: string
    language?: string
    showCopyButton?: boolean
    collapseLongContent?: boolean
    collapsedHeight?: number
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

    return (
        <div className="relative min-w-0 max-w-full">
            {showCopyButton ? (
                <button
                    type="button"
                    onClick={() => copy(props.code)}
                    className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    title={t('code.copy')}
                >
                    {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                </button>
            ) : null}

            <div
                className="min-w-0 w-full max-w-full overflow-x-auto rounded-md bg-[var(--app-code-bg)]"
                style={isCollapsed ? { maxHeight: collapsedHeight, overflowY: 'hidden' } : { overflowY: 'hidden' }}
            >
                <pre className="shiki m-0 w-max min-w-full p-2 pr-8 text-xs font-mono">
                    <code className="block">{highlighted ?? props.code}</code>
                </pre>
            </div>
            {isCollapsed ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center rounded-b-md bg-gradient-to-t from-[var(--app-code-bg)] via-[var(--app-code-bg)]/90 to-transparent px-2 pb-2 pt-10">
                    <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)] shadow-sm">
                        {t('code.truncated')}
                    </span>
                </div>
            ) : null}
        </div>
    )
}
