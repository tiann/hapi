import type { ApiSessionClient } from '@/api/apiSession';
import type { RawJSONLines } from '@/claude/types';
import { extractUserRequest } from './agyMessageText';

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
