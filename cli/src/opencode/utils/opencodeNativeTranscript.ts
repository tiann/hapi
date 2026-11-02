import { isObject } from '@hapi/protocol';
import type { FetchLike } from './opencodeCompactBridge';
import { logger } from '@/ui/logger';
import { OpencodeCompactionProjector, type OpencodeNativeText, type OpencodeCompactionTrigger } from './opencodeCompactionProjector';

/** Supplements SSE with read-only snapshots after reconnect and each prompt. */
export class OpencodeNativeTranscript {
    private readonly attachedAt = Date.now();
    private readonly controller = new AbortController();
    private readonly projector: OpencodeCompactionProjector;
    private readonly parts = new Map<string, Record<string, unknown>>();
    private refreshing: Promise<void> | null = null;
    private revision = 0;
    private refreshAgain = false;
    private readFailureReported = false;
    private closed = false;
    private initializing = true;
    private readonly liveTextParts = new Set<string>();
    private readonly initialText = new Map<string, OpencodeNativeText>();
    private readonly unbasedDeltas = new Map<string, string>();
    private readonly pendingText = new Map<string, OpencodeNativeText>();
    private readonly textTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly options: {
        baseUrl: string;
        sessionId: string;
        directory: string;
        mode: 'v1' | 'v2';
        headers?: Record<string, string>;
        onSummary: (id: string, summary: string, trigger: OpencodeCompactionTrigger) => void;
        onText: (part: OpencodeNativeText) => void;
        onFailure?: (id: string, trigger: OpencodeCompactionTrigger) => void;
        onStart?: (id: string, trigger: OpencodeCompactionTrigger) => void;
        onReadFailure?: () => void;
        fetchImpl?: FetchLike;
    }) {
        this.projector = new OpencodeCompactionProjector({
            sessionId: options.sessionId,
            onSummary: options.onSummary,
            onFailure: options.onFailure,
            onStart: options.onStart,
            onText: part => {
                if (this.closed) return;
                if (this.initializing) {
                    if (this.liveTextParts.has(part.id)) this.initialText.set(part.id, part);
                } else this.emitText(part);
            }
        });
    }

    event(type: string, properties: Record<string, unknown>, eventId?: string): void {
        if (this.closed) return;
        this.revision++;
        if (this.options.mode === 'v2' && type === 'session.compaction.started'
            && properties.sessionID === this.options.sessionId && typeof eventId === 'string' && eventId.startsWith('evt_')) {
            // Session.Message.ID.fromEvent: the persisted row shares this durable event identity.
            const id = typeof properties.inputID === 'string' ? properties.inputID : eventId.replace(/^evt_/, 'msg_');
            this.projector.start(id, properties.reason === 'auto' ? 'auto' : properties.reason === 'manual' ? 'manual' : undefined);
        }
        if (type === 'message.updated' && isObject(properties.info)) {
            this.projector.message(properties.info);
            if (typeof properties.info.finish === 'string') this.projector.flush();
        }
        if (type === 'message.part.updated' && isObject(properties.part)) {
            const part = properties.part;
            if (typeof part.id === 'string') {
                this.parts.set(part.id, part);
                this.unbasedDeltas.delete(part.id);
                if (part.sessionID === this.options.sessionId) {
                    if (this.initializing || !isObject(part.time) || typeof part.time.end !== 'number') this.liveTextParts.add(part.id);
                    else this.liveTextParts.delete(part.id);
                }
            }
            this.projector.part(part);
        }
        if (type === 'message.part.delta' && typeof properties.partID === 'string' && properties.field === 'text' && typeof properties.delta === 'string') {
            if (properties.sessionID === this.options.sessionId) this.liveTextParts.add(properties.partID);
            const part = this.parts.get(properties.partID);
            if (part && typeof part.text === 'string') {
                const next = { ...part, text: part.text + properties.delta };
                this.parts.set(properties.partID, next);
                this.projector.part(next);
            } else if (properties.sessionID === this.options.sessionId) {
                this.unbasedDeltas.set(properties.partID, (this.unbasedDeltas.get(properties.partID) ?? '') + properties.delta);
            }
        }
        if (type === 'session.status' && isObject(properties.status) && properties.status.type === 'idle') void this.refresh();
        if (type.startsWith('session.compaction.')) void this.refresh();
    }

    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
        this.refreshing = this.readPending().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    private async readPending(): Promise<void> {
        do {
            this.refreshAgain = false;
            await this.read();
        } while (this.refreshAgain && !this.closed);
    }

    private async read(): Promise<void> {
        try {
            // If SSE changed while the read was in flight, a response can be
            // older than what we already projected. Re-read at the next idle
            // boundary rather than rolling live state backwards.
            const revision = this.revision;
            const prefix = this.options.mode === 'v2' ? '/api' : '';
            const entries: unknown[] = [];
            let cursor: string | null = null;
            const cursors = new Set<string>();
            do {
                const query = new URLSearchParams({ directory: this.options.directory });
                if (this.options.mode === 'v2') {
                    // v2 ACP already owns ordinary text. Filter before paging
                    // so a long turn cannot hide a compaction checkpoint.
                    query.set('type', 'compaction');
                    query.set('limit', '100');
                    if (cursor) query.set('cursor', cursor);
                    else query.set('order', 'asc');
                }
                const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}${prefix}/session/${encodeURIComponent(this.options.sessionId)}/message?${query}`, {
                    headers: this.options.headers,
                    signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)])
                });
                if (!response.ok) throw new Error(`Native transcript read failed (${response.status})`);
                const body: unknown = await response.json();
                const page = isObject(body) && Array.isArray(body.data) ? body.data : body;
                if (!Array.isArray(page)) throw new Error('Invalid native transcript response');
                entries.push(...page);
                cursor = this.options.mode === 'v2' && isObject(body) && isObject(body.cursor) && typeof body.cursor.next === 'string' ? body.cursor.next : null;
                if (cursor && cursors.has(cursor)) throw new Error('Native transcript cursor did not advance');
                if (cursor) cursors.add(cursor);
            } while (cursor && !this.closed);
            if (!this.closed && revision === this.revision) {
                for (const entry of entries) {
                    if (!isObject(entry) || !Array.isArray(entry.parts)) continue;
                    const info = isObject(entry.info) ? entry.info : entry;
                    const created = isObject(info.time) ? info.time.created : undefined;
                    // v1 message creation uses the local native process's epoch
                    // clock. A reply created after attachment is new even if
                    // SSE missed every part while the first read was failing.
                    const newReply = this.initializing && this.options.mode === 'v1'
                        && info.sessionID === this.options.sessionId && info.role === 'assistant'
                        && typeof info.id === 'string' && typeof created === 'number'
                        && Number.isSafeInteger(created) && created >= this.attachedAt;
                    for (const part of entry.parts) {
                        if (!isObject(part) || part.sessionID !== this.options.sessionId || typeof part.id !== 'string') continue;
                        if (newReply && part.messageID === info.id) this.liveTextParts.add(part.id);
                        if (this.liveTextParts.has(part.id)) {
                            const live = this.parts.get(part.id);
                            const complete = isObject(part.time) && typeof part.time.end === 'number';
                            if (!complete && live) continue;
                            const delta = this.unbasedDeltas.get(part.id);
                            this.parts.set(part.id, !complete && delta && typeof part.text === 'string'
                                ? { ...part, text: part.text + delta } : part);
                            this.unbasedDeltas.delete(part.id);
                        } else this.parts.set(part.id, part);
                    }
                }
                // v1 text deltas are live-only until text-end persists the part.
                // Reapply those parts after priming historical metadata, rather
                // than replacing their accumulator with an older stored prefix.
                const liveParts = [...this.liveTextParts]
                    .flatMap(id => this.parts.has(id) ? [this.parts.get(id)!] : []);
                this.initialText.clear();
                this.projector.snapshot(this.options.mode === 'v2'
                    ? entries.filter(entry => isObject(entry) && (entry.sessionID === undefined || entry.sessionID === this.options.sessionId))
                        .map(entry => isObject(entry) ? { ...entry, sessionID: this.options.sessionId } : entry)
                    : entries, liveParts, this.initializing);
                this.readFailureReported = false;
                if (this.initializing && !this.closed) {
                    // Only an applied baseline primes historical text. Keep the
                    // latest verified text for parts observed live during recovery.
                    this.initializing = false;
                    for (const part of this.initialText.values()) this.emitText(part);
                    this.initialText.clear();
                }
                for (const id of this.liveTextParts) {
                    const part = this.parts.get(id);
                    if (part && isObject(part.time) && typeof part.time.end === 'number') {
                        this.liveTextParts.delete(id);
                        this.unbasedDeltas.delete(id);
                    }
                }
            }
        } catch (error) {
            if (!this.closed) {
                logger.debug('[opencode-native] transcript reconciliation failed', error);
                if (!this.readFailureReported) this.options.onReadFailure?.();
                this.readFailureReported = true;
            }
        }
    }

    private emitText(part: OpencodeNativeText): void {
        const timer = this.textTimers.get(part.id);
        if (part.complete) {
            if (timer) clearTimeout(timer);
            this.textTimers.delete(part.id);
            this.pendingText.delete(part.id);
            this.options.onText(part);
            return;
        }
        if (timer) {
            this.pendingText.set(part.id, part);
            return;
        }
        this.options.onText(part);
        this.textTimers.set(part.id, setTimeout(() => {
            this.textTimers.delete(part.id);
            const pending = this.pendingText.get(part.id);
            this.pendingText.delete(part.id);
            if (pending && !this.closed) this.emitText(pending);
        }, 120));
    }

    close(): void {
        this.initialText.clear();
        this.liveTextParts.clear();
        this.unbasedDeltas.clear();
        for (const timer of this.textTimers.values()) clearTimeout(timer);
        this.textTimers.clear();
        for (const part of this.pendingText.values()) this.options.onText(part);
        this.pendingText.clear();
        this.closed = true;
        this.controller.abort();
    }
}
