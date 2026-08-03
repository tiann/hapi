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
export class PiMessageAccumulator {
    private active = false;
    private turnSequence = 0;
    private messageSequence = 0;
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

        if (event.type === 'message_end' || event.type === 'turn_end' || event.type === 'agent_end') {
            return this.flush();
        }

        return [];
    }

    /** Explicit transport-close/error safety net. Idempotent after a flush. */
    flush(): AgentMessage[] {
        if (!this.active) return [];
        const snapshots = this.createSnapshots(false);
        this.resetMessage();
        return snapshots;
    }

    private startMessage(): void {
        this.active = true;
        this.messageSequence += 1;
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

    private createSnapshots(live: boolean): AgentMessage[] {
        const messages: AgentMessage[] = [];
        this.addSnapshots(messages, 'reasoning', this.reasoningSegments, live);
        this.addSnapshots(messages, 'text', this.textSegments, live);
        return messages;
    }

    private addSnapshots(
        output: AgentMessage[],
        kind: 'reasoning' | 'text',
        segments: Map<number, Segment>,
        live: boolean,
    ): void {
        for (const [index, segment] of Array.from(segments.entries()).sort(([left], [right]) => left - right)) {
            if (!segment.text.trim() || segment.text === segment.lastSnapshot) continue;
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
