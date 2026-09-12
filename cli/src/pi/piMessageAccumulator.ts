import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@/agent/types';
import { PiAssistantMessageEventSchema } from './schemas';
import type { PiAgentEvent } from './types';

const DEFAULT_SNAPSHOT_INTERVAL_MS = 250;

type PiMessageAccumulatorOptions = {
    snapshotIntervalMs?: number;
    now?: () => number;
    streamNonceFactory?: () => string;
};

type Segment = {
    text: string;
    lastSnapshot: string;
};

/**
 * Turns Pi's delta stream into throttled, cumulative snapshots. Pi content
 * blocks are independently indexed, so a message with multiple text or thinking
 * blocks never concatenates unrelated blocks into one timeline row. Every
 * accumulator instance has a nonce as a session resume/restart must not reuse a
 * previous timeline stream id.
 */
/**
 * Extract the failure text from a Pi assistant message that ended in error.
 *
 * On a mid-turn LLM/API failure (auth, 5xx, network drop) Pi finalizes the
 * assistant message with `stopReason: 'error'` and an `errorMessage`, emitted
 * on both `message_end` and `turn_end`. `aborted` is user-initiated (web Abort)
 * and intentionally not surfaced as an error. Returns null for anything else.
 */
export function extractPiTurnError(message: unknown): string | null {
    if (typeof message !== 'object' || message === null) return null;
    const record = message as { stopReason?: unknown; errorMessage?: unknown };
    if (record.stopReason !== 'error') return null;
    return typeof record.errorMessage === 'string' && record.errorMessage.length > 0
        ? record.errorMessage
        : 'Pi agent error';
}

export class PiMessageAccumulator {
    private active = false;
    private turnSequence = 0;
    private messageSequence = 0;
    private errorEmitted = false;
    private readonly streamNonce: string;
    private readonly textSegments = new Map<number, Segment>();
    private readonly reasoningSegments = new Map<number, Segment>();
    private lastSnapshotAt: number | null = null;
    private readonly snapshotIntervalMs: number;
    private readonly now: () => number;

    constructor(options: PiMessageAccumulatorOptions = {}) {
        this.snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
        this.now = options.now ?? Date.now;
        this.streamNonce = options.streamNonceFactory?.() ?? randomUUID();
    }

    handleEvent(event: PiAgentEvent): AgentMessage[] {
        if (event.type === 'turn_start') {
            this.turnSequence += 1;
            return [];
        }

        if (event.type === 'message_start') {
            const pending = this.active ? this.flush() : [];
            this.startMessage();
            return pending;
        }

        if (event.type === 'message_update') {
            if (!('assistantMessageEvent' in event)) return [];
            const parsed = PiAssistantMessageEventSchema.safeParse(event.assistantMessageEvent);
            if (!parsed.success || !this.active || !parsed.data.delta) return [];

            const index = parsed.data.contentIndex ?? 0;
            if (parsed.data.type === 'text_delta') {
                this.append(this.textSegments, index, parsed.data.delta);
            } else if (parsed.data.type === 'thinking_delta') {
                this.append(this.reasoningSegments, index, parsed.data.delta);
            } else {
                return [];
            }
            return this.snapshotIfDue();
        }

        if (event.type === 'message_end' || event.type === 'turn_end') {
            const wasActive = this.active;
            const errorMessage = 'message' in event ? extractPiTurnError(event.message) : null;
            // Error-finalized turns still need a non-live terminal text row so
            // the last visible partial response remains searchable.
            const messages = this.flush();
            // Pi reports the failure on both message_end and turn_end; emit the
            // error once (first boundary wins) so the web shows a failed turn
            // instead of silent partial text. turn_end doubles as the safety
            // net for Pi builds that skip message_end on stream failure.
            if (wasActive && !this.errorEmitted && errorMessage) {
                messages.push({ type: 'error', message: errorMessage });
                this.errorEmitted = true;
            }
            return messages;
        }

        if (event.type === 'agent_end') {
            return this.flush();
        }

        return [];
    }

    /** Explicit transport-close/error safety net. Idempotent after a flush. */
    flush(emitUnchangedTerminalText = true): AgentMessage[] {
        if (!this.active) return [];
        const snapshots = this.createSnapshots(false, emitUnchangedTerminalText);
        this.resetMessage();
        return snapshots;
    }

    private startMessage(): void {
        this.active = true;
        this.messageSequence += 1;
        this.errorEmitted = false;
        this.textSegments.clear();
        this.reasoningSegments.clear();
        this.lastSnapshotAt = null;
    }

    private append(segments: Map<number, Segment>, index: number, delta: string): void {
        const segment = segments.get(index) ?? { text: '', lastSnapshot: '' };
        segment.text += delta;
        segments.set(index, segment);
    }

    private snapshotIfDue(): AgentMessage[] {
        const now = this.now();
        if (this.lastSnapshotAt !== null && now - this.lastSnapshotAt < this.snapshotIntervalMs) {
            return [];
        }
        this.lastSnapshotAt = now;
        return this.createSnapshots(true);
    }

    private createSnapshots(live: boolean, emitUnchangedTerminalText = true): AgentMessage[] {
        const messages: AgentMessage[] = [];
        this.addSnapshots(messages, 'reasoning', this.reasoningSegments, live, emitUnchangedTerminalText);
        this.addSnapshots(messages, 'text', this.textSegments, live, emitUnchangedTerminalText);
        return messages;
    }

    private addSnapshots(
        output: AgentMessage[],
        kind: 'reasoning' | 'text',
        segments: Map<number, Segment>,
        live: boolean,
        emitUnchangedTerminalText: boolean,
    ): void {
        for (const [index, segment] of Array.from(segments.entries()).sort(([left], [right]) => left - right)) {
            const unchanged = segment.text === segment.lastSnapshot;
            const isUnchangedTerminalText = !live && kind === 'text' && emitUnchangedTerminalText;
            if (!segment.text.trim() || (unchanged && !isUnchangedTerminalText)) continue;
            segment.lastSnapshot = segment.text;
            const id = `pi-${this.streamNonce}-turn-${this.turnSequence}-message-${this.messageSequence}-${kind}-${index}`;
            output.push({
                type: kind,
                text: segment.text,
                id,
                ...(kind === 'text' ? { streamSnapshot: true } : {}),
                ...(live ? { live: true } : {}),
            });
        }
    }

    private resetMessage(): void {
        this.active = false;
        this.textSegments.clear();
        this.reasoningSegments.clear();
        this.lastSnapshotAt = null;
    }
}
