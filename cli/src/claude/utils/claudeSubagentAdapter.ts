import { createSpawnMeta, createStatusMeta } from '@/subagents/normalize'
import type { NormalizedSubagentMeta } from '@/subagents/types'
import type { SDKAssistantMessage, SDKMessage } from '@/claude/sdk'

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

function getParentToolUseId(message: SDKMessage): string | null {
    return asString((message as SDKAssistantMessage).parent_tool_use_id)
        ?? asString((message as Record<string, unknown>).parentToolUseId)
        ?? null
}

export class ClaudeSubagentAdapter {
    private readonly promptBySidechainKey = new Map<string, string>()
    private readonly activeTaskSidechainKeys = new Set<string>()

    reset(): void {
        this.promptBySidechainKey.clear()
        this.activeTaskSidechainKeys.clear()
    }

    extract(message: SDKMessage): NormalizedSubagentMeta[] {
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
                    if (prompt) {
                        this.promptBySidechainKey.set(block.id, prompt)
                    }
                    this.activeTaskSidechainKeys.add(block.id)
                    metas.push(createSpawnMeta({
                        sidechainKey: block.id,
                        prompt
                    }))
                }
            }

            const sidechainKey = getParentToolUseId(message)
            if (sidechainKey) {
                metas.push({
                    kind: 'message',
                    sidechainKey
                })
            }

            return metas
        }

        if (message.type === 'user') {
            const sidechainKey = getParentToolUseId(message)
            if (sidechainKey) {
                metas.push({
                    kind: 'message',
                    sidechainKey
                })
            }

            return metas
        }

        if (message.type !== 'result') {
            return metas
        }

        const explicitParentToolUseId = getParentToolUseId(message)
        const sidechainKey = explicitParentToolUseId ?? this.getSafeImplicitResultSidechainKey()
        if (!sidechainKey) {
            return metas
        }

        metas.push(createStatusMeta({
            sidechainKey,
            status: message.subtype === 'success' ? 'completed' : 'error'
        }))

        const title = this.promptBySidechainKey.get(sidechainKey)
            ?? asString((message as Record<string, unknown>).session_id)
            ?? asString((message as Record<string, unknown>).sessionId)

        if (title) {
            metas.push({
                kind: 'title',
                sidechainKey,
                title
            })
        }

        this.activeTaskSidechainKeys.delete(sidechainKey)

        return metas
    }

    private getSafeImplicitResultSidechainKey(): string | null {
        if (this.activeTaskSidechainKeys.size !== 1) {
            return null
        }

        return this.activeTaskSidechainKeys.values().next().value ?? null
    }
}

export function createClaudeSubagentAdapter(): ClaudeSubagentAdapter {
    return new ClaudeSubagentAdapter()
}
