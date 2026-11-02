import { isObject } from '@hapi/protocol';

type RecordValue = Record<string, unknown>;
export type OpencodeCompactionTrigger = 'auto' | 'manual' | undefined;
export type OpencodeNativeText = {
    id: string;
    messageId: string;
    role: string;
    type: 'text' | 'reasoning';
    text: string;
    complete: boolean;
};

/** Native IDs and parent links, never prompt wording, identify internal output. */
export class OpencodeCompactionProjector {
    private readonly messages = new Map<string, RecordValue>();
    private readonly parts = new Map<string, RecordValue>();
    private readonly emitted = new Set<string>();
    private readonly started = new Set<string>();
    private readonly emittedText = new Map<string, string>();

    constructor(private readonly options: {
        sessionId: string;
        onSummary: (id: string, summary: string, trigger: OpencodeCompactionTrigger) => void;
        onText?: (part: OpencodeNativeText) => void;
        onFailure?: (id: string, trigger: OpencodeCompactionTrigger) => void;
        onStart?: (id: string, trigger: OpencodeCompactionTrigger) => void;
    }) {}

    message(info: RecordValue): void {
        if (info.sessionID !== this.options.sessionId || typeof info.id !== 'string') return;
        this.messages.set(info.id, info);
        this.projectText([...this.parts.values()].filter(part => part.messageID === info.id));
    }

    part(part: RecordValue): void {
        if (part.sessionID !== this.options.sessionId || typeof part.id !== 'string') return;
        this.parts.set(part.id, part);
        this.projectText([part]);
    }

    snapshot(entries: unknown, liveParts: readonly RecordValue[] = [], replayLiveText = false): void {
        if (!Array.isArray(entries)) return;
        // Metadata/markers must precede text, including on startup/reconnect.
        for (const entry of entries) {
            if (!isObject(entry)) continue;
            const info = isObject(entry.info) ? entry.info : entry;
            if (info.sessionID === this.options.sessionId && typeof info.id === 'string') this.messages.set(info.id, info);
            if (Array.isArray(entry.parts)) {
                for (const part of entry.parts) {
                    if (isObject(part) && part.sessionID === this.options.sessionId && typeof part.id === 'string') this.parts.set(part.id, part);
                }
            }
        }
        // A v1 durable snapshot may lag already observed live text deltas.
        // Revalidate those parts against the snapshot's metadata before replay.
        for (const part of liveParts) {
            if (part.sessionID !== this.options.sessionId || typeof part.id !== 'string') continue;
            this.parts.set(part.id, part);
            if (replayLiveText) this.emittedText.delete(part.id);
        }
        this.flush();
    }

    /** Native application has begun. Background preparation has no public start record. */
    start(id: string, trigger: OpencodeCompactionTrigger): void {
        if (this.started.has(id) || this.emitted.has(id) || this.emitted.has(`failed:${id}`)) return;
        this.started.add(id);
        this.options.onStart?.(id, trigger);
    }

    /** Call after a terminal native update or a complete storage scan. */
    flush(): void {
        for (const info of this.messages.values()) {
            const id = info.id as string;
            if (info.type === 'compaction') {
                if (this.emitted.has(id) || this.emitted.has(`failed:${id}`)) continue;
                if (info.status === 'running') this.start(id, info.reason === 'auto' ? 'auto' : info.reason === 'manual' ? 'manual' : undefined);
                if (info.status === 'failed' || info.status === 'error') this.fail(id, info.reason === 'auto' ? 'auto' : info.reason === 'manual' ? 'manual' : undefined);
                if (info.status === 'completed' && typeof info.summary === 'string') {
                    this.emit(id, info.summary, info.reason === 'auto' ? 'auto' : info.reason === 'manual' ? 'manual' : undefined);
                }
                continue;
            }
            if (info.role === 'assistant' && info.summary === true && info.error && typeof info.parentID === 'string') this.fail(info.parentID, this.trigger(info.parentID));
            if (info.role !== 'assistant' || info.summary !== true || info.error
                || typeof info.finish !== 'string' || !info.finish.trim() || typeof info.parentID !== 'string') continue;
            const parent = this.messages.get(info.parentID);
            if (parent?.role !== 'user') continue;
            const marker = [...this.parts.values()].some(p => p.messageID === parent.id && p.type === 'compaction');
            if (!marker) continue;
            const siblings = [...this.messages.values()].filter(m => m.role === 'assistant' && m.parentID === parent.id && m.summary === true);
            if (siblings.length !== 1) continue;
            const text = [...this.parts.values()].filter(p => p.messageID === id && p.type === 'text' && typeof p.text === 'string')
                .map(p => p.text as string).join('\n\n');
            if (text.trim()) this.emit(info.parentID, text, this.trigger(info.parentID));
        }
        this.projectText();
    }

    private projectText(parts: Iterable<RecordValue> = this.parts.values()): void {
        for (const part of parts) {
            if ((part.type !== 'text' && part.type !== 'reasoning') || typeof part.text !== 'string') continue;
            const info = typeof part.messageID === 'string' ? this.messages.get(part.messageID) : undefined;
            if (!info || info.summary === true || info.type === 'compaction' || part.ignored === true) continue;
            if (part.synthetic === true && isObject(part.metadata) && part.metadata.compaction_continue === true) continue;
            if (info.role !== 'user' && info.role !== 'assistant') continue;
            const complete = info.role === 'user' || part.synthetic === true || (isObject(part.time) && typeof part.time.end === 'number');
            const signature = JSON.stringify([part.text, complete]);
            if (this.emittedText.get(part.id as string) === signature) continue;
            this.emittedText.set(part.id as string, signature);
            this.options.onText?.({ id: part.id as string, messageId: part.messageID as string, role: info.role,
                type: part.type, text: part.text, complete });
        }
    }

    private trigger(parentID: string): OpencodeCompactionTrigger {
        const marker = [...this.parts.values()].find(p => p.messageID === parentID && p.type === 'compaction');
        return marker?.auto === true ? 'auto' : marker?.auto === false ? 'manual' : undefined;
    }

    private fail(id: string, trigger: OpencodeCompactionTrigger): void {
        if (trigger === undefined) return;
        const key = `failed:${id}`;
        if (this.emitted.has(key)) return;
        this.emitted.add(key);
        this.options.onFailure?.(id, trigger);
    }

    private emit(id: string, summary: string, trigger: OpencodeCompactionTrigger): void {
        if (this.emitted.has(id)) return;
        this.emitted.add(id);
        this.options.onSummary(id, summary, trigger);
    }
}

export function opencodeCompactionEventId(sessionId: string, id: string): string {
    return `opencode:${sessionId}:compaction:${id}`;
}
