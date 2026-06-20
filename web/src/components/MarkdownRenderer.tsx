import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { TextMessagePartProvider } from '@assistant-ui/react'
import { useMemo, type ComponentPropsWithoutRef, type ComponentType } from 'react'
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
import { SyntaxHighlighter } from '@/components/assistant-ui/shiki-highlighter'
import type { CodeHeaderProps, SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
    content: string
    components?: MarkdownTextPrimitiveProps['components']
    className?: string
    preserveSingleLineBreaks?: boolean
    /** Render outside assistant-ui thread context (file pane, fixtures). */
    standalone?: boolean
}

type StandaloneCodeProps = ComponentPropsWithoutRef<'code'> & {
    inline?: boolean
}

function StandaloneCode(props: StandaloneCodeProps) {
    const Code = defaultComponents.code!

    if (props.inline) {
        return <Code {...props} />
    }

    const language = /language-(\w+)/.exec(props.className || '')?.[1] ?? ''
    const code = typeof props.children === 'string' ? props.children : String(props.children ?? '')
    const Highlighter: ComponentType<SyntaxHighlighterProps> =
        MARKDOWN_COMPONENTS_BY_LANGUAGE[language as keyof typeof MARKDOWN_COMPONENTS_BY_LANGUAGE]?.SyntaxHighlighter
        ?? SyntaxHighlighter
    const CodeHeader = defaultComponents.CodeHeader as ComponentType<CodeHeaderProps>

    const Pre = defaultComponents.pre!
    const InlineCode = defaultComponents.code!

    return (
        <>
            <CodeHeader language={language || 'unknown'} code={code} />
            <Highlighter
                language={language || 'unknown'}
                code={code}
                components={{ Pre, Code: InlineCode }}
            />
        </>
    )
}

function StandaloneMarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    const {
        pre,
        code: _code,
        SyntaxHighlighter: _sh,
        CodeHeader: _header,
        ...componentsRest
    } = mergedComponents as typeof mergedComponents & Record<string, unknown>

    const components = useMemo<Components>(() => ({
        ...(componentsRest as Components),
        pre: pre ?? defaultComponents.pre,
        code: StandaloneCode,
    }), [componentsRest, pre])

    return (
        <UriConfirmProvider>
            <div className={cn(MARKDOWN_CLASSNAME, props.className)}>
                <ReactMarkdown
                    remarkPlugins={props.preserveSingleLineBreaks ? MARKDOWN_PLUGINS_WITH_BREAKS : MARKDOWN_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={components}
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
