import {
    OPENCODE_CONVERSATION_HISTORY_INITIAL,
    markSupported,
    markUnsupported,
    toConversationHistoryCapabilities,
    type ConversationHistoryCapabilityStates
} from '@hapi/protocol/conversationHistory';
import type { ForkConversationRpcResult } from '@hapi/protocol/apiTypes';
import type { FetchLike } from './utils/opencodeCompactBridge';
import { hashObject } from '../utils/deterministicJson';

type BunFetchInit = RequestInit & { timeout?: false };

type OpencodeMessageEntry = {
    info?: Record<string, unknown>;
    parts?: unknown;
};

type HistoryContext = {
    baseUrl: string | null;
    sessionId: string | null;
    mode?: 'v1' | 'v2';
    headers?: Record<string, string>;
};
type HistoryCheckpoint = NonNullable<ForkConversationRpcResult['opencodeHistoryCheckpoint']>;
type NativeHistorySnapshot = { checkpoint: HistoryCheckpoint; conversationIds: string[]; v2Messages?: Record<string, unknown>[] };
type MigrationProof = NonNullable<HistoryCheckpoint['v1Migration']>;

function isRouteMissing(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\((404|405)\)/.test(message);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

const FORK_PATH_MARKERS = ['session/{sessionID}/fork', 'session/{id}/fork', 'session/:id/fork'];

/** Only context shapes whose v1→v2 conversion is understood get a proof. */
function captureV1Migration(entries: OpencodeMessageEntry[]): MigrationProof | undefined {
    const rows: MigrationProof['rows'] = [];
    const summaries: MigrationProof['summaries'] = [];
    for (const entry of entries) {
        if (!Array.isArray(entry.parts) || !entry.parts.every(isObjectRecord)) return;
        const parts = entry.parts;
        const id = asString(entry.info?.id);
        const role = entry.info?.role;
        if (!id || (role !== 'user' && role !== 'assistant')) return;
        if (role === 'assistant' && entry.info?.summary === true) {
            const parentId = asString(entry.info.parentID);
            if (!parentId || summaries.some(summary => summary.parentId === parentId)) return;
            summaries.push({ id, parentId });
            continue;
        }
        if (role === 'user') {
            if (parts.some(part => part.type !== 'text' && part.type !== 'compaction')) return;
            const marker = parts.find(part => part.type === 'compaction');
            if (marker) {
                if (parts.length !== 1 || marker.tail_start_id) return;
                const summary = entries.find(item => item.info?.role === 'assistant'
                    && item.info.summary === true && item.info.parentID === id);
                if (!summary || !isObjectRecord(summary.info?.time)
                    || typeof summary.info.time.completed !== 'number'
                    || summary.info.error || !Array.isArray(summary.parts) || !summary.parts.every(isObjectRecord)
                    || summary.parts.some(part => !['text', 'step-start', 'step-finish'].includes(String(part.type)))) return;
                const text = summary.parts.filter(part => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
                    .map(part => part.text).join('\n\n');
                if (!text) return;
                rows.push({ id, type: 'compaction', sha256: hashObject({ type: 'compaction', status: 'completed',
                    reason: marker.auto ? 'auto' : 'manual', summary: text }) });
                continue;
            }
            const visible = parts.filter(part => part.type === 'text' && !part.ignored);
            if (visible.some(part => typeof part.text !== 'string')) return;
            const synthetic = visible.filter(part => part.synthetic);
            if (synthetic.length > 0 && synthetic.length !== visible.length) return;
            const type = synthetic.length > 0 ? 'synthetic' : 'user';
            rows.push({ id, type, sha256: hashObject({ type, text: visible.map(part => part.text).join('\n\n') }) });
            continue;
        }
        const content: Record<string, unknown>[] = [];
        for (const part of parts) {
            const native = part.metadata === undefined ? {} : { native: part.metadata };
            if (part.type === 'text' || part.type === 'reasoning') {
                if (typeof part.text !== 'string') return;
                content.push({ type: part.type, text: part.text, ...native });
            } else if (part.type === 'tool') {
                const state = part.state;
                if (!asString(part.callID) || !asString(part.tool) || !isObjectRecord(state)
                    || state.status !== 'completed' || !isObjectRecord(state.input) || typeof state.output !== 'string'
                    || (Array.isArray(state.attachments) && state.attachments.length > 0)
                    || (isObjectRecord(state.time) && state.time.compacted !== undefined)) return;
                content.push({ type: 'tool', id: part.callID, name: part.tool, ...native,
                    state: { status: 'completed', input: state.input,
                        content: [{ type: 'text', text: state.output }], metadata: state.metadata ?? {} } });
            } else if (!['step-start', 'step-finish', 'snapshot', 'patch'].includes(String(part.type))) return;
        }
        rows.push({ id, type: 'assistant', sha256: hashObject({ type: 'assistant', content }) });
    }
    if (summaries.some(summary => !rows.some(row => row.id === summary.parentId && row.type === 'compaction'))) return;
    return { format: 1, rows, summaries };
}

function v2ContextHash(message: Record<string, unknown>): string | null {
    const type = message.type;
    if (type === 'user' || type === 'synthetic') {
        if (typeof message.text !== 'string' || message.files !== undefined || message.agents !== undefined) return null;
        return hashObject({ type, text: message.text });
    }
    if (type === 'compaction') {
        if (message.status !== 'completed' || typeof message.summary !== 'string' || message.metadata !== undefined) return null;
        return hashObject({ type, status: message.status, reason: message.reason, summary: message.summary });
    }
    if (type !== 'assistant' || !Array.isArray(message.content) || !message.content.every(isObjectRecord)) return null;
    const content = message.content.map(part => {
        const { time: _time, ...context } = part;
        return context;
    });
    return hashObject({ type, content });
}

export class OpencodeConversationHistory {
    private states: ConversationHistoryCapabilityStates = { ...OPENCODE_CONVERSATION_HISTORY_INITIAL };
    private readonly promptIndexByLocalId = new Map<string, number>();
    private busy = false;
    private rewindReady = false;
    private nativeRewindSupported = false;
    setRewindReady(ready: boolean): void {
        this.rewindReady = ready;
    }
    private disabled = false;
    private checkpoint: HistoryCheckpoint | undefined;
    private diverged = false;
    private publishCapabilities: (() => Promise<void>) | null = null;

    constructor(
        private readonly getContext: () => HistoryContext,
        fetchImpl?: FetchLike
    ) {
        this.fetchFn = fetchImpl ?? (async (url: string, init?: RequestInit) => {
            const bunInit: BunFetchInit = { ...init, timeout: false } as BunFetchInit;
            return await fetch(url, bunInit as RequestInit);
        });
    }

    private readonly fetchFn: FetchLike;

    setPublishCapabilities(fn: () => Promise<void>): void {
        this.publishCapabilities = fn;
    }

    /** Pushes current history points/indexes into session metadata (best-effort). */
    async publish(): Promise<void> {
        await this.publishCapabilities?.()
    }

    /** Permanently hides fork affordances (e.g. after native/HAPI divergence). */
    async disableFork(): Promise<void> {
        this.disabled = true;
        this.rewindReady = false;
        this.states = markUnsupported(this.states, 'rewindToMessage');
        this.states = markUnsupported(markUnsupported(this.states, 'forkCurrent'), 'forkAtMessage');
        await this.publishCapabilities?.();
    }

    /** Drops all persisted locators (e.g. compaction reindexes native history). */
    clearPromptIndexes(): void {
        this.promptIndexByLocalId.clear();
        this.checkpoint = undefined;
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
    }

    rememberPromptIndex(localId: string | undefined, promptIndex: number | null | undefined): void {
        if (!localId || promptIndex == null || !Number.isInteger(promptIndex) || promptIndex < 0) return;
        this.promptIndexByLocalId.set(localId, promptIndex);
    }

    getCapabilitiesForMetadata() {
        const conversationHistory = toConversationHistoryCapabilities(this.states);
        // Temporary runtime admission/consumption is not a terminal native
        // route verdict. Never override markUnsupported's native fence.
        if (conversationHistory && (!this.rewindReady || !this.nativeRewindSupported || this.disabled)) delete conversationHistory.rewindToMessage;
        if (conversationHistory && Object.keys(conversationHistory).length === 0) return undefined;
        return conversationHistory ? { conversationHistory } : undefined;
    }

    getHistoryPoints(): Record<string, true> {
        const points: Record<string, true> = {};
        for (const localId of this.promptIndexByLocalId.keys()) {
            points[localId] = true;
        }
        return points;
    }

    getHistoryIndexes(): Record<string, number> {
        const indexes: Record<string, number> = {};
        for (const [localId, promptIndex] of this.promptIndexByLocalId.entries()) {
            indexes[localId] = promptIndex;
        }
        return indexes;
    }

    restorePromptIndexes(indexes: Record<string, number> | null | undefined): void {
        if (!indexes) return;
        for (const [localId, promptIndex] of Object.entries(indexes)) {
            if (typeof localId !== 'string' || localId.length === 0) continue;
            if (!Number.isInteger(promptIndex) || promptIndex < 0) continue;
            this.promptIndexByLocalId.set(localId, promptIndex);
        }
    }

    restoreCheckpoint(checkpoint: HistoryCheckpoint | undefined): void {
        this.checkpoint = checkpoint;
    }

    getCheckpoint(): HistoryCheckpoint | undefined {
        return this.checkpoint;
    }

    isDiverged(): boolean {
        return this.diverged;
    }

    isDisabled(): boolean {
        return this.disabled;
    }

    async invalidateHistory(): Promise<void> {
        this.diverged = true;
        this.clearPromptIndexes();
        await this.disableFork();
    }

    private async markDiverged(): Promise<never> {
        await this.invalidateHistory();
        throw new Error('OpenCode history diverged from the HAPI transcript');
    }

    async reconcileHistory(signal?: AbortSignal, options: { allowUnobservedAppend?: boolean } = {}): Promise<number> {
        if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
        const { baseUrl, sessionId } = this.getContext();
        if (!baseUrl || !sessionId) throw new Error('OpenCode session is not ready');
        const { checkpoint: snapshot, conversationIds, v2Messages } = await this.readSnapshot(baseUrl, sessionId,
            AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]));
        if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
        if (v2Messages && this.checkpoint?.v1Migration && !this.reconcileV1Projection(snapshot, v2Messages)) {
            return await this.markDiverged();
        }
        const currentIds = new Set(snapshot.messageIds);
        const previousIds = new Set(this.checkpoint?.messageIds ?? []);
        const observedIds = new Set(this.checkpoint?.localMessageIds ?? []);
        if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
        if ((!this.checkpoint && this.promptIndexByLocalId.size > 0)
            || (this.checkpoint && (this.checkpoint.sessionId !== sessionId
                || this.checkpoint.localMessageIds === undefined
                || this.checkpoint.localPublicationPending
                || this.checkpoint.messageIds.some((id, index) => snapshot.messageIds[index] !== id)
                || this.checkpoint.localMessageIds?.some((id) => !currentIds.has(id))
                || [...this.promptIndexByLocalId.values()].some((index) => index >= this.checkpoint!.userMessageIds.length)))
            || (!options.allowUnobservedAppend && conversationIds.some((id) => !previousIds.has(id) && !observedIds.has(id)))) {
            return await this.markDiverged();
        }
        this.checkpoint = snapshot;
        return snapshot.userMessageIds.length;
    }

    /** Normalize only a transition proved by a checkpoint captured in v1. */
    private reconcileV1Projection(snapshot: HistoryCheckpoint, messages: Record<string, unknown>[]): boolean {
        const source = this.checkpoint;
        const proof = source?.v1Migration;
        if (!source || !proof || proof.format !== 1 || source.sessionId !== snapshot.sessionId
            || source.localMessageIds === undefined || source.localPublicationPending) return false;
        const merged = new Map(proof.summaries.map(summary => [summary.id, summary.parentId]));
        const expectedIds = source.messageIds.filter(id => !merged.has(id));
        if (new Set(source.messageIds).size !== source.messageIds.length
            || merged.size !== proof.summaries.length
            || proof.summaries.some(summary => !source.messageIds.includes(summary.id)
                || !source.userMessageIds.includes(summary.parentId)
                || !proof.rows.some(row => row.id === summary.parentId && row.type === 'compaction'))
            || expectedIds.length !== proof.rows.length
            || proof.rows.some((row, index) => expectedIds[index] !== row.id
                || messages[index]?.id !== row.id || messages[index]?.type !== row.type
                || v2ContextHash(messages[index]!) !== row.sha256)) return false;
        const originalUsers = proof.rows.filter(row => row.type !== 'assistant').map(row => row.id);
        if (originalUsers.length !== source.userMessageIds.length
            || originalUsers.some((id, index) => source.userMessageIds[index] !== id)) return false;
        const users = proof.rows.filter(row => row.type === 'user').map(row => row.id);
        const indexes = new Map<string, number>();
        for (const [localId, index] of this.promptIndexByLocalId) {
            const originalId = source.userMessageIds[index];
            const nextIndex = originalId ? users.indexOf(originalId) : -1;
            if (nextIndex < 0) return false;
            indexes.set(localId, nextIndex);
        }
        const normalized = { ...source, messageIds: expectedIds, userMessageIds: users,
            localMessageIds: [...new Set(source.localMessageIds.map(id => merged.get(id) ?? id))], v1Migration: undefined };
        // Do not mutate locators until all migration evidence has matched.
        this.checkpoint = normalized;
        this.promptIndexByLocalId.clear();
        for (const [localId, index] of indexes) this.promptIndexByLocalId.set(localId, index);
        return true;
    }

    async checkpointForkedSession(sessionId: string): Promise<HistoryCheckpoint> {
        const { baseUrl } = this.getContext();
        if (!baseUrl || this.disabled) throw new Error('OpenCode session is not ready');
        const snapshot = await this.readSnapshot(baseUrl, sessionId, AbortSignal.timeout(5_000));
        if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
        return snapshot.checkpoint;
    }

    async probeCapabilities(signal?: AbortSignal): Promise<void> {
        if (this.disabled) return;
        const { baseUrl, sessionId } = this.getContext();
        if (!baseUrl || !sessionId) return;

        try {
            // `/openapi.json` serves an HTML app shell with HTTP 200 on some
            // versions, so a marker miss must fall through to the next
            // candidate rather than concluding "unsupported".
            let forkSupported = false;
            let rewindSupported = false;
            for (const url of [`${baseUrl}/doc`, `${baseUrl}/openapi.json`]) {
                let bodyText: string | null = null;
                try {
                    bodyText = await this.fetchDocText(url, signal);
                } catch {
                    // A missing/failing endpoint must not abort the probe —
                    // fall through to the next candidate.
                    continue;
                }
                if (bodyText !== null && FORK_PATH_MARKERS.some((marker) => bodyText.includes(marker))) {
                    forkSupported = true;
                    rewindSupported = bodyText.includes('/api/session/{sessionID}/revert/stage')
                        && bodyText.includes('/api/session/{sessionID}/revert/commit');
                    break;
                }
            }
            if (this.disabled) return;
            this.nativeRewindSupported = rewindSupported;
            this.states = forkSupported
                ? markSupported(markSupported(this.states, 'forkCurrent'), 'forkAtMessage')
                : markUnsupported(markUnsupported(this.states, 'forkCurrent'), 'forkAtMessage');
        } catch {
            if (this.disabled) return;
            this.nativeRewindSupported = false;
            // Any network failure hides the capability rather than showing a broken affordance.
            this.states = markUnsupported(markUnsupported(this.states, 'forkCurrent'), 'forkAtMessage');
        }
        this.states = this.nativeRewindSupported ? markSupported(this.states, 'rewindToMessage') : markUnsupported(this.states, 'rewindToMessage');

        // A torn-down launcher must not overwrite a successor's fresher state.
        if (signal?.aborted) return;
        await this.publishCapabilities?.();
    }

    private async fetchDocText(url: string, signal?: AbortSignal): Promise<string> {
        const response = await this.fetchFn(url, {
            method: 'GET',
            headers: this.getContext().headers,
            signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])
        });
        if (!response.ok) throw new Error(`GET ${url} failed (${response.status})`);
        return await response.text();
    }

    async fork(messageLocalId?: string): Promise<ForkConversationRpcResult> {
        if (this.busy) throw new Error('Session is busy');
        if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
        const { baseUrl, sessionId, mode, headers } = this.getContext();
        if (!baseUrl || !sessionId) throw new Error('OpenCode session is not ready');

        // A cached numeric position is meaningful only in the native history
        // whose identities were observed. Revalidate before any native mutation.
        if (messageLocalId && this.states.forkAtMessage === 'unsupported') {
            throw new Error('Historical fork is not supported');
        }
        if (!messageLocalId && this.states.forkCurrent === 'unsupported') throw new Error('Fork current is not supported');
        if (messageLocalId && !this.promptIndexByLocalId.has(messageLocalId)) {
            throw new Error(`No native history point for message ${messageLocalId}`);
        }
        await this.reconcileHistory();

        let messageID: string | undefined;
        if (messageLocalId) {
            if (this.states.forkAtMessage === 'unsupported') {
                throw new Error('Historical fork is not supported');
            }
            const targetPromptIndex = this.promptIndexByLocalId.get(messageLocalId);
            if (targetPromptIndex == null) {
                throw new Error(`No native history point for message ${messageLocalId}`);
            }
            messageID = this.checkpoint?.userMessageIds[targetPromptIndex];
            if (!messageID) throw new Error(`OpenCode has no user message at index ${targetPromptIndex}`);
        } else if (this.states.forkCurrent === 'unsupported') {
            throw new Error('Fork current is not supported');
        }

        try {
            if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
            const response = await this.fetchFn(
                `${baseUrl}${mode === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/fork`,
                {
                    method: 'POST',
                    headers: { ...headers, 'content-type': 'application/json' },
                    body: JSON.stringify(messageID ? (mode === 'v2' ? { before: messageID } : { messageID }) : {}),
                    signal: AbortSignal.timeout(10_000)
                }
            );
            if (!response.ok) {
                throw new Error(`OpenCode fork request failed (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`);
            }
            const data: unknown = await response.json().catch(() => null);
            const session = mode === 'v2' && isObjectRecord(data) ? data.data : data;
            const nativeSessionId = asString(isObjectRecord(session) ? session.id : null);
            if (!nativeSessionId) throw new Error('OpenCode fork did not return a session id');

            if (this.disabled) throw new Error('Fork is not supported after launcher teardown');
            this.states = markSupported(this.states, 'forkCurrent');
            this.states = markSupported(this.states, 'forkAtMessage');
            await this.publishCapabilities?.();
            return { nativeSessionId };
        } catch (error) {
            // Only a missing route hides the capability; transient network or
            // server errors must not permanently disable an advertised fork.
            // Both fork modes share this endpoint, so a 404/405 disables both.
            if (!this.disabled && isRouteMissing(error)) {
                this.states = markUnsupported(
                    markUnsupported(this.states, 'forkCurrent'),
                    'forkAtMessage'
                );
                await this.publishCapabilities?.();
            }
            throw error;
        }
    }

    private async readSnapshot(baseUrl: string, sessionId: string, signal: AbortSignal): Promise<NativeHistorySnapshot> {
        if (this.getContext().mode === 'v2') {
            const messages = await this.fetchV2Messages(baseUrl, sessionId, signal);
            return { checkpoint: { sessionId, messageIds: messages.map((message) => message.id as string),
                userMessageIds: messages.filter((message) => message.type === 'user').map((message) => message.id as string), localMessageIds: [] },
                conversationIds: messages.filter((message) => message.type === 'user' || message.type === 'assistant').map((message) => message.id as string),
                v2Messages: messages };
        }
        const response = await this.fetchFn(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, { method: 'GET', signal });
        if (!response.ok) throw new Error(`OpenCode message lookup failed (${response.status})`);
        const messages: unknown = await response.json();
        if (!Array.isArray(messages)) throw new Error('OpenCode message list is not available');
        const entries = messages as OpencodeMessageEntry[];
        const messageIds = entries.map((message) => {
            const id = asString(message.info?.id);
            if (!id) throw new Error('OpenCode returned an invalid message');
            return id;
        });
        const v1Migration = captureV1Migration(entries);
        return { checkpoint: { sessionId, messageIds, userMessageIds: entries.flatMap((message, i) => message.info?.role === 'user' ? [messageIds[i]!] : []), localMessageIds: [],
            ...(v1Migration ? { v1Migration } : {}) },
            conversationIds: entries.flatMap((message, i) => message.info?.role === 'user' || message.info?.role === 'assistant' ? [messageIds[i]!] : []) };
    }

    /** Number of user messages already in the native session, or null when unknown. */
    async getNativeUserMessageCount(signal?: AbortSignal): Promise<number | null> {
        if (this.disabled) return null;
        try {
            return await this.reconcileHistory(signal);
        } catch {
            return null;
        }
    }

    private async fetchV2Messages(baseUrl: string, sessionId: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
        const messages: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
            const query = new URLSearchParams({ limit: '200' });
            if (cursor) query.set('cursor', cursor);
            else query.set('order', 'asc');
            const response = await this.fetchFn(
                `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/message?${query}`,
                { method: 'GET', headers: this.getContext().headers, signal }
            );
            if (!response.ok) throw new Error(`OpenCode message lookup failed (${response.status})`);
            const data: unknown = await response.json();
            if (!isObjectRecord(data) || !Array.isArray(data.data)) throw new Error('OpenCode message list is not available');
            for (const entry of data.data) {
                if (!isObjectRecord(entry) || !asString(entry.type) || !asString(entry.id)) {
                    throw new Error('OpenCode returned an invalid message');
                }
                messages.push(entry);
            }
            cursor = isObjectRecord(data.cursor) ? asString(data.cursor.next) : null;
            if (cursor && seen.has(cursor)) throw new Error('OpenCode repeated a message cursor');
            if (cursor) seen.add(cursor);
        } while (cursor);
        return messages;
    }
}
