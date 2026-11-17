/**
 * Live streaming snapshots for the Claude remote launcher.
 *
 * With `--include-partial-messages` Claude emits `stream_event` entries
 * (text/thinking deltas) ahead of each complete assistant message. Without
 * them the remote session forwards only COMPLETE messages, so a phone user
 * watches a silent spinner for the whole model turn — the exact complaint
 * that DSH (which streams) never triggers.
 *
 * This emitter folds those deltas into the same wire shape the DSH/ACP path
 * already streams: growing `codex` live snapshots under a stable stream id,
 * throttled to a few per second. The hub keeps one row per stream (sweep) and
 * the web replaces the block in place (stream-id collapse), so no hub or web
 * snapshot handling had to change. The complete assistant message closes the
 * stream: the converter stamps the stream ids onto that settled line
 * (`streamId` / `reasoningStreamId`), which is what lets the settled row sweep
 * the live snapshots and the web replace the streaming bubble with the final
 * text.
 *
 * Only the FIRST text block and FIRST thinking block of a message stream:
 * multi-prose-block messages are rare and the settled-line marker semantics
 * are first-block-attach; later blocks simply appear at completion exactly as
 * they did before streaming existed. Sidechain (subagent) output is never
 * streamed — it carries no top-level markers, so it keeps today's behavior.
 */

import { randomUUID } from 'node:crypto';
import type { SDKAssistantMessage, SDKMessage, SDKStreamEventMessage } from '../sdk';

/** Live text snapshot wire shape (see agent/messageConverter.ts text variant). */
export type TextStreamSnapshot = {
    type: 'message';
    message: string;
    id: string;
    live: true;
    streamSnapshot: true;
};

/** Live reasoning snapshot wire shape (see agent/messageConverter.ts reasoning variant). */
export type ReasoningStreamSnapshot = {
    type: 'reasoning';
    message: string;
    id: string;
    live: true;
};

/**
 * Terminal snapshots (no `live` marker) close a stream that will never get a
 * settled line — aborted or errored turns. They carry the stream's final
 * partial text and are not sweepable, so they stay as the bubble's last word.
 */
export type TextStreamTerminal = {
    type: 'message';
    message: string;
    id: string;
    streamSnapshot: true;
};

export type ReasoningStreamTerminal = {
    type: 'reasoning';
    message: string;
    id: string;
};

export type StreamSnapshotMessage =
    | TextStreamSnapshot
    | ReasoningStreamSnapshot
    | TextStreamTerminal
    | ReasoningStreamTerminal;

/**
 * True for the live-snapshot wire shapes this module emits. Transcript lines
 * never use `type: 'message' | 'reasoning'` (those are agent-path payload
 * types), so this cannot collide with `RawJSONLines`.
 */
export function isStreamSnapshotMessage(value: unknown): value is StreamSnapshotMessage {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as { type?: unknown; message?: unknown; id?: unknown };
    return (candidate.type === 'message' || candidate.type === 'reasoning')
        && typeof candidate.message === 'string'
        && typeof candidate.id === 'string';
}

/** Stream ids the settled assistant line should carry so it supersedes its snapshots. */
export type SettledStreamMarkers = {
    streamId?: string;
    reasoningStreamId?: string;
};

export const TEXT_SNAPSHOT_THROTTLE_MS = 400;
export const REASONING_SNAPSHOT_THROTTLE_MS = 600;

/**
 * Stop streaming (but keep the settled-line markers) once a buffer grows past
 * this. Every snapshot re-sends the whole prefix, so an unbounded turn would
 * spend quadratic bandwidth; a terminal snapshot is not worth that. The
 * settled message still arrives and replaces the streamed prefix.
 */
export const MAX_STREAMED_PREFIX_CHARS = 64 * 1024;

type OpenStream = {
    streamId: string;
    buffer: string;
    /** Length of `buffer` when the last snapshot was emitted. */
    lastEmittedLength: number;
    lastEmitAt: number;
};

type StreamState = {
    /** API message id from message_start, when present. */
    messageId: string | null;
    text: OpenStream | null;
    reasoning: OpenStream | null;
    /** Content-block index of the first text / thinking block. */
    firstTextIndex: number | null;
    firstReasoningIndex: number | null;
};

function newStream(streamId: string, now: number): OpenStream {
    return { streamId, buffer: '', lastEmittedLength: -1, lastEmitAt: now };
}

export class ClaudeStreamSnapshotEmitter {
    private state: StreamState | null = null;

    constructor(
        private readonly send: (snapshot: StreamSnapshotMessage) => void,
        private readonly now: () => number = Date.now
    ) {}

