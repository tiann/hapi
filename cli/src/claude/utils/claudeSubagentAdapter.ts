import { createSpawnMeta, createStatusMeta } from '@/subagents/normalize'
import type { NormalizedSubagentMeta } from '@/subagents/types'
import type { SDKAssistantMessage, SDKMessage } from '@/claude/sdk'

const promptBySidechainKey = new Map<string, string>()

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function extractPrompt(input: unknown): string | undefined {
    const record = asRecord(input)
    if (!record) {
        return asString(input) ?? undefined
    }

    return asString(record.prompt)
        ?? asString(record.title)
        ?? asString(record.message)
        ?? asString(record.text)
        ?? asString(record.content)
        ?? undefined
}

function getSidechainKey(message: SDKMessage): string | null {
    return asString((message as SDKAssistantMessage).parent_tool_use_id)
        ?? asString((message as Record<string, unknown>).parentToolUseId)
        ?? null
}

function extractTitle(message: SDKMessage): string | null {
    const explicitTitle = asString((message as Record<string, unknown>).title)
    if (explicitTitle) {
        return explicitTitle
    }

    const fallbackPrompt = asString((message as Record<string, unknown>).prompt)
    if (fallbackPrompt) {
        return fallbackPrompt
    }

    return asString((message as Record<string, unknown>).session_id)
        ?? asString((message as Record<string, unknown>).sessionId)
        ?? null
}

function rememberPrompt(sidechainKey: string, prompt: string | undefined): void {
    if (!prompt) {
        return
    }

    promptBySidechainKey.set(sidechainKey, prompt)
}

export function resetClaudeSubagentAdapterState(): void {
    promptBySidechainKey.clear()
}

export function extractClaudeSubagentMeta(message: SDKMessage): NormalizedSubagentMeta[] {
    const metas: NormalizedSubagentMeta[] = []

    if (message.type === 'assistant') {
        const assistantMessage = message as SDKAssistantMessage
        const content = assistantMessage.message.content

        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type !== 'tool_use' || block.name !== 'Task' || !block.id) {
                    continue
                }

                const prompt = extractPrompt(block.input)
                rememberPrompt(block.id, prompt)
                metas.push(createSpawnMeta({
                    sidechainKey: block.id,
                    prompt
                }))
            }
        }

        const sidechainKey = getSidechainKey(message)
        if (sidechainKey) {
            metas.push({
                kind: 'message',
                sidechainKey
            })
        }

        return metas
    }

    if (message.type === 'user') {
        const sidechainKey = getSidechainKey(message)
        if (sidechainKey) {
            metas.push({
                kind: 'message',
                sidechainKey
            })
        }

        return metas
    }

    if (message.type === 'result') {
        const sidechainKey = asString((message as Record<string, unknown>).parent_tool_use_id)
            ?? asString((message as Record<string, unknown>).session_id)
            ?? asString((message as Record<string, unknown>).sessionId)

        if (!sidechainKey) {
            return metas
        }

        metas.push(createStatusMeta({
            sidechainKey,
            status: message.subtype === 'success' ? 'completed' : 'error'
        }))

        const title = promptBySidechainKey.get(sidechainKey) ?? extractTitle(message)
        if (title) {
            metas.push({
                kind: 'title',
                sidechainKey,
                title
            })
        }
    }

    return metas
}
