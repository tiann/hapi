import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/CodeBlock'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'

function MarkdownSyntaxHighlighter(props: SyntaxHighlighterProps) {
    return (
        <CodeBlock
            code={props.code}
            language={props.language}
            showCopyButton={false}
        />
    )
}

const MARKDOWN_PLUGINS = [remarkGfm]
const MARKDOWN_COMPONENTS = {
    SyntaxHighlighter: MarkdownSyntaxHighlighter
} as const

function MarkdownText() {
    return (
        <MarkdownTextPrimitive
            className="markdown-content text-sm"
            remarkPlugins={MARKDOWN_PLUGINS}
            components={MARKDOWN_COMPONENTS}
        />
    )
}

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const rootClass = toolOnly ? 'py-1' : 'px-1'

    return (
        <MessagePrimitive.Root className={rootClass}>
            <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
        </MessagePrimitive.Root>
    )
}
