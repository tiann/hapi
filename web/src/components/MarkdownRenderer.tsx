import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { TextMessagePartProvider } from '@assistant-ui/react'
import { buildRemarkPlugins, MARKDOWN_REHYPE_PLUGINS, defaultComponents } from '@/components/assistant-ui/markdown-text'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
    content: string
    components?: MarkdownTextPrimitiveProps['components']
    breakSingleNewlines?: boolean
}

function MarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    return (
        <TextMessagePartProvider text={props.content}>
            <MarkdownTextPrimitive
                remarkPlugins={buildRemarkPlugins({ breakSingleNewlines: props.breakSingleNewlines })}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={mergedComponents}
                className={cn(
                    'aui-md min-w-0 max-w-full break-words text-base',
                    // User messages: render literal blank lines as a real paragraph gap.
                    // Tailwind preflight resets <p> margin to 0, so without this `\n\n`
                    // collapses visually into the same look as a single `\n`.
                    props.breakSingleNewlines && '[&>p+p]:mt-3'
                )}
            />
        </TextMessagePartProvider>
    )
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
    return <MarkdownContent {...props} />
}
