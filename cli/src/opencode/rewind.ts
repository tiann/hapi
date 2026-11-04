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
    private rewindOwner: symbol | undefined;
    private reconciledOperationId: string | undefined;
    private readonly waiters: Array<() => void> = [];
    enterRuntime(): () => void {
        if (this.blocked) throw new Error('OpenCode rewind is pending reconciliation');
        this.active++;
        let released = false;
        return () => { if (!released) { released = true; this.active--; } };
    }
    enterLocalRuntime(operation: OpenCodeRewindOperation | undefined): () => void {
        if (operation && (!['committed', 'rejected'].includes(operation.phase)
            || this.reconciledOperationId !== operation.operationId)) {
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
    release(reconciledOperationId?: string): void {
        if (reconciledOperationId) this.reconciledOperationId = reconciledOperationId;
        this.blocked = false; for (const resolve of this.waiters.splice(0)) resolve();
    }
    waitUntilOpen(): Promise<void> { return this.blocked ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
    isBlocked(): boolean { return this.blocked; }
    hasReconciled(operationId: string): boolean { return this.reconciledOperationId === operationId; }
    acquireRewind(): symbol {
        if (this.rewindOwner) throw new Error('OpenCode rewind is busy');
        return this.rewindOwner = Symbol('rewind');
    }
    releaseRewind(owner: symbol): void {
        if (this.rewindOwner === owner) this.rewindOwner = undefined;
    }
}

type Options = {
    directory: string; hapiSessionId: string; workerId: string; gate: OpenCodeRuntimeGate;
    baseUrl: string; nativeSessionId: string; headers: Record<string, string>;
    request?: (url: string, init?: RequestInit) => Promise<Response>;
    report: (report: OpenCodeRewindReport) => Promise<OpenCodeRewindOperation>;
    getAuthoritativeOperation: () => Promise<OpenCodeRewindOperation | undefined>;
    flush: () => Promise<boolean>; isIdle: () => boolean;
    sourceCheckpoint: () => Checkpoint | undefined; sourceIndexes: () => Record<string, number>;
    requestsFromPreviousWorkerCannotRun: () => boolean;
    nativeProcess?: { pid: number; startMarker: string };
    consumeCommitted?: () => Promise<void>;
    previousWorkerCannotRun?: (owner: { pid: number; startMarker: string }) => boolean;
};

function operationIdentity(op: OpenCodeRewindOperation) {
    return { operationId: op.operationId, nativeSessionId: op.nativeSessionId, workerId: op.workerId,
        workerPid: op.workerPid, workerStartMarker: op.workerStartMarker, requestedLocalId: op.requestedLocalId,
        nativeMessageId: op.nativeMessageId, cutoffSeq: op.cutoffSeq, sourceEpoch: op.sourceEpoch,
        sourceMaxSeq: op.sourceMaxSeq, reservationVersion: op.reservationVersion, sourceTranscriptHash: op.sourceTranscriptHash };
}
function sameOperation(a: OpenCodeRewindOperation, b: OpenCodeRewindOperation): boolean {
    return hashObject(operationIdentity(a)) === hashObject(operationIdentity(b));
}
export class OpenCodeRewindSupersededError extends Error {
    constructor(readonly operationId: string) {
        super('OpenCode rewind reservation is no longer authoritative');
    }
}
class OpenCodeRewindPostCommitError extends Error {
    constructor(error: unknown) {
        super('OpenCode committed rewind could not be reconciled', { cause: error });
    }
}
function staleOperation(observed: OpenCodeRewindOperation, requested: OpenCodeRewindOperation): Error {
    return observed.operationId !== requested.operationId
        ? new OpenCodeRewindSupersededError(observed.operationId)
        : new Error('OpenCode rewind reservation is no longer authoritative');
}

function protectedWrite(path: string, value: unknown): void {
    const temporary = `${path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
}

export class OpenCodeRewind {
    private readonly path: string;
    private readonly directory: string;
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
            || !['prepared', 'stage-issued', 'staged', 'commit-issued', 'applied', 'unknown', 'finalized'].includes(intent.phase)
            || typeof intent.pendingRequest !== 'boolean' || typeof intent.ownerWorkerId !== 'string' || !intent.ownerWorkerId
            || typeof intent.backupPath !== 'string'
            || (intent.phase !== 'finalized' && intent.operation.workerPid && intent.operation.workerStartMarker
                && intent.ownerWorkerId === intent.operation.workerId
                && (intent.ownerProcess?.pid !== intent.operation.workerPid
                    || intent.ownerProcess?.startMarker !== intent.operation.workerStartMarker))
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
    private async unknown(intent: Intent, error: unknown, revalidateAfterReport = false): Promise<{ success: false; outcome: 'unknown'; error: string }> {
        this.options.gate.block(); intent.phase = 'unknown'; intent.lastError = error instanceof Error ? error.message : String(error); this.save(intent);
        try { await this.options.report({ operation: intent.operation, phase: 'unknown' }); } catch { /* remain blocked */ }
        if (revalidateAfterReport) {
            let current: OpenCodeRewindOperation | undefined;
            try { current = await this.options.getAuthoritativeOperation(); } catch { /* remain blocked */ }
            if (current && current.operationId !== intent.operation.operationId) throw staleOperation(current, intent.operation);
        }
        return { success: false, outcome: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    private async consumeAndFinalize(intent: Intent) {
        let consumptionError: unknown;
        let consumptionFailed = false;
        try { await this.options.consumeCommitted?.(); } catch (error) { consumptionFailed = true; consumptionError = error; }
        try {
            const current = await this.options.getAuthoritativeOperation();
            if (!current) throw new Error('OpenCode committed rewind metadata is unavailable');
            const latest = this.readIntent();
            if (!latest || hashObject(latest) !== hashObject(intent)) {
                if (!sameOperation(current, intent.operation)) throw staleOperation(current, intent.operation);
                throw new Error('OpenCode committed rewind journal ownership changed');
            }
            if (!sameOperation(current, intent.operation)) {
                if (!consumptionFailed) { latest.phase = 'finalized'; this.save(latest); }
                throw staleOperation(current, intent.operation);
            }
            if (current.phase !== 'committed') throw new Error('OpenCode committed rewind is no longer authoritative');
            if (consumptionFailed) return await this.unknown(latest, consumptionError, true);
            latest.phase = 'finalized'; this.save(latest); this.options.gate.release(latest.operation.operationId);
            return { success: true as const, truncateFromLocalId: latest.operation.requestedLocalId };
        } catch (error) {
            if (error instanceof OpenCodeRewindSupersededError) throw error;
            throw new OpenCodeRewindPostCommitError(error);
        }
    }
    private async handleAppliedReportFailure(intent: Intent, error: unknown) {
        try {
            const current = await this.options.getAuthoritativeOperation();
            if (!current) throw new Error('OpenCode rewind metadata is unavailable after the applied report');
            if (!sameOperation(current, intent.operation)) throw staleOperation(current, intent.operation);
            const latest = this.readIntent();
            if (!latest || hashObject(latest) !== hashObject(intent)) throw new Error('OpenCode rewind journal ownership changed');
            return await this.unknown(latest, error, true);
        } catch (failure) {
            if (failure instanceof OpenCodeRewindSupersededError) throw failure;
            throw new OpenCodeRewindPostCommitError(failure);
        }
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
        let committed: OpenCodeRewindOperation;
        try {
            committed = await this.options.report({ operation: intent.operation, phase: 'applied',
                sourceHash: intent.sourceHash, prefixHash: intent.prefixHash, checkpoint: intent.checkpoint, indexes: intent.indexes });
        } catch (error) { return await this.handleAppliedReportFailure(intent, error); }
        if (!sameOperation(committed, intent.operation) || committed.phase !== 'committed') {
            return await this.handleAppliedReportFailure(intent, new Error('Hub rewind commit is unconfirmed'));
        }
        return await this.consumeAndFinalize(intent);
    }
    async execute(operation: OpenCodeRewindOperation) {
        // Ownership is acquired synchronously, before flush/read/journal awaits.
        const owner = this.options.gate.acquireRewind();
        let intent: Intent | undefined;
        let reserved = false;
        let stale = false;
        let restoreReconciled = false;
        let authorityUncertain = false;
        try {
            this.options.gate.reserve(); reserved = true;
            authorityUncertain = true;
            const admission = await this.options.getAuthoritativeOperation();
            if (!admission) throw new Error('OpenCode rewind reservation is unavailable');
            authorityUncertain = false;
            if (!sameOperation(admission, operation) || admission.phase !== 'reserved'
                || operation.nativeSessionId !== this.options.nativeSessionId || operation.workerId !== this.options.workerId
                || operation.workerPid !== process.pid || !operation.workerStartMarker
                || getProcessStartMarker(process.pid) !== operation.workerStartMarker) {
                stale = true;
                restoreReconciled = sameOperation(admission, operation)
                    && (admission.phase === 'committed' || admission.phase === 'rejected')
                    && this.options.gate.hasReconciled(operation.operationId);
                throw staleOperation(admission, operation);
            }
            if (!this.options.isIdle()) throw new Error('Native rewind worker is not idle');
            const prior = this.readIntent();
            if (prior?.phase !== undefined && prior.phase !== 'finalized') throw new Error('An earlier rewind intent is unresolved');
            // An operation ID owns its original projection permanently, even
            // after a newer operation replaces the current journal.
            if (prior?.operation.operationId === operation.operationId
                || existsSync(join(this.directory, `${hashObject(operation.operationId)}.projection.json`))) {
                throw new Error('OpenCode rewind operation is already recorded');
            }
            if (!await this.options.flush()) throw new Error('Source metadata/output is not durable');
            authorityUncertain = true;
            const afterFlush = await this.options.getAuthoritativeOperation();
            if (!afterFlush) throw new Error('OpenCode rewind reservation is unavailable');
            authorityUncertain = false;
            if (!sameOperation(afterFlush, operation) || afterFlush.phase !== 'reserved') {
                stale = true;
                restoreReconciled = sameOperation(afterFlush, operation)
                    && (afterFlush.phase === 'committed' || afterFlush.phase === 'rejected')
                    && this.options.gate.hasReconciled(operation.operationId);
                throw staleOperation(afterFlush, operation);
            }
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
            authorityUncertain = true;
            const current = await this.options.getAuthoritativeOperation();
            if (!current) throw new Error('OpenCode rewind reservation is unavailable');
            authorityUncertain = false;
            if (!sameOperation(current, operation) || current.phase !== 'reserved') {
                stale = true;
                restoreReconciled = sameOperation(current, operation)
                    && (current.phase === 'committed' || current.phase === 'rejected')
                    && this.options.gate.hasReconciled(operation.operationId);
                throw staleOperation(current, operation);
            }
            const backupPath = join(this.directory, `${hashObject(operation.operationId)}.projection.json`);
            protectedWrite(backupPath, { info: read.info, messages: read.rows });
            if (hashObject(JSON.parse(readFileSync(backupPath, 'utf8')).messages) !== hashObject(read.rows)) throw new Error('Backup verification failed');
            intent = { operation, phase: 'prepared', source: read.rows, prefix, sourceHash: hashObject(read.rows), prefixHash: hashObject(prefix),
                backupPath, checkpoint: { sessionId: operation.nativeSessionId, messageIds: prefix.map(r => r.id), userMessageIds: users, localMessageIds: [] },
                indexes: retained, pendingRequest: false, nativeProcess: this.options.nativeProcess, ownerWorkerId: this.options.workerId,
                ownerProcess: { pid: operation.workerPid!, startMarker: operation.workerStartMarker! } };
            this.save(intent);
            const prepared = await this.options.report({ operation, phase: 'prepared', sourceHash: intent.sourceHash, prefixHash: intent.prefixHash });
            if (prepared.phase !== 'prepared' || !sameOperation(prepared, operation)) throw new Error('Hub preparation unconfirmed');
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
            if (!reserved) {
                if (!this.options.gate.isBlocked()) {
                    const current = await this.options.getAuthoritativeOperation();
                    if (current && sameOperation(current, operation) && current.phase === 'reserved'
                        && operation.workerId === this.options.workerId && operation.nativeSessionId === this.options.nativeSessionId
                        && operation.workerPid === process.pid && operation.workerStartMarker
                        && getProcessStartMarker(process.pid) === operation.workerStartMarker) {
                        await this.options.report({ operation, phase: 'rejected' });
                    }
                }
                throw error;
            }
            if (stale) { if (restoreReconciled) this.options.gate.release(); throw error; }
            if (authorityUncertain) throw error;
            if (error instanceof OpenCodeRewindSupersededError || error instanceof OpenCodeRewindPostCommitError) throw error;
            if (intent) return await this.unknown(intent, error);
            // No native write has been issued in this branch. An unresolved
            // earlier journal must nevertheless keep the runtime blocked.
            const prior = this.readIntent();
            if (prior && prior.phase !== 'finalized') {
                if (!sameOperation(prior.operation, operation)) throw error;
                return await this.unknown(prior, error);
            }
            const rejected = await this.options.report({ operation, phase: 'rejected' });
            const current = await this.options.getAuthoritativeOperation();
            if (!sameOperation(rejected, operation) || rejected.phase !== 'rejected'
                || !current || !sameOperation(current, operation) || current.phase !== 'rejected') throw new Error('Hub rejection is unconfirmed');
            this.options.gate.release(operation.operationId);
            return { success: false as const, outcome: 'rejected' as const, error: String(error) };
        } finally { this.options.gate.releaseRewind(owner); }
    }
    async recover(operation: OpenCodeRewindOperation) {
        const owner = this.options.gate.acquireRewind();
        try { return await this.recoverReserved(operation); }
        finally { this.options.gate.releaseRewind(owner); }
    }
    private async recoverReserved(operation: OpenCodeRewindOperation) {
        if (!this.options.gate.isBlocked()) this.options.gate.reserve();
        const current = await this.options.getAuthoritativeOperation();
        if (!current) throw new Error('OpenCode rewind reservation is unavailable');
        if (!sameOperation(current, operation)) {
            throw staleOperation(current, operation);
        }
        operation = current;
        if (operation.nativeSessionId !== this.options.nativeSessionId) throw new Error('OpenCode rewind native session mismatch');
        const intent = this.readIntent();
        if (!intent || (intent.phase === 'finalized' && !sameOperation(intent.operation, operation))) {
            if (operation.phase !== 'reserved' && operation.phase !== 'rejected') throw new Error('Durable rewind reservation has no matching local intent');
            if (!operation.workerPid || !operation.workerStartMarker) throw new Error('Rewind worker generation is unavailable');
            const sameWorker = operation.workerId === this.options.workerId && operation.workerPid === process.pid
                && getProcessStartMarker(process.pid) === operation.workerStartMarker;
            if (!sameWorker && !this.options.previousWorkerCannotRun?.({ pid: operation.workerPid, startMarker: operation.workerStartMarker })) {
                throw new Error('Previous HAPI worker generation may still dispatch');
            }
            const rejected = operation.phase === 'reserved' ? await this.options.report({ operation, phase: 'rejected' }) : operation;
            const current = await this.options.getAuthoritativeOperation();
            if (!sameOperation(rejected, operation) || rejected.phase !== 'rejected'
                || !current || !sameOperation(current, operation) || current.phase !== 'rejected') throw new Error('Hub rejection is unconfirmed');
            this.options.gate.release(operation.operationId);
            return { success: false as const, outcome: 'rejected' as const, error: 'Unprepared reservation was rejected' };
        }
        if (!sameOperation(intent.operation, operation)) {
            throw new Error('Durable rewind reservation has no matching local intent');
        }
        if (intent.ownerWorkerId !== this.options.workerId && (!intent.ownerProcess || !this.options.previousWorkerCannotRun?.(intent.ownerProcess))) {
            return { success: false as const, outcome: 'unknown' as const, error: 'Previous HAPI worker generation may still dispatch' };
        }
        if (operation.phase === 'rejected') {
            if (intent.pendingRequest) throw new Error('Native request cohort may still mutate later');
            const current = await this.options.getAuthoritativeOperation();
            if (!current || !sameOperation(current, operation) || current.phase !== 'rejected') throw new Error('Hub rejection is unconfirmed');
            this.claimRecovery(intent);
            intent.phase = 'finalized'; this.save(intent); this.options.gate.release(operation.operationId);
            return { success: false as const, outcome: 'rejected' as const, error: 'Hub rejected rewind' };
        }
        // A committed Hub operation is authoritative even after a later user
        // turn. Never compare that turn with the old prefix or truncate again.
        if (operation.phase === 'committed') {
            this.claimRecovery(intent);
            return await this.consumeAndFinalize(intent);
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
                    const current = await this.options.getAuthoritativeOperation();
                    if (rejected.phase !== 'rejected' || !sameOperation(rejected, operation)
                        || !current || current.phase !== 'rejected' || !sameOperation(current, operation)) throw new Error('Source-unchanged rejection not confirmed');
                    intent.phase = 'finalized'; this.save(intent); this.options.gate.release(operation.operationId);
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
        } catch (error) {
            if (error instanceof OpenCodeRewindSupersededError || error instanceof OpenCodeRewindPostCommitError) throw error;
            return await this.unknown(intent, error);
        }
    }
}
