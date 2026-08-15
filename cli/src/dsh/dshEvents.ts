import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { DshImportedMessage } from '@hapi/protocol/apiTypes'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage } from '@/agent/types'
import type { DshHistoryEntry, DshSessionEvent } from './dshWebClient'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function extractTextBlocks(value: unknown, type = 'text'): string {
    if (!Array.isArray(value)) return ''
    return value.flatMap((entry) => {
        if (!isRecord(entry) || entry.type !== type || typeof entry.text !== 'string') return []
        return [entry.text]
    }).join('\n')
}

function parseArguments(value: unknown): unknown {
    if (typeof value !== 'string') return value ?? {}
    try {
        return JSON.parse(value) as unknown
    } catch {
        return { value }
    }
}

function toolResultOutput(data: JsonRecord): unknown {
    const message = isRecord(data.message) ? data.message : null
    if (!message || !Array.isArray(message.content)) return data.meta ?? data
    const resultBlock = message.content.find((entry) => isRecord(entry) && entry.type === 'tool-result')
    if (!isRecord(resultBlock)) return message.content
    const text = extractTextBlocks(resultBlock.content)
    return text || resultBlock.content
}

function toolView(entry: DshHistoryEntry | undefined): { title?: string; kind?: string } {
    const wrapper = isRecord(entry?.view) ? entry.view : null
    const view = wrapper && isRecord(wrapper.view) ? wrapper.view : null
    return {
        ...(asString(view?.title) ? { title: view!.title as string } : {}),
        ...(asString(view?.kind) ? { kind: view!.kind as string } : {})
    }
}

export function convertDshEvent(
    event: DshSessionEvent,
    entry?: DshHistoryEntry
): { messages: AgentMessage[]; model?: string; reasoningEffort?: string; humanText?: string } {
    const data = isRecord(event.data) ? event.data : null
    if (!data) return { messages: [] }

    if (event.type === 'user/message') {
        const source = isRecord(data.source) ? data.source : null
        if (source?.kind !== 'user') return { messages: [] }
        const text = extractTextBlocks(data.content)
        return text ? { messages: [], humanText: text } : { messages: [] }
    }

    if (event.type === 'assistant/message') {
        const message = isRecord(data.message) ? data.message : null
        const source = message && isRecord(message.source) ? message.source : null
        const model = asString(source?.model) ?? undefined
        const messageId = asString(message?.id) ?? `dsh-assistant-${event.seq}`
        const content = Array.isArray(message?.content) ? message.content : []
        const messages: AgentMessage[] = []
        const reasoning = extractTextBlocks(content, 'reasoning')
        const text = extractTextBlocks(content)
        if (reasoning) messages.push({ type: 'reasoning', text: reasoning, id: `${messageId}:reasoning` })
        if (text) messages.push({ type: 'text', text, id: `${messageId}:text` })

        const usage = isRecord(data.usage) ? data.usage : null
        const uncachedInput = asNumber(usage?.inputTokens)
        const output = asNumber(usage?.outputTokens)
        if (uncachedInput !== null && output !== null) {
            messages.push({
                type: 'usage',
                inputTokens: uncachedInput,
                outputTokens: output,
                ...(asNumber(usage?.reasoningTokens) !== null ? { thoughtTokens: usage!.reasoningTokens as number } : {}),
                ...(asNumber(usage?.cacheReadTokens) !== null ? { cacheReadTokens: usage!.cacheReadTokens as number } : {}),
                ...(asNumber(usage?.cacheWriteTokens) !== null ? { cacheCreationTokens: usage!.cacheWriteTokens as number } : {})
            })
        }
        return { messages, ...(model ? { model } : {}) }
    }

    if (event.type === 'tool/call') {
        const callId = asString(data.callId)
        const name = asString(data.name)
        if (!callId || !name) return { messages: [] }
        const view = toolView(entry)
        return {
            messages: [{
                type: 'tool_call',
                id: callId,
                name,
                input: parseArguments(data.arguments),
                status: 'in_progress',
                ...view
            }]
        }
    }

    if (event.type === 'tool/result') {
        const message = isRecord(data.message) ? data.message : null
        const source = message && isRecord(message.source) ? message.source : null
        const callId = asString(source?.callId)
            ?? (Array.isArray(message?.content)
                ? message.content.map((block) => isRecord(block) ? asString(block.toolCallId) : null).find(Boolean) ?? null
                : null)
        if (!callId) return { messages: [] }
        const resultBlock = Array.isArray(message?.content)
            ? message.content.find((block) => isRecord(block) && block.type === 'tool-result')
            : null
        const isError = isRecord(resultBlock) && resultBlock.isError === true
        return {
            messages: [{
                type: 'tool_result',
                id: callId,
                output: toolResultOutput(data),
                status: isError ? 'failed' : 'completed'
            }]
        }
    }

    if (event.type === 'request/header') {
        const header = isRecord(data.header) ? data.header : null
        const config = header && isRecord(header.config) ? header.config : null
        const model = asString(config?.model) ?? undefined
        const reasoningEffort = asString(config?.reasoningEffort) ?? undefined
        return {
            messages: [],
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {})
        }
    }

    return { messages: [] }
}

export function convertDshHistoryEntry(
    sessionId: string,
    entry: DshHistoryEntry
): DshImportedMessage[] {
    const converted = convertDshEvent(entry.event, entry)
    const result: DshImportedMessage[] = []
    if (converted.humanText) {
        result.push({
            localId: `dsh:${sessionId}:${entry.event.seq}:user`,
            eventSeq: entry.event.seq,
            createdAt: entry.event.time,
            content: {
                role: 'user',
                content: { type: 'text', text: converted.humanText },
                meta: { sentFrom: 'cli' }
            }
        })
    }
    converted.messages.forEach((message, index) => {
        const body = convertAgentMessage(message, converted.model)
        if (!body) return
        result.push({
            localId: `dsh:${sessionId}:${entry.event.seq}:agent:${index}`,
            eventSeq: entry.event.seq,
            createdAt: entry.event.time,
            content: {
                role: 'agent',
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: body },
                meta: { sentFrom: 'cli' }
            }
        })
    })
    return result
}
