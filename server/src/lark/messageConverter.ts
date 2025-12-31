/**
 * Message Converter
 * 
 * Converts Claude Code messages to Lark card format.
 * Handles different message types: text, tool calls, events, etc.
 */

import {
    LarkCardBuilder,
    buildTextCard,
    buildToolResultCard,
    buildThinkingCard,
    buildErrorCard,
    type InteractiveCard
} from './cardBuilder'

type ToolUseBlock = {
    type: 'tool_use'
    id: string
    name: string
    input: unknown
}

type TextBlock = {
    type: 'text'
    text: string
}

type ThinkingBlock = {
    type: 'thinking'
    thinking: string
}

type ToolResultBlock = {
    type: 'tool_result'
    tool_use_id: string
    content: string | Array<{ type: 'text'; text: string }>
    is_error?: boolean
}

type ContentBlock = ToolUseBlock | TextBlock | ThinkingBlock | ToolResultBlock

type AssistantMessage = {
    role: 'assistant'
    content: ContentBlock[]
}

type AgentOutputMessage = {
    role: 'agent'
    content: {
        type: 'output'
        data: {
            type: string
            message?: {
                role: string
                content: ContentBlock[]
            }
            [key: string]: unknown
        }
    }
}

type EventMessage = {
    role: 'agent'
    content: {
        type: 'event'
        data: {
            type: string
            [key: string]: unknown
        }
    }
}

type MessageContent = AssistantMessage | AgentOutputMessage | EventMessage | unknown

export interface ConvertedMessage {
    type: 'text' | 'card'
    content: string | InteractiveCard
    toolUseId?: string
    isToolResult?: boolean
}

export function convertMessageToLark(content: MessageContent): ConvertedMessage[] {
    if (!content || typeof content !== 'object') {
        return []
    }

    const msg = content as Record<string, unknown>

    if (msg.role === 'agent' && isAgentOutput(msg)) {
        return convertAgentOutput(msg as AgentOutputMessage)
    }

    if (msg.role === 'agent' && isEventMessage(msg)) {
        return convertEventMessage(msg as EventMessage)
    }

    if (msg.role === 'assistant') {
        return convertAssistantMessage(msg as AssistantMessage)
    }

    return []
}

function isAgentOutput(msg: Record<string, unknown>): boolean {
    const content = msg.content as Record<string, unknown> | undefined
    return content?.type === 'output'
}

function isEventMessage(msg: Record<string, unknown>): boolean {
    const content = msg.content as Record<string, unknown> | undefined
    return content?.type === 'event'
}

function convertAgentOutput(msg: AgentOutputMessage): ConvertedMessage[] {
    const data = msg.content.data
    const results: ConvertedMessage[] = []

    if (data.type === 'assistant' && data.message) {
        const assistantMsg = data.message as AssistantMessage
        return convertAssistantMessage(assistantMsg)
    }

    if (data.type === 'result') {
        const result = data as { type: 'result'; subtype?: string; result?: string; error?: string }
        if (result.error) {
            results.push({
                type: 'card',
                content: buildErrorCard(result.error)
            })
        }
        return results
    }

    if (data.type === 'summary') {
        const summary = data as { type: 'summary'; summary: string }
        results.push({
            type: 'card',
            content: new LarkCardBuilder()
                .setHeader('📝 Summary', undefined, 'green')
                .addMarkdown(summary.summary)
                .build()
        })
        return results
    }

    return results
}

function convertEventMessage(msg: EventMessage): ConvertedMessage[] {
    const event = msg.content.data
    const results: ConvertedMessage[] = []

    switch (event.type) {
        case 'switch':
            results.push({
                type: 'text',
                content: `🔄 Switched to ${(event as { mode: string }).mode} mode`
            })
            break

        case 'message':
            results.push({
                type: 'text',
                content: (event as { message: string }).message
            })
            break

        case 'permission-mode-changed':
            results.push({
                type: 'text',
                content: `⚙️ Permission mode changed to: ${(event as { mode: string }).mode}`
            })
            break

        case 'ready':
            results.push({
                type: 'text',
                content: '✅ Session is ready'
            })
            break
    }

    return results
}

function convertAssistantMessage(msg: AssistantMessage): ConvertedMessage[] {
    const results: ConvertedMessage[] = []
    const textParts: string[] = []
    const toolCalls: ToolUseBlock[] = []
    const toolResults: Map<string, ToolResultBlock> = new Map()
    let thinkingContent: string | null = null

    for (const block of msg.content) {
        if (block.type === 'text') {
            textParts.push(block.text)
        } else if (block.type === 'tool_use') {
            toolCalls.push(block)
        } else if (block.type === 'tool_result') {
            toolResults.set(block.tool_use_id, block)
        } else if (block.type === 'thinking') {
            thinkingContent = block.thinking
        }
    }

    if (thinkingContent) {
        results.push({
            type: 'card',
            content: new LarkCardBuilder()
                .addCollapsible('💭 Thinking', thinkingContent)
                .build()
        })
    }

    if (textParts.length > 0) {
        const combinedText = textParts.join('\n\n')
        if (combinedText.length < 500 && !combinedText.includes('```')) {
            results.push({ type: 'text', content: combinedText })
        } else {
            results.push({ type: 'card', content: buildTextCard(combinedText) })
        }
    }

    for (const toolCall of toolCalls) {
        const result = toolResults.get(toolCall.id)
        const card = convertToolCall(toolCall, result)
        if (card) {
            results.push({
                type: 'card',
                content: card,
                toolUseId: toolCall.id,
                isToolResult: !!result
            })
        }
    }

    return results
}

