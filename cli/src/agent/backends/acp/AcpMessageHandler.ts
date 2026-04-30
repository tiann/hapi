import type { AgentMessage, PlanItem } from '@/agent/types';
import { asString, isObject } from '@hapi/protocol';
import { deriveToolNameWithSource, isPlaceholderToolName } from '@/agent/utils';
import { parseRateLimitText } from '@/agent/rateLimitParser';
import { isInternalEventJson } from '@/agent/internalEventFilter';
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

/**
 * Fallback for ACP agents that omit `rawInput` and emit prose thoughts
 * (no JSON-form to hoist). The `tool_call` event still carries a
 * human-readable `title`, a structural `kind`, and (for file-touching tools)
 * a `locations` array. For known kinds we synthesize a minimal input object
 * so the UI does not display "Input: null" while the title shows
 * "README.md" / "ls -la /tmp".
 *
 * Conservative on purpose:
 * - `read` / `execute` / `search` derive from `title`, which in those kinds
 *   is the verbatim path / command / pattern.
 * - `edit` (file-write / file-replace) derives from `locations[0].path`;
 *   its title is prose ("Writing to foo.txt"), so the path must come from
 *   the structured locations field, not the title.
 * - `think` stays null — its title carries topic-update prose with no clean
 *   argument mapping; fabricating one would mislead.
 * - Unknown kinds fall through to null rather than guessing a shape.
 */
