import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashObject } from '@/utils/deterministicJson';
import { getProcessStartMarker } from '@/utils/process';
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas';
import type { OpenCodeRewindReport } from '@hapi/protocol/apiTypes';

type Checkpoint = NonNullable<OpenCodeRewindReport['checkpoint']>;
type Row = Record<string, unknown> & { id: string; type: string };
type Intent = {
    operation: OpenCodeRewindOperation; phase: 'prepared' | 'stage-issued' | 'staged' | 'commit-issued' | 'applied' | 'unknown' | 'finalized';
    backupPath: string; sourceHash: string; prefixHash: string; source: Row[]; prefix: Row[];
    checkpoint: Checkpoint; indexes: Record<string, number>; pendingRequest: boolean;
    nativeProcess?: { pid: number; startMarker: string };
    ownerProcess?: { pid: number; startMarker: string };
    ownerWorkerId: string;
    lastError?: string;
};

/** Shared by OpenCode input/config preparation, dequeue, handoff and history RPCs. */
export class OpenCodeRuntimeGate {
    /** One session/wrapper owner, shared by sequential local/remote launchers. */
    readonly workerId = randomUUID();
    private active = 0;
    private blocked = false;
    private consumedOperationId: string | undefined;
    private readonly waiters: Array<() => void> = [];
    enterRuntime(): () => void {
        if (this.blocked) throw new Error('OpenCode rewind is pending reconciliation');
        this.active++;
        let released = false;
        return () => { if (!released) { released = true; this.active--; } };
    }
    enterLocalRuntime(operation: OpenCodeRewindOperation | undefined): () => void {
        if (operation && operation.phase !== 'rejected'
            && (operation.phase !== 'committed' || this.consumedOperationId !== operation.operationId)) {
            this.block();
            throw new Error('OpenCode rewind requires reconciliation before local launch; resume remotely first');
        }
        return this.enterRuntime();
    }
    reserve(): void {
        if (this.active || this.blocked) throw new Error('OpenCode runtime is busy');
        this.blocked = true;
    }
    block(): void { this.blocked = true; }
    release(consumedOperationId?: string): void {
        if (consumedOperationId) this.consumedOperationId = consumedOperationId;
        this.blocked = false; for (const resolve of this.waiters.splice(0)) resolve();
    }
    waitUntilOpen(): Promise<void> { return this.blocked ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
    isBlocked(): boolean { return this.blocked; }
}

type Options = {
    directory: string; hapiSessionId: string; workerId: string; gate: OpenCodeRuntimeGate;
    baseUrl: string; nativeSessionId: string; headers: Record<string, string>;
    request?: (url: string, init?: RequestInit) => Promise<Response>;
    report: (report: OpenCodeRewindReport) => Promise<OpenCodeRewindOperation>;
    flush: () => Promise<boolean>; isIdle: () => boolean;
    sourceCheckpoint: () => Checkpoint | undefined; sourceIndexes: () => Record<string, number>;
    requestsFromPreviousWorkerCannotRun: () => boolean;
    nativeProcess?: { pid: number; startMarker: string };
    consumeCommitted?: () => Promise<void>;
    previousWorkerCannotRun?: () => boolean;
};

function protectedWrite(path: string, value: unknown): void {
    const temporary = `${path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
}

export class OpenCodeRewind {
    private readonly path: string;
    private readonly directory: string;
    private running = false;
    constructor(private readonly options: Options) {
        this.directory = join(options.directory, hashObject(options.hapiSessionId));
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.path = join(this.directory, 'intent.json');
    }
    readIntent(): Intent | undefined {
        if (!existsSync(this.path)) return;
        // A malformed journal is a blocking error, never an absent operation.
        const intent = JSON.parse(readFileSync(this.path, 'utf8')) as Intent;
        if (!intent.operation || !Array.isArray(intent.source) || !Array.isArray(intent.prefix)
            || hashObject(intent.source) !== intent.sourceHash || hashObject(intent.prefix) !== intent.prefixHash) {
            throw new Error('Invalid OpenCode rewind intent');
        }
        const backup = JSON.parse(readFileSync(intent.backupPath, 'utf8'));
        if (backup.info?.id !== intent.operation.nativeSessionId || hashObject(backup.messages) !== intent.sourceHash) {
            throw new Error('OpenCode projected backup is missing or corrupt');
        }
        return intent;
    }
    private save(intent: Intent): void {
        protectedWrite(this.path, intent);
        const fd = openSync(this.directory, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    private claimRecovery(intent: Intent): void {
        const marker = getProcessStartMarker(process.pid);
        intent.ownerWorkerId = this.options.workerId;
        intent.ownerProcess = marker ? { pid: process.pid, startMarker: marker } : undefined;
        this.save(intent);
    }
    private async request(path: string, body?: unknown): Promise<unknown> {
        const r = await (this.options.request ?? fetch)(`${this.options.baseUrl}${path}`, {
            method: body === undefined ? 'GET' : 'POST', headers: { ...this.options.headers, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000)
        });
        if (!r.ok) throw new Error(`OpenCode rewind request failed (${r.status})`);
        if (r.status === 204) return undefined;
        return await r.json();
    }
    private async observe(): Promise<{ rows: Row[]; staged?: string; info: Record<string, unknown>; idle: boolean }> {
        const session = `/api/session/${encodeURIComponent(this.options.nativeSessionId)}`;
        const rows: Row[] = []; const seen = new Set<string>(); let cursor: string | undefined;
        do {
            const q = new URLSearchParams(cursor ? { limit: '200', cursor } : { limit: '200', order: 'asc' });
            const value = await this.request(`${session}/message?${q}`) as { data?: Row[]; cursor?: { next?: string } };
            if (!Array.isArray(value.data) || value.data.some(r => !r || typeof r.id !== 'string' || typeof r.type !== 'string')) throw new Error('Invalid native projection');
            rows.push(...value.data); cursor = value.cursor?.next;
            if (cursor && seen.has(cursor)) throw new Error('Repeated native cursor');
            if (cursor) seen.add(cursor);
        } while (cursor);
        if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate native identity');
        const info = (await this.request(session) as { data: Record<string, unknown> }).data;
        const active = (await this.request('/api/session/active') as { data: Record<string, unknown> }).data;
        const inbox = (await this.request(`${session}/inbox`) as { data: unknown[] }).data;
        if (!info || info.id !== this.options.nativeSessionId || !active || !Array.isArray(inbox)) throw new Error('Incomplete native readback');
        return { rows, info, staged: (info.revert as { messageID?: string } | undefined)?.messageID,
            idle: !active[this.options.nativeSessionId] && inbox.length === 0 };
    }
    private samePrefix(expected: Row[], actual: Row[]): boolean {
        return actual.length >= expected.length && hashObject(actual.slice(0, expected.length)) === hashObject(expected)
            && actual.slice(expected.length).every(row => row.type === 'idle' && !expected.some(old => old.id === row.id));
    }
    private async unknown(intent: Intent, error: unknown): Promise<{ success: false; outcome: 'unknown'; error: string }> {
        this.options.gate.block(); intent.phase = 'unknown'; intent.lastError = error instanceof Error ? error.message : String(error); this.save(intent);
        await this.options.report({ operation: intent.operation, phase: 'unknown' }).catch(() => {});
        return { success: false, outcome: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    private async settle(intent: Intent) {
        if (intent.pendingRequest && !this.options.requestsFromPreviousWorkerCannotRun()) {
            return await this.unknown(intent, new Error('Native request cohort may still mutate later'));
        }
        const read = await this.observe();
        if (!read.idle || read.staged || !this.samePrefix(intent.prefix, read.rows)) {
            return await this.unknown(intent, new Error('Native rewind conflicts with the retained prefix or new input'));
        }
        intent.pendingRequest = false; intent.phase = 'applied'; this.save(intent);
        const committed = await this.options.report({ operation: intent.operation, phase: 'applied',
            sourceHash: intent.sourceHash, prefixHash: intent.prefixHash, checkpoint: intent.checkpoint, indexes: intent.indexes });
        if (committed.operationId !== intent.operation.operationId || committed.phase !== 'committed') throw new Error('Hub rewind commit is unconfirmed');
        await this.options.consumeCommitted?.();
        intent.phase = 'finalized'; this.save(intent); this.options.gate.release(intent.operation.operationId);
        return { success: true as const, truncateFromLocalId: intent.operation.requestedLocalId };
    }
    async execute(operation: OpenCodeRewindOperation) {
        // Ownership is acquired synchronously, before flush/read/journal awaits.
        if (this.running) throw new Error('OpenCode rewind is busy');
        this.options.gate.reserve();
        this.running = true;
        let intent: Intent | undefined;
        try {
            if (operation.nativeSessionId !== this.options.nativeSessionId || operation.workerId !== this.options.workerId
                || !this.options.isIdle()) throw new Error('Native rewind worker is not idle or does not own the operation');
            const prior = this.readIntent();
            if (prior?.phase !== undefined && prior.phase !== 'finalized') throw new Error('An earlier rewind intent is unresolved');
            // An operation ID owns its original projection permanently, even
            // after a newer operation replaces the current journal.
            if (prior?.operation.operationId === operation.operationId
                || existsSync(join(this.directory, `${hashObject(operation.operationId)}.projection.json`))) {
                throw new Error('OpenCode rewind operation is already recorded');
            }
            if (!await this.options.flush()) throw new Error('Source metadata/output is not durable');
            const cp = this.options.sourceCheckpoint();
            const read = await this.observe();
            if (!cp || cp.localPublicationPending || cp.localMessageIds === undefined || cp.sessionId !== operation.nativeSessionId
                || !read.idle || read.staged || hashObject(cp.messageIds) !== hashObject(read.rows.map(r => r.id))) throw new Error('Native source is not the verified checkpoint');
            const boundary = read.rows.findIndex(r => r.id === operation.nativeMessageId && r.type === 'user');
            const indexes = this.options.sourceIndexes();
            if (boundary < 0 || cp.userMessageIds[indexes[operation.requestedLocalId]!] !== operation.nativeMessageId) throw new Error('Unproven native rewind boundary');
            const prefix = read.rows.slice(0, boundary);
            const users = prefix.filter(r => r.type === 'user').map(r => r.id);
            const retained: Record<string, number> = {};
            for (const [local, index] of Object.entries(indexes)) {
                const next = users.indexOf(cp.userMessageIds[index]!);
                if (next >= 0) retained[local] = next;
            }
            const backupPath = join(this.directory, `${hashObject(operation.operationId)}.projection.json`);
            protectedWrite(backupPath, { info: read.info, messages: read.rows });
            if (hashObject(JSON.parse(readFileSync(backupPath, 'utf8')).messages) !== hashObject(read.rows)) throw new Error('Backup verification failed');
            intent = { operation, phase: 'prepared', source: read.rows, prefix, sourceHash: hashObject(read.rows), prefixHash: hashObject(prefix),
                backupPath, checkpoint: { sessionId: operation.nativeSessionId, messageIds: prefix.map(r => r.id), userMessageIds: users, localMessageIds: [] },
                indexes: retained, pendingRequest: false, nativeProcess: this.options.nativeProcess, ownerWorkerId: this.options.workerId,
                ownerProcess: getProcessStartMarker(process.pid) ? { pid: process.pid, startMarker: getProcessStartMarker(process.pid)! } : undefined };
            this.save(intent);
            const prepared = await this.options.report({ operation, phase: 'prepared', sourceHash: intent.sourceHash, prefixHash: intent.prefixHash });
            if (prepared.phase !== 'prepared' || prepared.operationId !== operation.operationId) throw new Error('Hub preparation unconfirmed');
            // Confirm the source after the durable Hub/backup barriers.
            const finalSource = await this.observe();
            if (!finalSource.idle || finalSource.staged || hashObject(finalSource.rows) !== intent.sourceHash) return await this.unknown(intent, 'Native source changed during preparation');
            const session = `/api/session/${encodeURIComponent(operation.nativeSessionId)}`;
            intent.phase = 'stage-issued'; intent.pendingRequest = true; this.save(intent);
            await this.request(`${session}/revert/stage`, { messageID: operation.nativeMessageId, files: false });
            intent.pendingRequest = false; intent.phase = 'staged'; this.save(intent);
            const staged = await this.observe();
            if (!staged.idle) return await this.unknown(intent, 'New native input while staging');
            if (!staged.staged && this.samePrefix(intent.prefix, staged.rows)) return await this.settle(intent);
            if (staged.staged !== operation.nativeMessageId || hashObject(staged.rows) !== intent.sourceHash) return await this.unknown(intent, 'Native stage ownership changed');
            intent.phase = 'commit-issued'; intent.pendingRequest = true; this.save(intent);
            await this.request(`${session}/revert/commit`, {});
            intent.pendingRequest = false; this.save(intent);
            return await this.settle(intent);
        } catch (error) {
            if (intent) return await this.unknown(intent, error);
            // No native write has been issued in this branch. An unresolved
            // earlier journal must nevertheless keep the runtime blocked.
            const prior = this.readIntent();
            if (prior && prior.phase !== 'finalized') return await this.unknown(prior, error);
            await this.options.report({ operation, phase: 'rejected' });
            this.options.gate.release();
            return { success: false as const, outcome: 'rejected' as const, error: String(error) };
        } finally { this.running = false; }
    }
    async recover(operation: OpenCodeRewindOperation) {
        if (this.running) throw new Error('OpenCode rewind is busy');
        this.running = true;
        try { return await this.recoverReserved(operation); }
        finally { this.running = false; }
    }
    private async recoverReserved(operation: OpenCodeRewindOperation) {
        this.options.gate.block();
        const intent = this.readIntent();
        const identity = (op: OpenCodeRewindOperation) => ({ operationId: op.operationId, nativeSessionId: op.nativeSessionId,
            workerId: op.workerId, requestedLocalId: op.requestedLocalId, nativeMessageId: op.nativeMessageId,
            cutoffSeq: op.cutoffSeq, sourceEpoch: op.sourceEpoch, sourceMaxSeq: op.sourceMaxSeq, reservationVersion: op.reservationVersion,
            sourceTranscriptHash: op.sourceTranscriptHash });
        if (!intent || hashObject(identity(intent.operation)) !== hashObject(identity(operation))) {
            throw new Error('Durable rewind reservation has no matching local intent');
        }
        if (intent.ownerWorkerId !== this.options.workerId && !this.options.previousWorkerCannotRun?.()) {
            return await this.unknown(intent, 'Previous HAPI worker generation may still dispatch');
        }
        // A committed Hub operation is authoritative even after a later user
        // turn. Never compare that turn with the old prefix or truncate again.
        if (operation.phase === 'committed') {
            this.claimRecovery(intent);
            await this.options.consumeCommitted?.();
            intent.phase = 'finalized'; this.save(intent); this.options.gate.release(intent.operation.operationId);
            return { success: true as const, truncateFromLocalId: operation.requestedLocalId };
        }
        try {
            if (intent.pendingRequest && !this.options.requestsFromPreviousWorkerCannotRun()) return await this.unknown(intent, 'Native request cohort may still mutate later');
            intent.pendingRequest = false;
            this.claimRecovery(intent);
            const read = await this.observe();
            if (!read.idle) return await this.unknown(intent, 'Native input is still active');
            if (hashObject(read.rows) === intent.sourceHash) {
                if (!read.staged) {
                    const rejected = await this.options.report({ operation: intent.operation, phase: 'rejected', unchanged: true,
                        sourceHash: intent.sourceHash, prefixHash: intent.prefixHash });
                    if (rejected.phase !== 'rejected') throw new Error('Source-unchanged rejection not confirmed');
                    intent.phase = 'finalized'; this.save(intent); this.options.gate.release();
                    return { success: false as const, outcome: 'rejected' as const, error: 'Native source is unchanged' };
                }
                if (read.staged !== operation.nativeMessageId) return await this.unknown(intent, 'Another native stage owns this session');
                // A recovery can itself lose an ACK. Its new request belongs
                // to this server generation, not the already-dead old cohort.
                intent.nativeProcess = this.options.nativeProcess;
                intent.phase = 'commit-issued'; intent.pendingRequest = true; this.save(intent);
                await this.request(`/api/session/${encodeURIComponent(operation.nativeSessionId)}/revert/commit`, {});
                intent.pendingRequest = false; this.save(intent);
            }
            return await this.settle(intent);
        } catch (error) { return await this.unknown(intent, error); }
    }
}
