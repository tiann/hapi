import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useShikiHighlighter } from '@/lib/shiki'

export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    const highlighted = useShikiHighlighter(props.code, props.language)

    return (
        <div className="aui-md-codeblock min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-b-md bg-[var(--app-code-bg)]">
            <pre className="shiki m-0 w-max min-w-full p-2 text-xs font-mono">
                <code className="block">{highlighted ?? props.code}</code>
            </pre>
        </div>
    )
}
