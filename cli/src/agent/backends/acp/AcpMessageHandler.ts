import type { AgentMessage, PlanItem } from '@/agent/types';
import { asString, deriveToolName, isObject } from '@/agent/utils';
import { ACP_SESSION_UPDATE_TYPES } from './constants';

function normalizeStatus(status: unknown): 'pending' | 'in_progress' | 'completed' | 'failed' {
    if (status === 'in_progress' || status === 'completed' || status === 'failed') {
        return status;
    }
    return 'pending';
}

function deriveToolNameFromUpdate(update: Record<string, unknown>): string {
    return deriveToolName({
        title: asString(update.title),
        kind: asString(update.kind),
        rawInput: update.rawInput
    });
}

function extractTextContent(block: unknown): string | null {
    if (!isObject(block)) return null;
    if (block.type !== 'text') return null;
    const text = block.text;
    return typeof text === 'string' ? text : null;
}

function normalizePlanEntries(entries: unknown): PlanItem[] {
    if (!Array.isArray(entries)) return [];

    const items: PlanItem[] = [];
    for (const entry of entries) {
        if (!isObject(entry)) continue;
        const content = asString(entry.content);
        const priority = asString(entry.priority);
        const status = asString(entry.status);

        if (!content) continue;
        if (priority !== 'high' && priority !== 'medium' && priority !== 'low') continue;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;

        items.push({ content, priority, status });
    }

    return items;
}

export class AcpMessageHandler {
    private readonly toolCalls = new Map<string, { name: string; input: unknown }>();

    constructor(private readonly onMessage: (message: AgentMessage) => void) {}

    handleUpdate(update: unknown): void {
        if (!isObject(update)) return;
        const updateType = asString(update.sessionUpdate);
        if (!updateType) return;

        if (updateType === ACP_SESSION_UPDATE_TYPES.agentMessageChunk) {
            const content = update.content;
            const text = extractTextContent(content);
            if (text) {
                this.onMessage({ type: 'text', text });
            }
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.agentThoughtChunk) {
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.toolCall) {
            this.handleToolCall(update);
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.toolCallUpdate) {
            this.handleToolCallUpdate(update);
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.plan) {
            const items = normalizePlanEntries(update.entries);
            if (items.length > 0) {
                this.onMessage({ type: 'plan', items });
            }
        }
    }

    private handleToolCall(update: Record<string, unknown>): void {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return;

        const name = deriveToolNameFromUpdate(update);
        const input = update.rawInput ?? null;
        const status = normalizeStatus(update.status);

        this.toolCalls.set(toolCallId, { name, input });

        this.onMessage({
            type: 'tool_call',
            id: toolCallId,
            name,
            input,
            status
        });
    }

    private handleToolCallUpdate(update: Record<string, unknown>): void {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return;

        const status = normalizeStatus(update.status);
        const existing = this.toolCalls.get(toolCallId);

        if (update.rawInput !== undefined) {
            const name = deriveToolNameFromUpdate(update);
            const input = update.rawInput;
            this.toolCalls.set(toolCallId, { name, input });
            this.onMessage({
                type: 'tool_call',
                id: toolCallId,
                name,
                input,
                status
            });
        } else if (existing && (status === 'in_progress' || status === 'pending')) {
            this.onMessage({
                type: 'tool_call',
                id: toolCallId,
                name: existing.name,
                input: existing.input,
                status
            });
        }

        if (status === 'completed' || status === 'failed') {
            const output = update.rawOutput ?? update.content;
            const result = output ?? { status };
            this.onMessage({
                type: 'tool_result',
                id: toolCallId,
                output: result,
                status: status === 'failed' ? 'failed' : 'completed'
            });
        }
    }
}
