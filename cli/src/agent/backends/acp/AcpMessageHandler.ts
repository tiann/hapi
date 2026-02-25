import type { AgentMessage, PlanItem } from '@/agent/types';
import { asString, isObject } from '@hapi/protocol';
import { deriveToolNameWithSource, isPlaceholderToolName } from '@/agent/utils';
import { ACP_SESSION_UPDATE_TYPES } from './constants';

function normalizeStatus(status: unknown): 'pending' | 'in_progress' | 'completed' | 'failed' {
    if (status === 'in_progress' || status === 'completed' || status === 'failed') {
        return status;
    }
    return 'pending';
}

type DerivedToolName = ReturnType<typeof deriveToolNameWithSource>;

function deriveToolNameFromUpdate(update: Record<string, unknown>): DerivedToolName {
    return deriveToolNameWithSource({
        title: asString(update.title),
        kind: asString(update.kind),
        rawInput: update.rawInput
    });
}

function extractTextContent(block: unknown): string | null {
    if (!isObject(block)) return null;
    if (block.type !== 'text') return null;
    const explicitAudience = extractExplicitAudience(block.annotations);
    if (explicitAudience.length > 0 && !explicitAudience.includes('assistant')) {
        return null;
    }
    const text = block.text;
    return typeof text === 'string' ? text : null;
}

function extractExplicitAudience(annotations: unknown): string[] {
    if (Array.isArray(annotations)) {
        const audiences: string[] = [];
        for (const entry of annotations) {
            if (typeof entry === 'string') {
                audiences.push(entry);
                continue;
            }
            if (!isObject(entry)) {
                continue;
            }
            audiences.push(...extractAudienceField(entry.audience));
            if (isObject(entry.value)) {
                audiences.push(...extractAudienceField(entry.value.audience));
            }
        }
        return audiences;
    }
    if (isObject(annotations)) {
        return [
            ...extractAudienceField(annotations.audience),
            ...(isObject(annotations.value) ? extractAudienceField(annotations.value.audience) : [])
        ];
    }
    return [];
}

function extractAudienceField(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
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

function getSuffixPrefixOverlap(base: string, next: string): number {
    const maxOverlap = Math.min(base.length, next.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
        if (base.endsWith(next.slice(0, length))) {
            return length;
        }
    }
    return 0;
}

export class AcpMessageHandler {
    private readonly toolCalls = new Map<string, { name: string; input: unknown }>();
    private bufferedText = '';

    constructor(private readonly onMessage: (message: AgentMessage) => void) {}

    flushText(): void {
        if (!this.bufferedText) {
            return;
        }
        this.onMessage({ type: 'text', text: this.bufferedText });
        this.bufferedText = '';
    }

    private appendTextChunk(text: string): void {
        if (!text) {
            return;
        }
        if (!this.bufferedText) {
            this.bufferedText = text;
            return;
        }
        if (text === this.bufferedText) {
            return;
        }
        if (text.startsWith(this.bufferedText)) {
            this.bufferedText = text;
            return;
        }
        if (this.bufferedText.startsWith(text)) {
            return;
        }
        if (this.bufferedText.endsWith(text)) {
            return;
        }
        if (text.endsWith(this.bufferedText)) {
            this.bufferedText = text;
            return;
        }

        const overlap = getSuffixPrefixOverlap(this.bufferedText, text);
        if (overlap > 0) {
            this.bufferedText += text.slice(overlap);
            return;
        }

        this.bufferedText += text;
    }

    handleUpdate(update: unknown): void {
        if (!isObject(update)) return;
        const updateType = asString(update.sessionUpdate);
        if (!updateType) return;

        if (updateType === ACP_SESSION_UPDATE_TYPES.agentMessageChunk) {
            const content = update.content;
            const text = extractTextContent(content);
            if (text) {
                this.appendTextChunk(text);
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

        const derivedName = deriveToolNameFromUpdate(update);
        const name = derivedName.name;
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
            const derivedName = deriveToolNameFromUpdate(update);
            const name = this.selectToolNameForUpdate(existing?.name ?? null, derivedName);
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
            const result = update.rawOutput ?? update.content;
            this.onMessage({
                type: 'tool_result',
                id: toolCallId,
                output: result,
                status: status === 'failed' ? 'failed' : 'completed'
            });
        }
    }

    private selectToolNameForUpdate(existingName: string | null, derivedName: DerivedToolName): string {
        if (!existingName) {
            return derivedName.name;
        }

        if (
            derivedName.source === 'title' ||
            derivedName.source === 'raw_input_name' ||
            derivedName.source === 'raw_input_tool'
        ) {
            return derivedName.name;
        }

        if (isPlaceholderToolName(existingName)) {
            return derivedName.name;
        }

        return existingName;
    }
}
