import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { AgentMessage, PlanItem } from '@/agent/types';
import { registerGeneratedImageFromAcpBlock } from '@/modules/common/generatedImages';
import type { InlineMediaSource } from '@/modules/common/inlineMediaSource';
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

/**
 * OpenCode ACP often emits `rawInput: {}` on tool start / permission requests
 * before (or after) the real arguments arrive. An empty object is not usable
 * tool input — treating it as valid blocks kind+title/content fallbacks and can
 * clobber a previously captured non-empty input.
 */
function isUsableRawInput(value: unknown): boolean {
    if (value == null) return false;
    if (isObject(value) && Object.keys(value).length === 0) return false;
    return true;
}

function resolveToolInputFallbacks(
    kind: string | null,
    title: string | null,
    locations: unknown,
    content: unknown
): unknown {
    const fromKindTitle = deriveInputFromKindAndTitle(kind, title, locations);
    if (fromKindTitle) return fromKindTitle;
    return extractJsonInputFromContent(content);
}

type DerivedToolName = ReturnType<typeof deriveToolNameWithSource>;

const REASONING_SNAPSHOT_INTERVAL_MS = 250;

/**
 * Extracts _meta.kind from the first diff block in a content array.
 * Returns null when content is not an array, is empty, or the first block
 * is not a diff with a string _meta.kind.
 */
function extractMetaKindFromContent(content: unknown): string | null {
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0];
    if (!isObject(first) || first.type !== 'diff') return null;
    if (!isObject(first._meta)) return null;
    return typeof first._meta.kind === 'string' ? first._meta.kind : null;
}

function deriveToolNameFromUpdate(update: Record<string, unknown>): DerivedToolName {
    return deriveToolNameWithSource({
        title: asString(update.title),
        kind: asString(update.kind),
        rawInput: update.rawInput,
        metaKind: extractMetaKindFromContent(update.content)
    });
}

/**
 * Normalises a kind string to a canonical category. Different ACP agents
 * (Gemini, OpenCode, Kimi) use different vocabulary for the same semantic
 * operation; mapping them here keeps the rest of the handler agent-agnostic.
 */
function normalizeToolKind(kind: string | null): 'read' | 'execute' | 'search' | 'edit' | 'think' | null {
    if (!kind) return null;
    const k = kind.toLowerCase().trim();
    if (k === 'read' || k === 'read_file' || k === 'file_read' || k === 'view') return 'read';
    if (k === 'execute' || k === 'shell' || k === 'bash' || k === 'run' || k === 'run_shell' || k === 'run_shell_command' || k === 'cmd' || k === 'terminal') return 'execute';
    if (k === 'search' || k === 'grep' || k === 'find' || k === 'glob') return 'search';
    if (k === 'edit' || k === 'write' || k === 'write_file' || k === 'replace' || k === 'file_edit' || k === 'modify') return 'edit';
    if (k === 'think' || k === 'thought' || k === 'reasoning') return 'think';
    return null;
}

/**
 * Extracts the argument from a title that uses a "Category: argument" pattern.
 * Many ACP agents (notably Kimi) emit titles like "Shell: free -h" or
 * "Read: README.md" where the part after the colon is the actual tool argument.
 *
 * Only strips the prefix when the label before the colon normalizes to the
 * same tool kind, so valid commands/paths that contain colons (e.g.
 * curl http://localhost:3000, git commit -m "feat: add Kimi") are not corrupted.
 * Returns the raw title when no matching prefix is found.
 */
function extractTitleArgument(title: string, kind: string | null): string {
    const normalizedKind = normalizeToolKind(kind);
    const match = title.match(/^([A-Za-z][A-Za-z _-]{0,31}):\s+(.+)$/);
    if (!match) return title;
    const labelKind = normalizeToolKind(match[1]);
    return labelKind && labelKind === normalizedKind ? match[2] : title;
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
    const normalizedKind = normalizeToolKind(kind);
    if (normalizedKind === 'edit') {
        const arr = Array.isArray(locations) ? locations : [];
        const first = arr[0];
        const path = isObject(first) ? asString(first.path) : null;
        return path ? { file_path: path } : null;
    }
    if (!title) return null;
    const arg = extractTitleArgument(title, kind);
    switch (normalizedKind) {
        case 'read':
            return { file_path: arg };
        case 'execute':
            return { command: arg };
        case 'search':
            return { pattern: arg };
        default:
            return null;
    }
}

