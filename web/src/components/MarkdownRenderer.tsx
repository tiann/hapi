import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/CodeBlock'

function getLanguageFromClassName(className?: string): string | null {
    if (!className) return null
    for (const token of className.split(/\s+/g)) {
        if (token.startsWith('language-')) {
            const language = token.slice('language-'.length)
            return language || null
        }
    }
    return null
}

export function MarkdownRenderer({ content }: { content: string }) {
    return (
        <div className="markdown-content text-sm">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
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
                    }
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    )
}
