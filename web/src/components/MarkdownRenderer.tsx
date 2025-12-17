import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/CodeBlock'

function getLanguageFromClassName(className?: string): string | null {
    if (!className) return null
    for (const token of className.split(/\s+/g)) {
        if (token.startsWith('language-')) {
            return token.slice('language-'.length) || null
        }
    }
    return null
}

const defaultComponents: Components = {
    code({ className, children, ...props }) {
        const language = getLanguageFromClassName(className) || 'text'
        const code = String(children).replace(/\n$/, '')

        if (language !== 'text' || code.includes('\n')) {
            return (
                <CodeBlock
                    code={code}
                    language={language}
                    showCopyButton={false}
                />
            )
        }

        return <code className={className} {...props}>{children}</code>
    },
}

interface MarkdownRendererProps {
    content: string
    components?: Components
}

export function MarkdownRenderer({ content, components }: MarkdownRendererProps) {
    return (
        <div className="markdown-content text-sm">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ ...defaultComponents, ...components }}
            >
                {content}
            </ReactMarkdown>
        </div>
    )
}
