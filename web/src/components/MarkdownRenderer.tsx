import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { TextMessagePartProvider } from '@assistant-ui/react'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_REHYPE_PLUGINS,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_CLASSNAME,
    defaultComponents,
} from '@/components/assistant-ui/markdown-text'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
    content: string
    components?: MarkdownTextPrimitiveProps['components']
    className?: string
}

function MarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    return (
        <TextMessagePartProvider text={props.content}>
            <MarkdownTextPrimitive
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={mergedComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                className={cn(MARKDOWN_CLASSNAME, props.className)}
            />
        </TextMessagePartProvider>
    )
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
    return <MarkdownContent {...props} />
}