    /** Consume one `stream_event` SDK message. Returns true when handled. */
    handleStreamEvent(message: SDKMessage): boolean {
        if (message.type !== 'stream_event') return false;
        // Sidechain (subagent) output never streams: no top-level markers, no
        // snapshots — identical to pre-streaming behavior.
        if (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id.length > 0) {
            return true;
        }
        const event = (message as SDKStreamEventMessage).event;
        if (!event || typeof event.type !== 'string') return true;

        if (event.type === 'message_start') {
            const inner = (event as { message?: { id?: unknown } }).message;
            const id = inner && typeof inner.id === 'string' && inner.id.length > 0 ? inner.id : null;
            this.state = {
                messageId: id,
                text: null,
                reasoning: null,
                firstTextIndex: null,
                firstReasoningIndex: null
            };
            return true;
        }

        if (event.type === 'content_block_start') {
            const state = this.state;
            if (!state) return true;
            const index = typeof event.index === 'number' ? event.index : null;
            const block = (event as { content_block?: { type?: unknown } }).content_block;
            const blockType = block && typeof block.type === 'string' ? block.type : null;
            if (index === null) return true;
            const stamp = this.now();
            if (blockType === 'text' && state.firstTextIndex === null) {
                state.firstTextIndex = index;
                state.text = newStream(this.deriveStreamId('text'), stamp);
            } else if (blockType === 'thinking' && state.firstReasoningIndex === null) {
                state.firstReasoningIndex = index;
                state.reasoning = newStream(this.deriveStreamId('reasoning'), stamp);
            }
            return true;
        }

        if (event.type === 'content_block_delta') {
            const state = this.state;
            if (!state) return true;
            const index = typeof event.index === 'number' ? event.index : null;
            if (index === null) return true;
            const delta = (event as { delta?: { type?: unknown; text?: unknown; thinking?: unknown } }).delta;
            if (!delta || typeof delta.type !== 'string') return true;

            if (delta.type === 'text_delta' && typeof delta.text === 'string' && index === state.firstTextIndex && state.text) {
                this.appendAndMaybeEmit(state.text, delta.text, TEXT_SNAPSHOT_THROTTLE_MS, 'text');
                return true;
            }
            if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && index === state.firstReasoningIndex && state.reasoning) {
                this.appendAndMaybeEmit(state.reasoning, delta.thinking, REASONING_SNAPSHOT_THROTTLE_MS, 'reasoning');
                return true;
            }
            // input_json_delta (tool args) and signature deltas do not stream.
            return true;
        }

        if (event.type === 'content_block_stop') {
            const state = this.state;
            if (!state) return true;
            const index = typeof event.index === 'number' ? event.index : null;
            if (index === null) return true;
            // Boundary flush: a block that just closed should show its final
            // prefix promptly instead of waiting out the throttle.
            if (index === state.firstTextIndex && state.text) {
                this.emitIfChanged(state.text, 'text');
            } else if (index === state.firstReasoningIndex && state.reasoning) {
                this.emitIfChanged(state.reasoning, 'reasoning');
            }
            return true;
        }

        // message_delta / message_stop / anything else: the complete assistant
        // message right after message_stop closes the stream via markers.
        return true;
    }

    /**
     * Stream markers for a complete assistant message, consuming the open
     * stream state. Null when nothing of this message was streamed.
     */
    takeSettledMarkers(assistant: SDKAssistantMessage): SettledStreamMarkers | null {
        const state = this.state;
        if (!state) return null;
        const messageId = (assistant.message as { id?: unknown } | undefined)?.id;
        // Ids are present in practice; if either side lacks one, trust the
        // sequential ordering (a settle arrives before the next message_start).
        const matches = typeof messageId !== 'string' || messageId.length === 0
            || state.messageId === null
            || messageId === state.messageId;
        let markers: SettledStreamMarkers | null = null;
        if (matches) {
            const streamId = state.text && state.text.lastEmittedLength > 0 ? state.text.streamId : undefined;
            const reasoningStreamId = state.reasoning && state.reasoning.lastEmittedLength > 0
                ? state.reasoning.streamId
                : undefined;
            if (streamId !== undefined || reasoningStreamId !== undefined) {
                markers = {};
                if (streamId !== undefined) markers.streamId = streamId;
                if (reasoningStreamId !== undefined) markers.reasoningStreamId = reasoningStreamId;
            }
        }
        this.state = null;
        return markers;
    }

    /**
     * Close any open streams with terminal (non-live) snapshots so an aborted
     * or errored turn does not leave a live bubble streaming forever. Called
     * at end of turn (result) and on abort.
     */
    finalizeOpenStreams(): void {
        const state = this.state;
        this.state = null;
        if (!state) return;
        if (state.text && state.text.lastEmittedLength > 0) {
            this.send({
                type: 'message',
                message: state.text.buffer,
                id: state.text.streamId,
                streamSnapshot: true
            });
        }
        if (state.reasoning && state.reasoning.lastEmittedLength > 0) {
            this.send({
                type: 'reasoning',
                message: state.reasoning.buffer,
                id: state.reasoning.streamId
            });
        }
    }

    private deriveStreamId(kind: 'text' | 'reasoning'): string {
        const base = this.state?.messageId ?? randomUUID();
        return `claude-${base}-${kind}`;
    }

    private appendAndMaybeEmit(stream: OpenStream, chunk: string, throttleMs: number, kind: 'text' | 'reasoning'): void {
        if (stream.buffer.length > MAX_STREAMED_PREFIX_CHARS) return; // oversize: freeze the stream
        stream.buffer += chunk;
        if (stream.buffer.length > MAX_STREAMED_PREFIX_CHARS) return;
        const now = this.now();
        // First snapshot goes out immediately (lastEmittedLength < 0): the
        // first token is exactly the "it's alive" signal this module exists for.
        if (stream.lastEmittedLength >= 0 && now - stream.lastEmitAt < throttleMs) return;
        this.emit(stream, kind, now);
    }

    private emitIfChanged(stream: OpenStream, kind: 'text' | 'reasoning'): void {
        if (stream.lastEmittedLength === stream.buffer.length) return;
        this.emit(stream, kind, this.now());
    }

    private emit(stream: OpenStream, kind: 'text' | 'reasoning', now: number): void {
        if (stream.buffer.length === 0) return;
        stream.lastEmitAt = now;
        stream.lastEmittedLength = stream.buffer.length;
        if (kind === 'text') {
            this.send({ type: 'message', message: stream.buffer, id: stream.streamId, live: true, streamSnapshot: true });
        } else {
            this.send({ type: 'reasoning', message: stream.buffer, id: stream.streamId, live: true });
        }
    }
}
