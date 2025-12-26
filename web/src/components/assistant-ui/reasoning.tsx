import { useState, useEffect, type FC, type PropsWithChildren } from 'react'
import { useMessage } from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'
import { defaultComponents, MARKDOWN_PLUGINS } from '@/components/assistant-ui/markdown-text'

function ChevronIcon(props: { className?: string; open?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
                'transition-transform duration-200',
                props.open ? 'rotate-90' : '',
                props.className
            )}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function ShimmerDot() {
    return (
        <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
    )
}

/**
 * Renders individual reasoning message part content with markdown support.
 */
export const Reasoning: FC = () => {
    return (
        <MarkdownTextPrimitive
            remarkPlugins={MARKDOWN_PLUGINS}
            components={defaultComponents}
            className={cn('aui-reasoning-content min-w-0 max-w-full break-words text-sm text-[var(--app-hint)]')}
        />
    )
}

/**
 * Wraps consecutive reasoning parts in a collapsible container.
 * Shows shimmer effect while reasoning is streaming.
 */
export const ReasoningGroup: FC<PropsWithChildren> = ({ children }) => {
    const [isOpen, setIsOpen] = useState(false)

    // Check if reasoning is still streaming
    const message = useMessage()
    const isStreaming = message.status?.type === 'running'
        && message.content.length > 0
        && message.content[message.content.length - 1]?.type === 'reasoning'

    // Auto-expand while streaming
    useEffect(() => {
        if (isStreaming) {
            setIsOpen(true)
        }
    }, [isStreaming])

    return (
        <div className="aui-reasoning-group my-2">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    'flex items-center gap-1.5 text-xs font-medium',
                    'text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                    'transition-colors cursor-pointer select-none'
                )}
            >
                <ChevronIcon open={isOpen} />
                <span>Reasoning</span>
                {isStreaming && (
                    <span className="flex items-center gap-1 ml-1 text-[var(--app-hint)]">
                        <ShimmerDot />
                    </span>
                )}
            </button>

            <div
                className={cn(
                    'overflow-hidden transition-all duration-200 ease-in-out',
                    isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
                )}
            >
                <div className="pl-4 pt-2 border-l-2 border-[var(--app-border)] ml-0.5">
                    {children}
                </div>
            </div>
        </div>
    )
}
