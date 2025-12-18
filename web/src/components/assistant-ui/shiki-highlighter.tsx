import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import ShikiHighlighter from 'react-shiki/web'

const SHIKI_THEMES = {
    light: 'github-light',
    dark: 'github-dark',
} as const

export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    return (
        <div className="aui-md-codeblock overflow-hidden rounded-b-md bg-[var(--app-code-bg)]">
            <ShikiHighlighter
                language={props.language}
                theme={SHIKI_THEMES}
                delay={75}
                addDefaultStyles={false}
                showLanguage={false}
                as="div"
            >
                {props.code}
            </ShikiHighlighter>
        </div>
    )
}
