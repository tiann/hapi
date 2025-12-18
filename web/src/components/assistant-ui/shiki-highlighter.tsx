import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useShikiHighlighter } from '@/lib/shiki'

export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    const highlighted = useShikiHighlighter(props.code, props.language)

    return (
        <div className="aui-md-codeblock overflow-hidden rounded-b-md bg-[var(--app-code-bg)]">
            <pre className="shiki overflow-auto p-2 text-xs font-mono">
                <code>{highlighted ?? props.code}</code>
            </pre>
        </div>
    )
}