/**
 * Kimi ACP streams tool arguments as JSON text inside the `content` array
 * (e.g. `[{type:'content', content:{type:'text', text:'{"command":"df -h"}'}}]`)
 * instead of using `rawInput`. This helper extracts and parses that JSON.
 *
 * Returns the parsed object when the content is a single text block whose text
 * is valid JSON object / array. Returns null for anything else so callers can
 * keep their existing fallback.
 */
function extractJsonInputFromContent(content: unknown): Record<string, unknown> | unknown[] | null {
    if (!Array.isArray(content) || content.length !== 1) return null;
    const block = content[0];
    if (!isObject(block)) return null;
    if (block.type !== 'content') return null;
    const inner = block.content;
    if (!isObject(inner)) return null;
    if (inner.type !== 'text') return null;
    const text = typeof inner.text === 'string' ? inner.text : null;
    if (!text || text.trim().length === 0) return null;
    // Defensive: only parse when it looks like JSON (starts with { or [)
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed as Record<string, unknown> | unknown[];
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Detects whether an existing tool input was derived from a placeholder title
 * that did not yet contain the actual argument. This happens with agents like
 * Kimi that send an initial tool_call with a generic title ("Shell") and later
 * update it to a concrete one ("Shell: free -h").
 *
 * Returns true when:
 *   - the update title contains a colon (indicating it carries the real arg)
 *   - the existing input is a derived object whose value matches the OLD title
 */
function isStaleDerivedInput(existingInput: unknown, updateTitle: string | null, kind: string | null): boolean {
    if (!updateTitle) return false;
    const arg = extractTitleArgument(updateTitle, kind);
    // No colon in title — nothing to extract, not stale
    if (arg === updateTitle) return false;
    if (!isObject(existingInput)) return false;
    const values = Object.values(existingInput);
    for (const value of values) {
        if (typeof value === 'string' && value.trim() === arg) {
            // Input already matches the new argument — not stale
            return false;
        }
    }
    return true;
}

type HoistedDiff =
    | { name: 'Write'; input: { file_path: string; content: string } }
    | { name: 'Edit'; input: { file_path: string; old_string: string; new_string: string } };

/**
 * Hoists the first diff block from a Gemini ACP content array into a
 * Claude-shaped tool input so the existing Write/Edit web views can render it.
 *
 * Mapping (mirrors the Gemini ACP quirks spec, see
 * __fixtures__/gemini-3-flash-preview-{write,edit}-file.json):
 *   _meta.kind='add'    → { name: 'Write', input: {file_path, content: newText} }
 *   _meta.kind='modify' → { name: 'Edit',  input: {file_path, old_string, new_string} }
 *
 * Returns null when:
 *   - content is not an array or is empty
 *   - the first block is not a diff type
 *   - _meta.kind is absent or unrecognised (let callers keep the existing fallback)
 */
function hoistDiffContentIntoInput(content: unknown): HoistedDiff | null {
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0];
    if (!isObject(first) || first.type !== 'diff') return null;

    const path = typeof first.path === 'string' ? first.path : null;
    if (!path) return null;

    const metaKind = isObject(first._meta) && typeof first._meta.kind === 'string'
        ? first._meta.kind
        : null;

    if (metaKind === 'add') {
        const newText = typeof first.newText === 'string' ? first.newText : '';
        return { name: 'Write', input: { file_path: path, content: newText } };
    }
    if (metaKind === 'modify') {
        const oldText = typeof first.oldText === 'string' ? first.oldText : '';
        const newText = typeof first.newText === 'string' ? first.newText : '';
        return { name: 'Edit', input: { file_path: path, old_string: oldText, new_string: newText } };
    }

    return null;
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

export type AcpTextChunkMode = 'dedupe' | 'delta';

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
    // Array buffer avoids the O(N²) string concatenation that per-token
    // ACP streams (OpenCode/Zen emits one chunk per generated token) would
    // otherwise incur — a 10k-token reasoning trace allocates 10k full-buffer
    // copies if we use `+=`.
    private bufferedReasoning: string[] = [];
    private reasoningStreamId: string | null = null;
    private lastReasoningSnapshotAt: number | null = null;
    private lastReasoningSnapshotText = '';
    private reasoningSnapshotEmitted = false;
    private readonly textChunkMode: AcpTextChunkMode;

    constructor(
        private readonly onMessage: (message: AgentMessage) => void,
        private readonly options: { textChunkMode?: AcpTextChunkMode; flavor?: string } = {}
    ) {
        this.textChunkMode = this.options.textChunkMode ?? 'dedupe';
    }

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

    /**
     * Emits buffered thought chunks as a single reasoning message and clears
     * the buffer. ACP agents (notably OpenCode/Zen) stream thoughts at the
     * granularity of one chunk per token; raw per-token messages would make
     * the web reducer render one row per token. We stream throttled full-text
     * snapshots with a stable id while the buffer is open, then emit one final
     * message with the same id at the boundary.
     *
     * Called automatically before visible boundaries inside `handleUpdate`
     * (assistant text, tool lifecycle, plan), and externally at turn
     * boundaries by `drainBuffers` from AcpSdkBackend.
     *
     * Whitespace-only buffers are dropped: a turn that happens to emit a
     * single whitespace token would otherwise render an empty Reasoning row
     * in the web UI.
     */
    flushReasoning(): void {
        if (this.bufferedReasoning.length === 0) {
            return;
        }
        const text = this.bufferedReasoning.join('');
        const id = this.reasoningSnapshotEmitted ? this.reasoningStreamId ?? undefined : undefined;
        this.resetReasoningState();
        if (text.trim().length === 0) {
            return;
        }
        this.onMessage(id ? { type: 'reasoning', text, id } : { type: 'reasoning', text });
    }

    /**
     * Single entry point for turn-boundary draining. Reasoning is always
     * flushed before text so that, even when the agent streamed thoughts
     * after a text segment had already opened, the final rendered turn
     * shows the Reasoning block above the answer (matching the web UI
     * component layout). This is a deliberate UX-driven ordering — not
     * a preservation of the agent's arrival order, which could place
     * text before reasoning within a single turn. Callers in
     * `AcpSdkBackend` must use this rather than the individual flush
     * methods to keep the order invariant enforced in one place.
     */
    drainBuffers(): void {
        this.flushReasoning();
        this.flushText();
    }

    private appendTextChunk(text: string): void {
        if (this.textChunkMode === 'delta') {
            if (text) {
                this.bufferedText += text;
            }
            return;
        }

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

    private appendReasoningChunk(text: string): void {
        if (!text) {
            return;
        }
        this.bufferedReasoning.push(text);
        if (!this.reasoningStreamId) {
            this.reasoningStreamId = randomUUID();
        }
        this.emitReasoningSnapshotIfDue();
    }

    private emitReasoningSnapshotIfDue(): void {
        if (!this.reasoningStreamId) {
            return;
        }

        const now = Date.now();
        if (this.lastReasoningSnapshotAt === null) {
            this.lastReasoningSnapshotAt = now;
            return;
        }
        if (now - this.lastReasoningSnapshotAt < REASONING_SNAPSHOT_INTERVAL_MS) {
            return;
        }

        const text = this.bufferedReasoning.join('');
        if (text.trim().length === 0 || text === this.lastReasoningSnapshotText) {
            this.lastReasoningSnapshotAt = now;
            return;
        }

        this.lastReasoningSnapshotAt = now;
        this.lastReasoningSnapshotText = text;
        this.reasoningSnapshotEmitted = true;
        this.onMessage({
            type: 'reasoning',
            text,
            id: this.reasoningStreamId,
            live: true
        });
    }

    private resetReasoningState(): void {
        this.bufferedReasoning = [];
        this.reasoningStreamId = null;
        this.lastReasoningSnapshotAt = null;
        this.lastReasoningSnapshotText = '';
        this.reasoningSnapshotEmitted = false;
    }

    handleUpdate(update: unknown): void {
        if (!isObject(update)) return;
        const updateType = asString(update.sessionUpdate);
        if (!updateType) return;

        if (updateType === ACP_SESSION_UPDATE_TYPES.agentThoughtChunk) {
            // Thought chunks do not participate in intra-turn ordering and
            // must not flush the text buffer (that would split a live text
            // segment). Coalesce them into a single reasoning buffer so the
            // web UI renders one Reasoning block per turn segment instead
            // of one row per streaming token.
            //
            // We deliberately do not reuse `extractTextContent` here: that
            // helper applies an assistant-audience filter which only makes
            // sense for regular message chunks. Thought content has no
            // meaningful audience — a non-assistant audience annotation
            // should not cause the reasoning to be silently dropped.
            const content = update.content;
            if (isObject(content) && content.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
                this.appendReasoningChunk(content.text);
            }
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.agentMessageChunk) {
            const content = update.content;
            if (isObject(content) && content.type === 'image') {
                this.flushReasoning();
                this.flushText();
                void this.emitGeneratedImageFromAcpContent(content);
                return;
            }
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
                    this.flushReasoning();
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
                // Visible assistant text is a reasoning-segment boundary:
                // emit accumulated thoughts first so the rendered turn keeps
                // Reasoning above the answer. Empty / filtered message chunks
                // are not boundaries; OpenCode can interleave bookkeeping
                // updates while streaming thoughts, and flushing on those
                // would split reasoning back into one row per token.
                this.flushReasoning();
                this.appendTextChunk(text);
            }
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.toolCall) {
            this.flushReasoning();
            // A new tool invocation closes the preceding text segment.
            // Flushing here preserves the arrival order between text and
            // tool lifecycle events without disturbing cumulative dedup
            // within a segment.
            this.flushText();
            this.handleToolCall(update);
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.toolCallUpdate) {
            this.flushReasoning();
            // Do not flush text here: a toolCallUpdate is a lifecycle event
            // on an already-open tool call, not a boundary between text
            // segments. If the agent streams a new text segment while the
            // tool is running, flushing text here would leak that segment
            // across the tool_result boundary. Reasoning is separate and is
            // flushed above so tool results still appear after the thought
            // that led to them.
            this.handleToolCallUpdate(update);
            return;
        }

        if (updateType === ACP_SESSION_UPDATE_TYPES.plan) {
            this.flushReasoning();
            this.flushText();
            const items = normalizePlanEntries(update.entries);
            if (items.length > 0) {
                this.onMessage({ type: 'plan', items });
            }
        }
    }

    private async emitGeneratedImageFromAcpContent(content: Record<string, unknown>): Promise<void> {
        try {
            const image = await registerGeneratedImageFromAcpBlock(content);
            if (!image) {
                return;
            }
            this.onMessage({
                type: 'generated_image',
                imageId: image.id,
                fileName: image.fileName,
                mimeType: image.mimeType,
                source: this.buildAcpInlineMediaSource(),
            });
        } catch (error) {
            logger.debug(
                '[AcpMessageHandler] Failed to register ACP image block:',
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private buildAcpInlineMediaSource(): InlineMediaSource {
        const source: InlineMediaSource = { ingress: 'acp' };
        if (this.options?.flavor) {
            source.flavor = this.options.flavor;
        }
        return source;
    }

    private handleToolCall(update: Record<string, unknown>): void {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return;

        // Initial tool_call events (in_progress) never carry a completed diff block,
        // so metaKind is always null here. Pass it explicitly to prevent a silent
        // Write/Edit promotion if content ever appears unexpectedly on this path.
        const derivedName = deriveToolNameWithSource({
            title: asString(update.title),
            kind: asString(update.kind),
            rawInput: update.rawInput,
            metaKind: null
        });
        const name = derivedName.name;
        // Priority: usable rawInput > kind+title fallback > content JSON fallback.
        // Empty `{}` is treated as missing (OpenCode tool-start / permission clobber).
        // Kimi ACP streams tool arguments as JSON text in the content array
        // instead of rawInput/kind. Try all three sources.
        const candidate = isUsableRawInput(update.rawInput)
            ? update.rawInput
            : resolveToolInputFallbacks(
                asString(update.kind),
                asString(update.title),
                update.locations,
                update.content
            );
        // Content JSON can be `{}` (same as unusable rawInput); never lock that in.
        const input = isUsableRawInput(candidate) ? candidate : null;
        const status = normalizeStatus(update.status);

        this.toolCalls.set(toolCallId, { name, input });

        this.onMessage({
            type: 'tool_call',
            id: toolCallId,
            name,
            input,
            status,
            ...(asString(update.title) ? { title: asString(update.title)! } : {}),
            ...(asString(update.kind) ? { kind: asString(update.kind)! } : {})
        });
    }

    private handleToolCallUpdate(update: Record<string, unknown>): void {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return;

        const status = normalizeStatus(update.status);
        const existing = this.toolCalls.get(toolCallId);
        const presentation = {
            ...(asString(update.title) ? { title: asString(update.title)! } : {}),
            ...(asString(update.kind) ? { kind: asString(update.kind)! } : {})
        };

        if (isUsableRawInput(update.rawInput)) {
            const derivedName = deriveToolNameFromUpdate(update);
            const name = this.selectToolNameForUpdate(existing?.name ?? null, derivedName);
            const input = update.rawInput;
            this.toolCalls.set(toolCallId, { name, input });
            this.onMessage({
                type: 'tool_call',
                id: toolCallId,
                name,
                input,
                status,
                ...presentation
            });
        } else if (existing) {
            // Enrich existing.input from update's kind+title when initial tool_call
            // had neither usable rawInput nor a hoistable thought. Never let an
            // empty `rawInput: {}` (OpenCode permission / start) clobber a good input.
            // Re-emit when we just enriched the input or when the call is still active.
            let input = existing.input;
            let name = existing.name;
            let rederived = false;
            const updateTitle = asString(update.title);
            if (!isUsableRawInput(input) || isStaleDerivedInput(input, updateTitle, asString(update.kind))) {
                const fallback = resolveToolInputFallbacks(
                    asString(update.kind),
                    updateTitle,
                    update.locations,
                    update.content
                );
                if (isUsableRawInput(fallback)) {
                    input = fallback;
                    const derivedName = deriveToolNameFromUpdate(update);
                    name = this.selectToolNameForUpdate(existing.name ?? null, derivedName);
                    this.toolCalls.set(toolCallId, { name, input });
                    rederived = true;
                }
            }
            const justEnriched = (!isUsableRawInput(existing.input) && isUsableRawInput(input)) || rederived;
            if (status === 'in_progress' || status === 'pending' || justEnriched) {
                this.onMessage({
                    type: 'tool_call',
                    id: toolCallId,
                    name,
                    input,
                    status,
                    ...presentation
                });
            }
        }

        if (status === 'completed' || status === 'failed') {
            // For Gemini ACP kind=edit tools: when the completed update carries a
            // diff content block, hoist it into a Claude-shaped input so the
            // existing Write/Edit web views receive the right shape. The name is
            // also upgraded from the prose title to 'Write' or 'Edit' based on
            // _meta.kind — this intentionally bypasses the title-wins rule because
            // the title for edit tools is always prose ("Writing to foo.txt") and
            // _meta.kind is the authoritative semantic signal.
            //
            // Only runs on status=completed (not failed): a failed write_file must never
            // promote the tool name to Write/Edit, as no diff was actually applied.
            // Skip when a usable rawInput already supplied the input above.
            if (status === 'completed' && !isUsableRawInput(update.rawInput) && existing) {
                const hoisted = hoistDiffContentIntoInput(update.content);
                if (hoisted) {
                    this.toolCalls.set(toolCallId, { name: hoisted.name, input: hoisted.input });
                    this.onMessage({
                        type: 'tool_call',
                        id: toolCallId,
                        name: hoisted.name,
                        input: hoisted.input,
                        status,
                        ...presentation
                    });
                }
            }

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
