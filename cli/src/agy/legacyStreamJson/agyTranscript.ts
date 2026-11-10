import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import type { RawJSONLines } from '@/claude/types';
import { extractUserRequest } from './agyMessageText';

/**
 * One brain-transcript step, normalized for the late-continuation surfacer
 * (see `cli/src/agy/utils/agyLateContinuation.ts`, workaround for
 * google-antigravity/antigravity-cli#1461). `idx` equals the conversation
 * DB's `steps.idx` (verified 1:1 on agy 1.5.3/1.5.4 transcripts).
 */
export type AgyTranscriptStep = {
    idx: number
    kind: 'user_input' | 'ephemeral' | 'planner' | 'tool' | 'system' | 'other'
    status: 'done' | 'running' | 'error'
    createdAt: string | null
    content: string
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>
};

export function stepKindFromType(type: string): AgyTranscriptStep['kind'] {
    switch (type) {
        case 'USER_INPUT':
            return 'user_input';
        case 'EPHEMERAL_MESSAGE':
            return 'ephemeral';
        case 'PLANNER_RESPONSE':
            return 'planner';
        case 'SYSTEM_MESSAGE':
            return 'system';
        // 1.5.x writes tool executions as GENERIC; older builds named the tool.
        case 'GENERIC':
        case 'RUN_COMMAND':
        case 'VIEW_FILE':
        case 'LIST_DIRECTORY':
        case 'CODE_ACTION':
            return 'tool';
        default:
            return 'other';
    }
}

export function stepStatusFromType(status: string): AgyTranscriptStep['status'] {
    switch (status) {
        case 'RUNNING':
        case 'ACTIVE':
            return 'running';
        case 'ERROR':
            return 'error';
        default:
            return 'done';
    }
}

function parseTranscriptLine(line: string): AgyTranscriptStep | null {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    const idx = typeof raw.step_index === 'number' && Number.isSafeInteger(raw.step_index) ? raw.step_index : null;
    if (idx === null || typeof raw.type !== 'string') return null;
    const toolCalls = Array.isArray(raw.tool_calls)
        ? raw.tool_calls
            .filter((call): call is { name: string; args: Record<string, unknown> } => {
                return typeof call === 'object' && call !== null
                    && typeof (call as { name?: unknown }).name === 'string'
                    && typeof (call as { args?: unknown }).args === 'object'
                    && (call as { args?: unknown }).args !== null;
            })
            .map((call) => ({ name: call.name, args: call.args }))
        : [];
    return {
        idx,
        kind: stepKindFromType(raw.type),
        status: typeof raw.status === 'string' ? stepStatusFromType(raw.status) : 'done',
        createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
        content: typeof raw.content === 'string' ? raw.content : '',
        toolCalls
    };
}

/**
 * Incremental reader over one session's `transcript_full/NNNNNNNN.jsonl`
 * chunks: agy appends lines to the newest chunk and rolls to the next file at
 * ~100 KiB. The reader tracks the last file and byte offset, so each poll only
 * parses appended lines; a file that shrank below the offset (rewrite) is read
 * whole again and the caller dedupes by step idx.
 */
export class AgyTranscriptChunkReader {
    private lastFile: string | null = null;
    private offset = 0;

    constructor(private readonly dir: string) {}

    async readNew(): Promise<AgyTranscriptStep[]> {
        let files: string[];
        try {
            files = (await readdir(this.dir)).filter((name) => name.endsWith('.jsonl')).sort();
        } catch {
            return [];
        }
        if (files.length === 0) return [];

        const steps: AgyTranscriptStep[] = [];
        for (const file of files) {
            if (this.lastFile !== null && file < this.lastFile) continue;
            let text: string;
            try {
                text = await readFile(join(this.dir, file), 'utf8');
            } catch {
                continue;
            }
            const isTracked = file === this.lastFile;
            let startAt = 0;
            if (isTracked) {
                if (text.length < this.offset) {
                    // Rewritten/shrunk: re-read whole; the caller dedupes by idx.
                    startAt = 0;
                } else {
                    startAt = this.offset;
                }
            }
            const tail = text.slice(startAt);
            for (const line of tail.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const step = parseTranscriptLine(trimmed);
                if (step) steps.push(step);
            }
            this.lastFile = file;
            this.offset = text.length;
        }
        return steps;
    }
}

type AgyTranscriptClient = Pick<ApiSessionClient, 'sendClaudeSessionMessage' | 'sendUserMessage'>;

/**
 * Sends one stream-json transcript entry to the hub as the agy-specific chat
 * messages (`agy_message` prose, `agy_tool_action` tool cards).
 */
export function sendAgyTranscriptEntry(
    client: AgyTranscriptClient,
    entry: { type: string; content?: string; tool_calls?: { name: string; args: Record<string, unknown> }[]; step_index?: number; model?: string },
    conversationId?: string,
    // The tool CALL (name + args) that produced this action entry, paired by
    // the driver from the preceding PLANNER_RESPONSE. agy splits the
    // invocation (name/args live on the planner step) from its result (the
    // action entry's `content`), so without this the tool card has no input
    // to show — just the raw result. Carrying it here lets the web render a
    // command/path/args like the other flavors.
    toolCall?: { name: string; args: Record<string, unknown> }
): void {
    const isUser = entry.type === 'USER_INPUT'
    // agy appends its own sections (<ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>)
    // after the request block, so only the extracted request may be rendered.
    const text = isUser ? (extractUserRequest(entry.content ?? '') ?? entry.content ?? '').trim() : undefined

    if (isUser && text) {
        client.sendUserMessage(text)
        return
    }

    // agy's structured entry types map to distinct chat renderings:
    //  - PLANNER_RESPONSE → the agent's prose (agy_message). Its `tool_calls`
    //    are only the model's INTENT and are immediately followed by the real
    //    action entry below, so we intentionally don't render them separately
    //    (that produced a duplicate "view_file" + "View file" card).
    //  - every other type (VIEW_FILE, RUN_COMMAND, LIST_DIRECTORY, CODE_ACTION,
    //    …) is a tool ACTION whose `content` is its result. Render it as a
    //    collapsible tool card (agy_tool_action) instead of dumping the raw
    //    (often huge) result text as a chat bubble.
    let data: Record<string, unknown>
    if (entry.type !== 'PLANNER_RESPONSE') {
        // Key the tool card by conversationId:stepIdx so a gated tool's
        // approval card and its result merge into one card.
        const toolUseId = conversationId != null && entry.step_index != null
            ? `${conversationId}:${entry.step_index}`
            : undefined
        data = {
            type: 'agy_tool_action',
            name: entry.type,
            content: entry.content ?? '',
            toolUseId,
            // The invocation the web renders as the tool INPUT. `toolName` is
            // agy's own tool id (run_command, view_file, …) which the web maps
            // to a canonical presentation; `input` is the raw args.
            toolName: toolCall?.name,
            input: toolCall?.args
        }
    } else {
        // Tag the agent response with the model that produced it (per-turn).
        data = { type: 'agy_message', content: entry.content ?? '', model: entry.model }
    }
    // Sent as `{ role: 'agent', content: { type: 'output', data } }`, the
    // envelope the web's agy normalizer reads.
    client.sendClaudeSessionMessage(data as unknown as RawJSONLines)
}
