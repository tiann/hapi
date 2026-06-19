import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { TextMessagePartProvider } from '@assistant-ui/react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_WITH_BREAKS,
    MARKDOWN_REHYPE_PLUGINS,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_CLASSNAME,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
} from '@/components/assistant-ui/markdown-text'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
    content: string
    components?: MarkdownTextPrimitiveProps['components']
    className?: string
    preserveSingleLineBreaks?: boolean
    /** Render outside assistant-ui thread context (file pane, fixtures). */
    standalone?: boolean
}

function StandaloneMarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    return (
        <UriConfirmProvider>
            <div className={cn(MARKDOWN_CLASSNAME, props.className)}>
                <ReactMarkdown
                    remarkPlugins={props.preserveSingleLineBreaks ? MARKDOWN_PLUGINS_WITH_BREAKS : MARKDOWN_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={mergedComponents as Components}
                    urlTransform={denyOnlyTransform}
                >
                    {props.content}
                </ReactMarkdown>
            </div>
        </UriConfirmProvider>
    )
}

function MarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    return (
        <UriConfirmProvider>
            <TextMessagePartProvider text={props.content}>
                <MarkdownTextPrimitive
                    remarkPlugins={props.preserveSingleLineBreaks ? MARKDOWN_PLUGINS_WITH_BREAKS : MARKDOWN_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={mergedComponents}
                    componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                    urlTransform={denyOnlyTransform}
                    className={cn(MARKDOWN_CLASSNAME, props.className)}
                />
            </TextMessagePartProvider>
        </UriConfirmProvider>
    )
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
    if (props.standalone) {
        return <StandaloneMarkdownContent {...props} />
    }
    return <MarkdownContent {...props} />
}