function convertToolCall(toolCall: ToolUseBlock, result?: ToolResultBlock): InteractiveCard | null {
    const toolName = toolCall.name
    const input = toolCall.input as Record<string, unknown>

    const builder = new LarkCardBuilder()

    const status = result
        ? (result.is_error ? 'error' : 'success')
        : 'running'

    const statusEmoji = {
        running: '🔄',
        success: '✅',
        error: '❌'
    }[status]

    const statusColor = {
        running: 'blue',
        success: 'green',
        error: 'red'
    }[status] as 'blue' | 'green' | 'red'

    builder.setHeader(`${statusEmoji} ${toolName}`, undefined, statusColor)

    switch (toolName) {
        case 'Read':
        case 'Glob':
        case 'Grep':
        case 'LS':
            if (input.file_path || input.path || input.pattern) {
                const path = (input.file_path ?? input.path ?? input.pattern) as string
                builder.addMarkdown(`📄 \`${path}\``)
            }
            break

        case 'Write':
            if (input.file_path) {
                builder.addMarkdown(`📝 Writing to \`${input.file_path}\``)
                if (input.content && typeof input.content === 'string') {
                    const preview = input.content.slice(0, 500)
                    builder.addCollapsible('Content Preview', `\`\`\`\n${preview}${input.content.length > 500 ? '\n...' : ''}\n\`\`\``)
                }
            }
            break

        case 'Edit':
            if (input.file_path) {
                builder.addMarkdown(`✏️ Editing \`${input.file_path}\``)
                if (input.old_string && input.new_string) {
                    builder.addCollapsible('Changes', `**Old:**\n\`\`\`\n${input.old_string}\n\`\`\`\n\n**New:**\n\`\`\`\n${input.new_string}\n\`\`\``)
                }
            }
            break

        case 'Bash':
            if (input.command) {
                builder.addCodeBlock(input.command as string, 'bash')
            }
            break

        case 'Task':
            if (input.description) {
                builder.addMarkdown(`📋 ${input.description}`)
            }
            break

        case 'TodoWrite':
            if (input.todos && Array.isArray(input.todos)) {
                const todos = input.todos as Array<{ content: string; status: string }>
                for (const todo of todos.slice(0, 5)) {
                    const emoji = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔄' : '⬜'
                    builder.addMarkdown(`${emoji} ${todo.content}`)
                }
                if (todos.length > 5) {
                    builder.addNote(`... and ${todos.length - 5} more items`)
                }
            }
            break

        default:
            const inputStr = JSON.stringify(input, null, 2)
            if (inputStr.length > 10) {
                builder.addCollapsible('Input', `\`\`\`json\n${inputStr}\n\`\`\``)
            }
    }

    if (result) {
        const resultContent = typeof result.content === 'string'
            ? result.content
            : result.content.map(c => c.text).join('\n')

        if (resultContent && resultContent.length > 0) {
            const truncated = resultContent.length > 2000
                ? resultContent.slice(0, 2000) + '\n... (truncated)'
                : resultContent

            if (result.is_error) {
                builder.addMarkdown(`**Error:**\n\`\`\`\n${truncated}\n\`\`\``)
            } else {
                builder.addCollapsible('Result', `\`\`\`\n${truncated}\n\`\`\``)
            }
        }
    }

    return builder.build()
}

export function convertHistoryToCards(messages: Array<{ content: unknown; createdAt: number }>): ConvertedMessage[] {
    const results: ConvertedMessage[] = []

    for (const msg of messages) {
        const converted = convertMessageToLark(msg.content)
        results.push(...converted)
    }

    return results
}

export function buildHistorySummaryCard(messages: Array<{
    content: unknown
    createdAt: number
}>, limit = 10): InteractiveCard {
    const builder = new LarkCardBuilder()
        .setHeader('📜 Recent History', `Last ${Math.min(messages.length, limit)} messages`, 'grey')

    const recentMessages = messages.slice(-limit)

    for (const msg of recentMessages) {
        const content = msg.content as Record<string, unknown>
        const time = new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour12: false })

        if (content.role === 'user') {
            const userContent = content.content as { text?: string } | undefined
            const text = userContent?.text ?? '(message)'
            builder.addMarkdown(`**${time}** 👤 ${truncateText(text, 100)}`)
        } else if (content.role === 'agent' || content.role === 'assistant') {
            builder.addMarkdown(`**${time}** 🤖 (response)`)
        }
    }

    if (messages.length > limit) {
        builder.addNote(`${messages.length - limit} older messages not shown`)
    }

    return builder.build()
}

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength - 3) + '...'
}
