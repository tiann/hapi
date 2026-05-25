import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { AssistantProvider, type AssistantApi } from '@assistant-ui/react'
import { useMemo } from 'react'
import {
    MARKDOWN_PLUGINS,
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
}

function unsupportedScope(scope: string) {
    const field = (() => {
        throw new Error(`${scope} is not available in standalone MarkdownRenderer.`)
    }) as (() => never) & { source: null; query: Record<string, never> }
    field.source = null
    field.query = {}
    return field
}

function standaloneField<T>(get: () => T) {
    const field = get as (() => T) & { source: 'root'; query: Record<string, never> }
    field.source = 'root'
    field.query = {}
    return field
}

function createStandaloneMarkdownApi(content: string): AssistantApi {
    const partState = {
        type: 'text',
        text: content,
        status: { type: 'complete' }
    }
    const partApi = {
        getState: () => partState,
        addToolResult: () => {
            throw new Error('Not supported in standalone MarkdownRenderer.')
        },
        resumeToolCall: () => {
            throw new Error('Not supported in standalone MarkdownRenderer.')
        }
    }
    const messageState = {
        id: 'standalone-markdown-renderer',
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        status: { type: 'complete', reason: 'stop' },
        createdAt: new Date(0),
        metadata: {
            unstable_state: null,
            unstable_annotations: [],
            unstable_data: [],
            steps: [],
            custom: {}
        },
        parts: [partState],
        parentId: null,
        index: 0,
        isLast: true,
        branchNumber: 1,
        branchCount: 1,
        speech: undefined,
        submittedFeedback: undefined,
        composer: {
            getState: () => {
                throw new Error('Not supported in standalone MarkdownRenderer.')
            }
        },
        isCopied: false,
        isHovering: false
    }
    const messageApi = {
        getState: () => messageState,
        composer: messageState.composer,
        part: () => partApi,
        attachment: () => {
            throw new Error('Not supported in standalone MarkdownRenderer.')
        },
        reload: () => {},
        speak: () => {},
        stopSpeaking: () => {},
        submitFeedback: () => {},
        switchToBranch: () => {},
        getCopyText: () => content,
        setIsCopied: () => {},
        setIsHovering: () => {}
    }

    return {
        threads: unsupportedScope('Threads'),
        tools: unsupportedScope('Tools'),
        modelContext: unsupportedScope('ModelContext'),
        threadListItem: unsupportedScope('ThreadListItem'),
        thread: unsupportedScope('Thread'),
        composer: unsupportedScope('Composer'),
        message: standaloneField(() => messageApi),
        part: standaloneField(() => partApi),
        attachment: unsupportedScope('Attachment'),
        subscribe: () => () => {},
        on: () => () => {}
    } as unknown as AssistantApi
}

function MarkdownContent(props: MarkdownRendererProps) {
    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents
    const assistantApi = useMemo(() => createStandaloneMarkdownApi(props.content), [props.content])

    return (
        <UriConfirmProvider>
            <AssistantProvider api={assistantApi} devToolsVisible={false}>
                <MarkdownTextPrimitive
                    smooth={false}
                    remarkPlugins={MARKDOWN_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={mergedComponents}
                    componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                    urlTransform={denyOnlyTransform}
                    className={cn(MARKDOWN_CLASSNAME, props.className)}
                />
            </AssistantProvider>
        </UriConfirmProvider>
    )
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
    return <MarkdownContent {...props} />
}
