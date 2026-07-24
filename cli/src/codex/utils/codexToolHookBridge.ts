import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CodexMessage } from './codexEventConverter';

const CodexToolHookSchema = z.object({
    hook_event_name: z.enum(['PreToolUse', 'PostToolUse']),
    turn_id: z.string().min(1),
    tool_name: z.string().min(1),
    tool_input: z.unknown(),
    tool_response: z.unknown().optional(),
    tool_use_id: z.string().min(1),
    cwd: z.string().optional(),
    agent_id: z.string().optional()
}).passthrough();

type CodexToolHook = z.infer<typeof CodexToolHookSchema>;

type PendingToolCall = {
    displayName: string;
    input: unknown;
    turnId: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function isCodeModeToolUseId(toolUseId: string): boolean {
    return toolUseId.startsWith('exec-');
}

function extractPatchChanges(patch: string): Record<string, { kind: string }> {
    const changes: Record<string, { kind: string }> = {};
    const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

    for (const match of patch.matchAll(fileHeader)) {
        const operation = match[1];
        const path = match[2]?.trim();
        if (operation && path) {
            changes[path] = { kind: operation.toLowerCase() };
        }
    }

    return changes;
}

function toolCallFromHook(hook: CodexToolHook): { displayName: string; input: unknown } | null {
    const input = asRecord(hook.tool_input) ?? {};

    if (hook.tool_name === 'Bash') {
        const command = asString(input.command);
        if (!command) return null;
        return {
            displayName: 'CodexBash',
            input: {
                command,
                ...(hook.cwd ? { cwd: hook.cwd } : {}),
                source: 'codex-hook'
            }
        };
    }

    if (hook.tool_name === 'apply_patch') {
        const patch = asString(input.command);
        if (!patch) return null;
        return {
            displayName: 'CodexPatch',
            input: {
                patch,
                changes: extractPatchChanges(patch),
                source: 'codex-hook'
            }
        };
    }

    return {
        displayName: hook.tool_name,
        input: hook.tool_input
    };
}

function responseText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function toolResultFromHook(displayName: string, response: unknown): { output: unknown; isError: boolean } {
    if (displayName === 'CodexBash') {
        return {
            output: {
                stdout: responseText(response),
                stderr: '',
                status: 'completed'
            },
            isError: false
        };
    }

    if (displayName === 'CodexPatch') {
        return {
            output: response,
            isError: false
        };
    }

    const responseRecord = asRecord(response);
    return {
        output: response,
        isError: responseRecord?.isError === true || responseRecord?.is_error === true
    };
}

function incompleteToolResult(callId: string, pending: PendingToolCall): CodexMessage {
    const reason = 'Codex ended before the PostToolUse hook returned a result.';
    const output = pending.displayName === 'CodexBash'
        ? { stdout: '', stderr: reason, status: 'incomplete' }
        : { error: reason };

    return {
        type: 'tool-call-result',
        callId,
        output,
        is_error: true,
        id: randomUUID()
    };
}

export function isCodexToolHookEvent(data: Record<string, unknown>): boolean {
    return data.hook_event_name === 'PreToolUse' || data.hook_event_name === 'PostToolUse';
}

export class CodexToolHookBridge {
    private readonly pending = new Map<string, PendingToolCall>();
    private readonly observedCallIdsByTurn = new Map<string, Set<string>>();
    private readonly completedCallIdsByTurn = new Map<string, Set<string>>();

    private recordCall(map: Map<string, Set<string>>, turnId: string, callId: string): void {
        const callIds = map.get(turnId) ?? new Set<string>();
        callIds.add(callId);
        map.set(turnId, callIds);
    }

    handle(rawHook: Record<string, unknown>): CodexMessage[] {
        const parsed = CodexToolHookSchema.safeParse(rawHook);
        if (!parsed.success) return [];

        const hook = parsed.data;
        if (hook.agent_id || !isCodeModeToolUseId(hook.tool_use_id)) {
            return [];
        }

        const toolCall = toolCallFromHook(hook);
        if (!toolCall) return [];

        this.recordCall(this.observedCallIdsByTurn, hook.turn_id, hook.tool_use_id);

        if (hook.hook_event_name === 'PreToolUse') {
            if (this.pending.has(hook.tool_use_id)) return [];
            this.pending.set(hook.tool_use_id, { ...toolCall, turnId: hook.turn_id });
            return [{
                type: 'tool-call',
                name: toolCall.displayName,
                callId: hook.tool_use_id,
                input: toolCall.input,
                id: randomUUID()
            }];
        }

        const pending = this.pending.get(hook.tool_use_id) ?? { ...toolCall, turnId: hook.turn_id };
        const messages: CodexMessage[] = [];
        if (!this.pending.has(hook.tool_use_id)) {
            messages.push({
                type: 'tool-call',
                name: pending.displayName,
                callId: hook.tool_use_id,
                input: pending.input,
                id: randomUUID()
            });
        }

        const result = toolResultFromHook(pending.displayName, hook.tool_response);
        messages.push({
            type: 'tool-call-result',
            callId: hook.tool_use_id,
            output: result.output,
            ...(result.isError ? { is_error: true } : {}),
            id: randomUUID()
        });
        this.pending.delete(hook.tool_use_id);
        this.recordCall(this.completedCallIdsByTurn, hook.turn_id, hook.tool_use_id);
        return messages;
    }

    hasObservedNestedTool(turnId: string | undefined): boolean {
        return Boolean(turnId && (this.observedCallIdsByTurn.get(turnId)?.size ?? 0) > 0);
    }

    hasCompletedAllObservedNestedTools(turnId: string | undefined): boolean {
        if (!turnId) return false;
        const observed = this.observedCallIdsByTurn.get(turnId);
        const completed = this.completedCallIdsByTurn.get(turnId);
        if (!observed || observed.size === 0 || !completed || completed.size !== observed.size) {
            return false;
        }
        return Array.from(observed).every((callId) => completed.has(callId));
    }

    finishTurn(turnId: string): CodexMessage[] {
        const messages: CodexMessage[] = [];
        for (const [callId, pending] of this.pending) {
            if (pending.turnId !== turnId) continue;
            messages.push(incompleteToolResult(callId, pending));
            this.pending.delete(callId);
        }
        this.observedCallIdsByTurn.delete(turnId);
        this.completedCallIdsByTurn.delete(turnId);
        return messages;
    }

    finish(): CodexMessage[] {
        const messages = Array.from(this.pending, ([callId, pending]) => incompleteToolResult(callId, pending));
        this.pending.clear();
        this.observedCallIdsByTurn.clear();
        this.completedCallIdsByTurn.clear();
        return messages;
    }
}