function deriveInputFromKindAndTitle(
    kind: string | null,
    title: string | null,
    locations: unknown
): Record<string, unknown> | null {
    if (kind === 'edit') {
        const arr = Array.isArray(locations) ? locations : [];
        const first = arr[0];
        const path = isObject(first) ? asString(first.path) : null;
        return path ? { file_path: path } : null;
    }
    if (!title) return null;
    switch (kind) {
        case 'read':
            return { file_path: title };
        case 'execute':
            return { command: title };
        case 'search':
            return { pattern: title };
        default:
            return null;
    }
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

/**
 * Normalizes the ACP `tool_call_update` content array sent by agents (e.g.
 * Gemini, OpenCode) that do not populate `rawOutput`.
 *
 * ACP ToolCallContent union (as emitted by Gemini CLI):
 *   - `{type:'content', content:{type:'text', text:…}}` — tool stdout/stderr
 *   - `{type:'diff', path, oldText, newText, _meta:{kind}}` — file edits
 *
 * Only normalizes unambiguous cases. Returns null for anything that cannot be
 * safely collapsed without losing information, so the caller can fall back to
 * the original content value.
 *
 * Returns:
 *   - string   — concatenated text from a pure-text-block array
 *   - object   — structured diff from a single-diff-block array
 *   - ""       — empty string when content array is empty (no visible output)
 *   - null     — non-array, mixed types, multiple diffs, or unknown block type;
 *                caller should pass through the original value unchanged
 */
function normalizeAcpToolContent(content: unknown): string | object | null {
    if (!Array.isArray(content)) {
        return null;
    }
    // Empty array: no display output from the agent (e.g. touch, silent command)
    if (content.length === 0) {
        return '';
    }
    // Classify every block. If any block has an unrecognized type or the array
    // contains a mix of text and diff blocks we cannot collapse losslessly, so
    // return null and let the caller fall back to the original content array.
    let diffCount = 0;
    let textCount = 0;
    const parts: string[] = [];
    let diffBlock: object | null = null;

    for (const block of content) {
        if (!isObject(block)) {
            return null; // Non-object element — unrecognized
        }
        if (block.type === 'diff') {
            diffCount++;
            if (diffCount > 1) {
                return null; // Multiple diffs cannot be merged into one object
            }
            diffBlock = {
                path: typeof block.path === 'string' ? block.path : undefined,
                oldText: typeof block.oldText === 'string' ? block.oldText : undefined,
                newText: typeof block.newText === 'string' ? block.newText : undefined,
                kind: isObject(block._meta) && typeof block._meta.kind === 'string' ? block._meta.kind : undefined
            };
        } else if (block.type === 'content' && isObject(block.content)) {
            const inner = block.content;
            if (inner.type === 'text' && typeof inner.text === 'string') {
                textCount++;
                parts.push(inner.text);
            } else {
                return null; // Unknown inner content type (e.g. image, resource)
            }
        } else {
            return null; // Unknown top-level block type
        }
    }

    // Mixed text + diff: cannot represent as a single value without losing data
    if (diffCount > 0 && textCount > 0) {
        return null;
    }

    return diffBlock ?? parts.join('');
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

    /**
     * Emits any buffered assistant text as a single message and clears the
     * buffer. Callers must treat this as a text-segment boundary: it is
     * invoked internally before tool_call / plan events and externally at
     * turn boundaries by AcpSdkBackend.
     */
    flushText(): void {
        if (!this.bufferedText) {
            return;
        }
        const text = this.bufferedText;
        this.bufferedText = '';
        this.onMessage({ type: 'text', text });
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
                // Check once whether the buffered text is a prefix of this
                // chunk (cumulative streaming). Used below by both the
                // rate-limit and internal-event filters to clear stale
                // prefixes that would otherwise leak on flushText().
                const hadBufferedPrefix = this.bufferedText !== '' && text.startsWith(this.bufferedText);

                const rateLimit = parseRateLimitText(text);
                if (rateLimit) {
                    if (hadBufferedPrefix) {
                        this.bufferedText = '';
                    }
                    if (rateLimit.suppress) {
                        return;
                    }
                    this.flushText();
                    this.onMessage(rateLimit.message);
                    return;
                }
                // Drop internal event JSON (e.g. { type: "output", data: { ... } })
                // that should never appear as visible text.
                if (isInternalEventJson(text)) {
                    if (hadBufferedPrefix) {
                        this.bufferedText = '';
                    }
                    return;
                }
                this.appendTextChunk(text);
            }
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.agentThoughtChunk) {
            // Thought chunks do not participate in intra-turn ordering and
            // must not flush the text buffer (that would split a live text
            // segment). Forward as a reasoning message so the web UI can
            // render the model's thinking in a collapsible block.
            //
            // Reasoning messages are emitted inline (never buffered), so they
            // arrive before any still-pending text segment is flushed. Tests
            // in this file rely on that contract.
            //
            // We deliberately do not reuse `extractTextContent` here: that
            // helper applies an assistant-audience filter which only makes
            // sense for regular message chunks. Thought content has no
            // meaningful audience — a non-assistant audience annotation
            // should not cause the reasoning to be silently dropped.
            const content = update.content;
            if (isObject(content) && content.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
                this.onMessage({ type: 'reasoning', text: content.text });
            }
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.toolCall) {
            // A new tool invocation closes the preceding text segment.
            // Flushing here preserves the arrival order between text and
            // tool lifecycle events without disturbing cumulative dedup
            // within a segment.
            this.flushText();
            this.handleToolCall(update);
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.toolCallUpdate) {
            // Do not flush here: a toolCallUpdate is a lifecycle event on
            // an already-open tool call, not a boundary between text
            // segments. If the agent streams a new text segment while the
            // tool is running, flushing here would leak that segment
            // across the tool_result boundary.
            this.handleToolCallUpdate(update);
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.plan) {
            this.flushText();
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
        // Priority: rawInput > kind+title fallback.
        // Use `in` to distinguish "rawInput key absent" from "rawInput is {}".
        const input = 'rawInput' in update
            ? update.rawInput
            : deriveInputFromKindAndTitle(asString(update.kind), asString(update.title), update.locations);
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
        } else if (existing) {
            // Enrich existing.input from update's kind+title when initial tool_call
            // had neither rawInput nor a hoistable thought. Re-emit when we just
            // enriched the input or when the call is still active.
            let input = existing.input;
            let name = existing.name;
            if (input == null) {
                const fallback = deriveInputFromKindAndTitle(asString(update.kind), asString(update.title), update.locations);
                if (fallback) {
                    input = fallback;
                    const derivedName = deriveToolNameFromUpdate(update);
                    name = this.selectToolNameForUpdate(existing.name ?? null, derivedName);
                    this.toolCalls.set(toolCallId, { name, input });
                }
            }
            const justEnriched = existing.input == null && input != null;
            if (status === 'in_progress' || status === 'pending' || justEnriched) {
                this.onMessage({
                    type: 'tool_call',
                    id: toolCallId,
                    name,
                    input,
                    status
                });
            }
        }

        if (status === 'completed' || status === 'failed') {
            // Prefer rawOutput (Claude/Codex path). When absent, normalize the
            // ACP content array sent by agents such as Gemini and OpenCode.
            // If content is not an array (normalizeAcpToolContent returns null),
            // fall back to the original content value to avoid silent data loss.
            let output: unknown;
            if (update.rawOutput !== undefined) {
                output = update.rawOutput;
            } else {
                const normalized = normalizeAcpToolContent(update.content);
                output = normalized !== null ? normalized : update.content;
            }
            this.onMessage({
                type: 'tool_result',
                id: toolCallId,
                output,
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
