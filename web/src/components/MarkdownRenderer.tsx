import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { TextMessagePartProvider } from '@assistant-ui/react'
import { Children, isValidElement, useMemo, type ComponentPropsWithoutRef, type ComponentType } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_STANDALONE,
    MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS,
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

function StandaloneCode(props: ComponentPropsWithoutRef<'code'>) {
    const Code = defaultComponents.code!
    return <Code {...props} />
}

function StandalonePre(props: ComponentPropsWithoutRef<'pre'>) {
    const child = Children.toArray(props.children)[0]
    if (!isValidElement<ComponentPropsWithoutRef<'code'>>(child)) {
        const Pre = defaultComponents.pre!
        return <Pre {...props} />
    }

    const className = String(child.props.className ?? '')
    const language = /language-(\w+)/.exec(className)?.[1] ?? 'unknown'
    const code = String(child.props.children ?? '').replace(/\n$/, '')
    const Highlighter: ComponentType<SyntaxHighlighterProps> =
        MARKDOWN_COMPONENTS_BY_LANGUAGE[language as keyof typeof MARKDOWN_COMPONENTS_BY_LANGUAGE]?.SyntaxHighlighter
        ?? SyntaxHighlighter
    const CodeHeader = defaultComponents.CodeHeader as ComponentType<CodeHeaderProps>
    const Pre = defaultComponents.pre!
    const Code = defaultComponents.code!

    return (
        <>
            <CodeHeader language={language} code={code} />
            <Highlighter language={language} code={code} components={{ Pre, Code }} />
        </>
    )
}

function StandaloneMarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    const {
        pre: _pre,
        code: _code,
        SyntaxHighlighter: _sh,
        CodeHeader: _header,
        ...componentsRest
    } = mergedComponents as typeof mergedComponents & Record<string, unknown>

    const components = useMemo<Components>(() => ({
        ...(componentsRest as Components),
        pre: StandalonePre,
        code: StandaloneCode,
    }), [componentsRest])

    return (
        <UriConfirmProvider>
            <div className={cn(MARKDOWN_CLASSNAME, props.className)}>
                <ReactMarkdown
                    remarkPlugins={props.preserveSingleLineBreaks ? MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS : MARKDOWN_PLUGINS_STANDALONE}
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
