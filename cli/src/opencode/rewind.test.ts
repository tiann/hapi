import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { getProcessStartMarker } from '@/utils/process';
import { OpencodeSession } from './session';
import { OpenCodeRewind, OpenCodeRuntimeGate } from './rewind';
import type { OpenCodeRewindReport } from '@hapi/protocol/apiTypes';
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas';

// Windows FlushFileBuffers requires GENERIC_WRITE, which a read-only directory
// handle does not carry, so fsyncSync on a directory fd fails there. The guard
// lets tests simulate that EPERM for directory fds while file fds stay real.
const windowsDirectoryFsync = vi.hoisted(() => ({
    guard: undefined as (() => never) | undefined,
    markerOverride: undefined as ((pid: number) => string | null) | undefined
}));
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const fsyncSync: typeof actual.fsyncSync = fd => {
        if (windowsDirectoryFsync.guard && actual.fstatSync(fd).isDirectory()) windowsDirectoryFsync.guard();
        return actual.fsyncSync(fd);
    };
    return { ...actual, fsyncSync };
});
// The Windows stub must not disturb the worker-generation proof: while active,
// getProcessStartMarker keeps answering with the real Linux marker.
vi.mock('@/utils/process', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/process')>();
    const getProcessStartMarker: typeof actual.getProcessStartMarker = pid =>
        windowsDirectoryFsync.markerOverride ? windowsDirectoryFsync.markerOverride(pid) : actual.getProcessStartMarker(pid);
    return { ...actual, getProcessStartMarker };
});

const rows = [
    { id: 'u1', type: 'user', text: 'one' },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { id: 'u2', type: 'user', text: 'two' },
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'second answer' }] }
];
const operation = { operationId: 'operation', nativeSessionId: 'native', workerId: 'worker', requestedLocalId: 'local2',
    nativeMessageId: 'u2', cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 4, reservationVersion: 2, sourceTranscriptHash: 'c'.repeat(64),
    workerPid: process.pid, workerStartMarker: getProcessStartMarker(process.pid)!, phase: 'reserved' as const };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const f of cleanups.splice(0)) f(); });

/** Pretends the test runs on Windows: platform reports win32 and directory fsync
 *  fails with EPERM, per the documented FlushFileBuffers access rights. */
function stubWindowsDirectoryFsync(): () => void {
    const marker = getProcessStartMarker(process.pid);
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    windowsDirectoryFsync.markerOverride = () => marker;
    windowsDirectoryFsync.guard = () => {
        const error: NodeJS.ErrnoException = new Error('EPERM: FlushFileBuffers requires GENERIC_WRITE on a read-only directory handle');
        error.code = 'EPERM';
        throw error;
    };
    return () => { platform.mockRestore(); windowsDirectoryFsync.markerOverride = undefined; windowsDirectoryFsync.guard = undefined; };
}

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-rewind-'));
    let current = structuredClone(rows);
    let staged: string | undefined;
    const ownership = { nativeGone: false, workerGone: false };
    const gate = new OpenCodeRuntimeGate();
    const reports: OpenCodeRewindReport[] = [];
    let authoritative: OpenCodeRewindOperation = operation;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/revert/stage')) { staged = JSON.parse(init!.body as string).messageID; return Response.json({}); }
        if (path.endsWith('/revert/commit')) { current = current.slice(0, 2); staged = undefined; return new Response(null, { status: 204 }); }
        if (path.includes('/message?')) return Response.json({ data: current, cursor: {} });
        if (path.endsWith('/active')) return Response.json({ data: {} });
        if (path.endsWith('/inbox')) return Response.json({ data: [] });
        return Response.json({ data: { id: 'native', ...(staged ? { revert: { messageID: staged } } : {}) } });
    });
    const report = vi.fn(async (value: OpenCodeRewindReport): Promise<OpenCodeRewindOperation> => {
        reports.push(value);
        authoritative = { ...value.operation, phase: value.phase === 'applied' ? 'committed' : value.phase };
        return authoritative;
    });
    const consumeCommitted = vi.fn(async () => {});
    const options = { directory, hapiSessionId: 'hapi', workerId: 'worker', gate,
        baseUrl: 'http://native', nativeSessionId: 'native', headers: {}, request,
        report, getAuthoritativeOperation: async () => authoritative, flush: async () => true, isIdle: () => true,
        sourceCheckpoint: () => ({ sessionId: 'native', messageIds: rows.map(r => r.id), userMessageIds: ['u1', 'u2'], localMessageIds: [] }),
        sourceIndexes: () => ({ local1: 0, local2: 1 }), requestsFromPreviousWorkerCannotRun: () => ownership.nativeGone,
        previousWorkerCannotRun: () => ownership.workerGone, consumeCommitted,
        nativeProcess: { pid: 101, startMarker: 'original-native-generation' } };
    const rewind = new OpenCodeRewind(options);
    return { rewind, gate, directory, reports, report, request, ownership, consumeCommitted,
        restart: (overrides: Partial<typeof options> = {}) => new OpenCodeRewind({ ...options, workerId: 'replacement', ...overrides }),
        setAuthoritative: (value: OpenCodeRewindOperation) => { authoritative = value; },
        getAuthoritative: () => authoritative,
        setRows: (value: typeof rows) => { current = value; } };
}

describe('OpenCode same-native-ID durable rewind', () => {
    it('backs up before stage, commits the exact prefix and only releases after authoritative Hub commit', async () => {
        const f = fixture();
        const result = await f.rewind.execute(operation);
        expect(result.success).toBe(true);
        expect(f.reports.map(r => r.phase)).toEqual(['prepared', 'applied']);
        expect(f.reports[1]?.checkpoint).toMatchObject({ sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'] });
        expect(f.reports[1]?.indexes).toEqual({ local1: 0 });
        const journal = f.rewind.readIntent()!;
        expect(journal.phase).toBe('finalized');
        expect(JSON.parse(readFileSync(journal.backupPath, 'utf8')).messages).toEqual(rows);
        expect(statSync(journal.backupPath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(journal.backupPath)).mode & 0o777).toBe(0o700);
        expect(statSync(join(dirname(journal.backupPath), 'intent.json')).mode & 0o777).toBe(0o600);
        expect(f.consumeCommitted).toHaveBeenCalledOnce();
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('finalizes the journal on Windows where a directory fsync is unavailable', async () => {
        const f = fixture();
        const restore = stubWindowsDirectoryFsync();
        try {
            expect(await f.rewind.execute(operation)).toMatchObject({ success: true });
            expect(f.reports.map(r => r.phase)).toEqual(['prepared', 'applied']);
            expect(f.rewind.readIntent()?.phase).toBe('finalized');
            expect(f.gate.isBlocked()).toBe(false);
        } finally { restore(); }
    });

    it('reports unknown and stays recoverable on Windows where a directory fsync is unavailable', async () => {
        const f = fixture(); f.report.mockRejectedValueOnce(new Error('prepared ACK lost'));
        const restore = stubWindowsDirectoryFsync();
        try {
            expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'unknown' });
            expect(f.reports.map(r => r.phase)).toEqual(['unknown']);
            expect(f.rewind.readIntent()).toMatchObject({ phase: 'unknown', pendingRequest: false });
            expect(await f.rewind.recover({ ...operation, phase: 'unknown' })).toMatchObject({ success: false, outcome: 'rejected' });
            expect(f.rewind.readIntent()?.phase).toBe('finalized');
            expect(f.gate.isBlocked()).toBe(false);
        } finally { restore(); }
    });

    it('keeps independently owned entry fences and rewind blocks isolated', async () => {
        const gate = new OpenCodeRuntimeGate() as OpenCodeRuntimeGate & { acquireEntryFence(): symbol; releaseEntryFence(token: symbol): void };
        const first = gate.acquireEntryFence(); const second = gate.acquireEntryFence();
        gate.block(); gate.releaseEntryFence(first); expect(gate.isBlocked()).toBe(true);
        gate.release(); expect(gate.isBlocked()).toBe(true);
        gate.releaseEntryFence(first); expect(gate.isBlocked()).toBe(true);
        gate.releaseEntryFence(second); expect(gate.isBlocked()).toBe(false);
    });

    it('fences new runtime synchronously while waiting for an existing owner to drain', async () => {
        const gate = new OpenCodeRuntimeGate() as OpenCodeRuntimeGate & { acquireEntryFence(): symbol; releaseEntryFence(token: symbol): void; waitUntilIdle(): Promise<void> };
        const release = gate.enterRuntime(); const fence = gate.acquireEntryFence(); let idle = false;
        const drained = gate.waitUntilIdle().then(() => { idle = true; });
        expect(() => gate.enterRuntime()).toThrow('reconciliation');
        await Promise.resolve(); expect(idle).toBe(false);
        release(); await drained; expect(idle).toBe(true);
        expect(gate.isBlocked()).toBe(true); gate.releaseEntryFence(fence); expect(gate.isBlocked()).toBe(false);
    });

    it('hands a disposed owner fence to a successor without clearing the successor fence', () => {
        const gate = new OpenCodeRuntimeGate();
        const old = gate.acquireEntryFence(); const successor = gate.acquireEntryFence();
        let adopted: symbol | undefined;
        const detach = gate.onEntryHandoff(() => { adopted = gate.adoptInitialEntryFence(successor); });
        gate.handoffEntryFence(old);
        expect(adopted).toBe(successor);
        gate.releaseEntryFence(old);
        expect(gate.isBlocked()).toBe(true);
        detach(); gate.releaseEntryFence(successor);
        expect(gate.isBlocked()).toBe(false);
        const orphan = gate.acquireEntryFence(); gate.handoffEntryFence(orphan);
        expect(gate.takeInitialEntryFence()).toBe(orphan);
        gate.releaseEntryFence(orphan);
    });

    it('counts cancellation owners independently and refuses a real rewind blocker', async () => {
        const gate = new OpenCodeRuntimeGate();
        const fence = gate.acquireEntryFence();
        const first = gate.enterCancellation(); const second = gate.enterCancellation();
        expect(gate.isRuntimeActive()).toBe(true);
        expect(gate.hasOrdinaryRuntimeActivity()).toBe(false);
        expect(() => gate.enterRuntime()).toThrow('reconciliation');
        gate.block(); expect(() => gate.enterCancellation()).toThrow('reconciliation');
        first(); first(); let idle = false;
        const waiting = gate.waitUntilIdle().then(() => { idle = true; });
        await Promise.resolve(); expect(idle).toBe(false);
        second(); second(); await waiting; expect(idle).toBe(true);
        expect(gate.isBlocked()).toBe(true);
        gate.release(); gate.releaseEntryFence(fence); expect(gate.isBlocked()).toBe(false);
    });

    it('owns the runtime gate synchronously before its first await', async () => {
        const f = fixture();
        const pending = f.rewind.execute(operation);
        expect(() => f.gate.enterRuntime()).toThrow();
        await pending;
    });

    it('rejects reconnect recovery while the original operation still owns an awaited preparation', async () => {
        const f = fixture(); let resume!: () => void;
        f.report.mockImplementationOnce(() => new Promise(resolve => { resume = () => resolve({ ...operation, phase: 'prepared' }); }));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
        try {
            await expect(f.rewind.recover(operation)).rejects.toThrow('busy');
            expect(f.gate.isBlocked()).toBe(true);
        } finally { resume(); await pending; }
    });

    it('serializes separate controllers sharing a wrapper gate during a suspended preparation', async () => {
        const f = fixture(); let resume!: () => void;
        f.report.mockImplementationOnce(() => new Promise(resolve => { resume = () => resolve({ ...operation, phase: 'prepared' }); }));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
        try {
            await expect(f.restart({ workerId: 'worker' }).recover(operation)).rejects.toThrow('busy');
            expect(f.gate.isBlocked()).toBe(true);
        } finally { resume(); await pending; }
    });

    it('does not report an already stale RPC as a rejection of the newer reservation', async () => {
        const f = fixture();
        const newer = { ...operation, operationId: 'newer-reservation', reservationVersion: 4 };
        f.setAuthoritative(newer);
        const controller = f.restart({ workerId: 'worker', isIdle: () => false });
        await expect(controller.execute(operation)).rejects.toThrow('no longer authoritative');
        expect(f.report).not.toHaveBeenCalled();
        expect(controller.readIntent()).toBeUndefined();
        expect(f.gate.isBlocked()).toBe(true);
        expect(await f.rewind.recover(newer)).toMatchObject({ outcome: 'rejected' });
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('keeps admission blocked when authoritative metadata cannot be refreshed', async () => {
        const f = fixture();
        const controller = f.restart({ workerId: 'worker', getAuthoritativeOperation: async () => { throw new Error('offline'); } });
        await expect(controller.execute(operation)).rejects.toThrow('offline');
        expect(f.report).not.toHaveBeenCalled();
        expect(f.gate.isBlocked()).toBe(true);
    });

    it.each(['reserved', 'prepared'] as const)('keeps admission blocked for current %s after a queued stale operation', async phase => {
        const f = fixture(); let resumeOld!: () => void;
        const old = f.restart({ workerId: 'worker', flush: () => new Promise(resolve => { resumeOld = () => resolve(true); }) });
        const oldExecution = old.execute(operation);
        await vi.waitFor(() => expect(resumeOld).toBeTypeOf('function'));
        const next = { ...operation, operationId: `current-${phase}`, reservationVersion: 3,
            workerId: phase === 'prepared' ? 'worker2' : 'worker' };
        f.setAuthoritative(next);
        let releasePrepared: (() => void) | undefined;
        let preparedEntered: (() => void) | undefined;
        let currentExecution: Promise<unknown> | undefined;
        if (phase === 'prepared') {
            const ready = new Promise<void>(resolve => { preparedEntered = resolve; });
            const hold = new Promise<void>(resolve => { releasePrepared = resolve; });
            const actualReport = f.report.getMockImplementation()!;
            f.report.mockImplementation(async report => {
                const result = await actualReport(report);
                if (report.phase === 'prepared' && report.operation.operationId === next.operationId) { preparedEntered!(); await hold; }
                return result;
            });
            currentExecution = f.restart({ workerId: 'worker2', gate: new OpenCodeRuntimeGate() }).execute(next);
            await ready;
        }
        const reportsBefore = f.reports.length; const nativeBefore = f.request.mock.calls.length;
        const queue = new MessageQueue2<import('./types').OpencodeMode>(() => 'mode');
        const session = new OpencodeSession({ api: {} as never, client: { keepAlive: vi.fn(), emitMessagesConsumed: vi.fn() } as never,
            path: '/fixture', logPath: '/fixture/log', sessionId: 'native', messageQueue: queue,
            onModeChange: () => {}, startedBy: 'runner', startingMode: 'remote', runtimeGate: f.gate });
        cleanups.push(() => session.stopKeepAlive());
        try {
            resumeOld(); await expect(oldExecution).rejects.toThrow('no longer authoritative');
            expect(f.reports).toHaveLength(reportsBefore);
            expect(f.request.mock.calls).toHaveLength(nativeBefore);
            expect(old.readIntent()?.operation.operationId).toBe(phase === 'prepared' ? next.operationId : undefined);
            expect(f.gate.isBlocked()).toBe(true);
            expect(() => f.gate.enterRuntime()).toThrow('pending reconciliation');
            queue.push('queued input', { permissionMode: 'default' });
            await expect(queue.waitForMessagesAndGetAsString()).rejects.toThrow('pending reconciliation');
            expect(queue.size()).toBe(1);
            if (phase === 'prepared') {
                releasePrepared!(); expect(await currentExecution).toMatchObject({ success: true });
                f.ownership.workerGone = true;
                expect(await f.rewind.recover({ ...next, phase: 'committed' })).toMatchObject({ success: true });
            } else {
                expect(await f.rewind.recover(next)).toMatchObject({ outcome: 'rejected' });
            }
            expect(f.gate.isBlocked()).toBe(false);
            expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('queued input');
            session.takeDequeuedRuntimeRelease()!();
        } finally { releasePrepared?.(); await currentExecution; queue.close(); }
    });

    it('does not reject an absent journal while a different live worker is still before its first write', async () => {
        const f = fixture(); let resume!: () => void;
        const first = f.restart({ workerId: 'worker', flush: () => new Promise(resolve => { resume = () => resolve(true); }) });
        const running = first.execute(operation);
        await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
        const replacementGate = new OpenCodeRuntimeGate();
        const replacement = f.restart({ gate: replacementGate });
        try {
            expect(first.readIntent()).toBeUndefined();
            await expect(replacement.recover(operation)).rejects.toThrow('Previous HAPI worker');
            expect(replacementGate.isBlocked()).toBe(true);
            expect(f.report).not.toHaveBeenCalled();
        } finally { resume(); await running; }
        expect(first.readIntent()?.operation.operationId).toBe(operation.operationId);
    });

    it('keeps a malformed or conflicting unfinished journal blocked', async () => {
        const f = fixture(); f.report.mockRejectedValueOnce(new Error('prepared ACK lost'));
        expect(await f.rewind.execute(operation)).toMatchObject({ outcome: 'unknown' });
        const journal = f.rewind.readIntent()!;
        const other = { ...operation, operationId: 'different' };
        f.setAuthoritative(other);
        await expect(f.rewind.recover(other)).rejects.toThrow('no matching local intent');
        expect(f.rewind.readIntent()?.operation.operationId).toBe(operation.operationId);
        writeFileSync(join(dirname(journal.backupPath), 'intent.json'), '{');
        await expect(f.rewind.recover(other)).rejects.toThrow();
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('rejects an already admitted config/input even with an empty queue', async () => {
        const f = fixture(); const release = f.gate.enterRuntime();
        await expect(f.rewind.execute(operation)).rejects.toThrow('busy');
        release();
        expect(f.request).not.toHaveBeenCalled();
    });

    it('does not execute an already recorded operation or overwrite its original backup', async () => {
        const f = fixture(); await f.rewind.execute(operation);
        const path = f.rewind.readIntent()!.backupPath;
        const backup = readFileSync(path, 'utf8'); f.request.mockClear();
        await expect(f.rewind.execute(operation)).rejects.toThrow('no longer authoritative');
        expect(f.gate.isBlocked()).toBe(false);
        expect(f.request).not.toHaveBeenCalled();
        expect(readFileSync(path, 'utf8')).toBe(backup);
    });

    it('rejects an unprepared reservation with no journal and releases only after exact acknowledgement', async () => {
        const f = fixture();
        expect(await f.rewind.recover(operation)).toMatchObject({ success: false, outcome: 'rejected' });
        expect(f.reports).toEqual([{ operation, phase: 'rejected' }]);
        expect(f.gate.isBlocked()).toBe(false);
        expect(f.request).not.toHaveBeenCalled();
    });

    it('keeps an absent-intent replacement blocked while the reserved owner may still run', async () => {
        const f = fixture();
        await expect(f.restart().recover(operation)).rejects.toThrow();
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.report).not.toHaveBeenCalled();
        expect(f.request).not.toHaveBeenCalled();
    });

    it('does not recover a reservation on a different native session', async () => {
        const f = fixture();
        const wrongSession = f.restart({ workerId: 'worker', nativeSessionId: 'different-native' });
        await expect(wrongSession.recover(operation)).rejects.toThrow('native session');
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.report).not.toHaveBeenCalled();
        expect(f.request).not.toHaveBeenCalled();
    });

    it('keeps legacy absent-intent reservations without worker proof blocked', async () => {
        const f = fixture(); const legacy = { ...operation, workerPid: undefined, workerStartMarker: undefined };
        f.setAuthoritative(legacy); f.ownership.workerGone = true;
        await expect(f.restart().recover(legacy)).rejects.toThrow('generation is unavailable');
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.report).not.toHaveBeenCalled();
    });

    it('never finalizes a rejected journal whose native request may still mutate', async () => {
        const f = fixture(); const transport = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (path, init) => {
            if (path.endsWith('/revert/stage')) throw new Error('stage ACK lost');
            return transport(path, init);
        });
        expect(await f.rewind.execute(operation)).toMatchObject({ outcome: 'unknown' });
        expect(f.rewind.readIntent()?.pendingRequest).toBe(true);
        f.setAuthoritative({ ...operation, phase: 'rejected' });
        await expect(f.rewind.recover({ ...operation, phase: 'rejected' })).rejects.toThrow('cohort');
        expect(f.rewind.readIntent()?.phase).toBe('unknown');
        expect(f.gate.isBlocked()).toBe(true);
    });

    it.each(['committed', 'rejected', 'unknown'] as const)('recovers a matching b6-shaped legacy journal in %s state', async phase => {
        const f = fixture();
        if (phase === 'committed') expect(await f.rewind.execute(operation)).toMatchObject({ success: true });
        else {
            f.report.mockRejectedValueOnce(new Error('prepare ACK lost'));
            expect(await f.rewind.execute(operation)).toMatchObject({ outcome: 'unknown' });
        }
        const journal = f.rewind.readIntent()!;
        const path = join(dirname(journal.backupPath), 'intent.json');
        const legacyOperation = { ...journal.operation, workerPid: undefined, workerStartMarker: undefined };
        writeFileSync(path, JSON.stringify({ ...journal, operation: legacyOperation }));
        f.setAuthoritative({ ...legacyOperation, phase }); f.ownership.workerGone = true;
        const replacement = f.restart();
        const result = await replacement.recover({ ...legacyOperation, phase });
        expect(result).toMatchObject(phase === 'committed' ? { success: true } : { outcome: 'rejected' });
        expect(replacement.readIntent()?.phase).toBe('finalized');
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('preserves a finalized legacy journal while admitting a distinct proof-bound rewind', async () => {
        const f = fixture(); await f.rewind.execute(operation);
        const old = f.rewind.readIntent()!; const backup = readFileSync(old.backupPath, 'utf8');
        const path = join(dirname(old.backupPath), 'intent.json');
        const legacy = { ...old, operation: { ...old.operation, workerPid: undefined, workerStartMarker: undefined } };
        writeFileSync(path, JSON.stringify(legacy));
        f.setRows(rows);
        const next = { ...operation, operationId: 'after-legacy-finalized', reservationVersion: 3 };
        f.setAuthoritative(next);
        expect(await f.rewind.execute(next)).toMatchObject({ success: true });
        expect(readFileSync(old.backupPath, 'utf8')).toBe(backup);
        expect(f.rewind.readIntent()?.operation.operationId).toBe(next.operationId);
    });

    it('blocks a journal whose original owner process differs from the immutable reservation', async () => {
        const f = fixture(); f.report.mockRejectedValueOnce(new Error('prepare ACK lost'));
        await f.rewind.execute(operation);
        const journal = f.rewind.readIntent()!;
        const path = join(dirname(journal.backupPath), 'intent.json');
        writeFileSync(path, JSON.stringify({ ...journal, ownerProcess: { pid: operation.workerPid, startMarker: 'wrong-generation' } }));
        f.ownership.workerGone = true; f.request.mockClear();
        await expect(f.restart().recover(operation)).rejects.toThrow('Invalid OpenCode rewind intent');
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.request).not.toHaveBeenCalled();
    });

    it('treats a journal with missing pending-request state as corrupt', async () => {
        const f = fixture(); f.report.mockRejectedValueOnce(new Error('prepare ACK lost'));
        await f.rewind.execute(operation);
        const journal = f.rewind.readIntent()!;
        const path = join(dirname(journal.backupPath), 'intent.json');
        const incomplete: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'));
        delete incomplete.pendingRequest; writeFileSync(path, JSON.stringify(incomplete));
        f.setAuthoritative({ ...operation, phase: 'rejected' });
        await expect(f.rewind.recover({ ...operation, phase: 'rejected' })).rejects.toThrow('Invalid OpenCode rewind intent');
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('rejects an absent-intent reservation after proving its original worker cannot run', async () => {
        const f = fixture(); f.ownership.workerGone = true;
        expect(await f.restart().recover(operation)).toMatchObject({ success: false, outcome: 'rejected' });
        expect(f.report).toHaveBeenCalledOnce();
        expect(f.gate.isBlocked()).toBe(false);
        expect(f.request).not.toHaveBeenCalled();
    });

    it.each(['phase', 'identity'] as const)('keeps an absent-intent reservation blocked on mismatched %s acknowledgement', async mismatch => {
        const f = fixture();
        f.report.mockResolvedValueOnce(mismatch === 'phase' ? { ...operation, phase: 'prepared' }
            : { ...operation, operationId: 'other', phase: 'rejected' });
        await expect(f.rewind.recover(operation)).rejects.toThrow();
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.request).not.toHaveBeenCalled();
    });

    it('finalizes the original rejected journal after acknowledgement loss and executes the next rewind', async () => {
        const f = fixture();
        const actualReport = f.report.getMockImplementation()!;
        let firstPrepare = true; let firstRejection = true;
        f.report.mockImplementation(async report => {
            if (report.phase === 'prepared' && firstPrepare) { firstPrepare = false; throw new Error('prepare response lost'); }
            if (report.phase === 'rejected' && firstRejection) {
                firstRejection = false;
                f.setAuthoritative({ ...operation, phase: 'rejected' });
                throw new Error('rejection response lost');
            }
            return actualReport(report);
        });
        expect(await f.rewind.execute(operation)).toMatchObject({ outcome: 'unknown' });
        expect(await f.rewind.recover({ ...operation, phase: 'unknown' })).toMatchObject({ outcome: 'unknown' });
        // The Hub retains its rejected tombstone when the old unknown report arrives.
        f.setAuthoritative({ ...operation, phase: 'rejected' });
        const before = f.rewind.readIntent()!;
        const backup = readFileSync(before.backupPath, 'utf8');
        f.request.mockClear(); f.ownership.workerGone = true;
        const restarted = f.restart({ workerId: 'worker' });
        expect(await restarted.recover({ ...operation, phase: 'rejected' })).toMatchObject({ outcome: 'rejected' });
        expect(restarted.readIntent()?.phase).toBe('finalized');
        expect(readFileSync(before.backupPath, 'utf8')).toBe(backup);
        expect(f.request).not.toHaveBeenCalled();
        const next = { ...operation, operationId: 'next', reservationVersion: 3 };
        f.setAuthoritative(next);
        expect(await restarted.execute(next)).toMatchObject({ success: true });
        expect(restarted.readIntent()?.operation.operationId).toBe('next');
    });

    it('retains original Hub history, backup and peer rows on external input conflict', async () => {
        const f = fixture();
        const transport = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (path, init) => {
            const response = await transport(path, init);
            if (path.endsWith('/revert/commit')) f.setRows([...rows.slice(0, 2), { id: 'peer', type: 'user', text: 'peer input' }]);
            return response;
        });
        const result = await f.rewind.execute(operation);
        expect(result).toMatchObject({ success: false, outcome: 'unknown' });
        expect(f.reports.at(-1)?.phase).toBe('unknown');
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.request.mock.calls.some(([p, init]) => init?.method === 'DELETE' || p.endsWith('/restore'))).toBe(false);
        expect(f.rewind.readIntent()?.backupPath).toBeTruthy();
    });

    it('accepts a peer-consumed desired prefix only when its own stage request has settled', async () => {
        const f = fixture(); const transport = f.request.getMockImplementation()!;
        let consumed = false;
        f.request.mockImplementation(async (path, init) => {
            if (consumed && path.endsWith('/session/native')) return Response.json({ data: { id: 'native' } });
            const response = await transport(path, init);
            if (path.endsWith('/revert/stage')) { consumed = true; f.setRows(rows.slice(0, 2)); }
            return response;
        });
        expect(await f.rewind.execute(operation)).toMatchObject({ success: true });
        expect(f.request.mock.calls.some(([path]) => path.endsWith('/revert/commit'))).toBe(false);
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('does not settle an exact prefix while a late generic mutation cohort remains unresolved', async () => {
        const f = fixture();
        const transport = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (path, init) => {
            if (path.endsWith('/revert/commit')) { f.setRows(rows.slice(0, 2)); throw new Error('ACK lost, request cohort unowned'); }
            return transport(path, init);
        });
        expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'unknown' });
        expect(await f.rewind.recover(operation)).toMatchObject({ success: false, outcome: 'unknown' });
        expect(f.request.mock.calls.filter(([p]) => p.endsWith('/revert/commit'))).toHaveLength(1);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('retries an applied report after Hub ACK loss without issuing another native mutation', async () => {
        const f = fixture(); const report = f.report.getMockImplementation()!;
        f.report.mockImplementationOnce(report).mockImplementationOnce(async () => { throw new Error('Hub ACK lost'); });
        expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'unknown' });
        expect(await f.rewind.recover(operation)).toMatchObject({ success: true });
        expect(f.request.mock.calls.filter(([p]) => p.endsWith('/revert/commit'))).toHaveLength(1);
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('rejects a prepared-only interruption without clearing or mutating native history', async () => {
        const f = fixture();
        f.report.mockRejectedValueOnce(new Error('prepared ACK lost'));
        expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'unknown' });
        expect(await f.rewind.recover({ ...operation, phase: 'unknown' })).toMatchObject({ success: false, outcome: 'rejected' });
        expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
        expect(f.gate.isBlocked()).toBe(false);
    });

    it.each(['stage', 'commit'])('recovers %s ACK loss only after both previous worker and native cohort are proven unable to write', async (phase) => {
        const f = fixture(); const transport = f.request.getMockImplementation()!;
        let fault = true;
        f.request.mockImplementation(async (path, init) => {
            const response = await transport(path, init);
            if (fault && path.endsWith(`/revert/${phase}`)) { fault = false; throw new Error('native ACK lost'); }
            return response;
        });
        expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'unknown' });
        const restarted = f.restart();
        expect(await restarted.recover({ ...operation, phase: 'unknown' })).toMatchObject({ outcome: 'unknown' });
        f.ownership.nativeGone = true;
        expect(await restarted.recover({ ...operation, phase: 'unknown' })).toMatchObject({ outcome: 'unknown' });
        f.ownership.nativeGone = false;
        f.ownership.workerGone = true;
        expect(await restarted.recover({ ...operation, phase: 'unknown' })).toMatchObject({ outcome: 'unknown' });
        f.ownership.nativeGone = true;
        expect(await restarted.recover({ ...operation, phase: 'unknown' })).toMatchObject({ success: true });
        expect(f.request.mock.calls.filter(([path]) => path.endsWith('/revert/stage'))).toHaveLength(1);
        expect(f.request.mock.calls.filter(([path]) => path.endsWith('/revert/commit'))).toHaveLength(1);
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('committed-operation restart does not read or rewind a later native turn', async () => {
        const f = fixture(); await f.rewind.execute(operation);
        f.setRows([...rows.slice(0, 2), { id: 'later', type: 'user', text: 'new turn' }]);
        f.request.mockClear();
        f.ownership.workerGone = true;
        expect(await f.restart().recover({ ...operation, phase: 'committed' })).toMatchObject({ success: true });
        expect(f.request).not.toHaveBeenCalled();
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('binds a recovery-issued commit cohort to the replacement native process, not the dead original server', async () => {
        const f = fixture(); const transport = f.request.getMockImplementation()!;
        f.request.mockImplementation(async (path, init) => {
            const response = await transport(path, init);
            if (path.endsWith('/revert/stage') || path.endsWith('/revert/commit')) throw new Error('native ACK lost');
            return response;
        });
        expect(await f.rewind.execute(operation)).toMatchObject({ outcome: 'unknown' });
        f.ownership.workerGone = true;
        const replacement = f.restart({ nativeProcess: { pid: 202, startMarker: 'replacement-native-generation' },
            requestsFromPreviousWorkerCannotRun: () => f.rewind.readIntent()?.nativeProcess?.pid === 101 });
        expect(await replacement.recover(operation)).toMatchObject({ outcome: 'unknown' });
        expect(await replacement.recover(operation)).toMatchObject({ outcome: 'unknown' });
        expect(f.request.mock.calls.filter(([path]) => path.endsWith('/revert/commit'))).toHaveLength(1);
        expect(f.rewind.readIntent()?.nativeProcess?.pid).toBe(202);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('does not consume a committed operation while the previous worker may still dispatch', async () => {
        const f = fixture(); await f.rewind.execute(operation);
        f.consumeCommitted.mockClear(); f.request.mockClear();
        expect(await f.restart().recover({ ...operation, phase: 'committed' })).toMatchObject({ outcome: 'unknown' });
        expect(f.consumeCommitted).not.toHaveBeenCalled();
        expect(f.request).not.toHaveBeenCalled();
        expect(f.gate.isBlocked()).toBe(true);
    });

    it.each(['execute', 'recover'] as const)('keeps newer reservation gated after committed consumption (%s)', async path => {
        const f = fixture();
        if (path === 'recover') {
            f.consumeCommitted.mockRejectedValueOnce(new Error('first consumption interrupted'));
            expect(await f.rewind.execute(operation)).toMatchObject({ outcome: 'unknown' });
            f.setAuthoritative({ ...operation, phase: 'committed' });
        }
        let release!: () => void;
        f.consumeCommitted.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = path === 'execute' ? f.rewind.execute(operation) : f.rewind.recover({ ...operation, phase: 'committed' });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const newer = { ...operation, operationId: 'pending-after-consumption', reservationVersion: 3 };
        f.setAuthoritative(newer); release();
        await expect(pending).rejects.toMatchObject({ operationId: newer.operationId });
        expect(f.gate.isBlocked()).toBe(true);
        expect(() => f.gate.enterRuntime()).toThrow('pending reconciliation');
        expect(f.rewind.readIntent()).toMatchObject({ operation: { operationId: operation.operationId }, phase: 'finalized' });
        expect(await f.rewind.recover(newer)).toMatchObject({ outcome: 'rejected' });
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('latches a different reservation after applied-report acknowledgement loss without rewriting the journal', async () => {
        const f = fixture(); const report = f.report.getMockImplementation()!;
        const newer = { ...operation, operationId: 'after-applied-ack-loss', reservationVersion: 3 };
        f.report.mockImplementation(async value => {
            if (value.phase === 'applied') { f.setAuthoritative(newer); throw new Error('applied ACK lost'); }
            return report(value);
        });
        await expect(f.rewind.execute(operation)).rejects.toMatchObject({ operationId: newer.operationId });
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.rewind.readIntent()).toMatchObject({ operation: { operationId: operation.operationId }, phase: 'applied' });
        expect(f.reports.map(item => item.phase)).toEqual(['prepared']);
    });

    it.each(['consumption', 'applied-ack'] as const)('latches O2 appearing during a failed post-commit unknown report (%s)', async failure => {
        const f = fixture(); const actualReport = f.report.getMockImplementation()!;
        let rejectUnknown!: (error: Error) => void;
        f.report.mockImplementation(async value => {
            if (value.phase === 'unknown') return await new Promise((_resolve, reject) => { rejectUnknown = reject; });
            const result = await actualReport(value);
            if (failure === 'applied-ack' && value.phase === 'applied') throw new Error('applied ACK lost');
            return result;
        });
        if (failure === 'consumption') f.consumeCommitted.mockRejectedValueOnce(new Error('consumption failed'));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(rejectUnknown).toBeTypeOf('function'));
        const newer = { ...operation, operationId: `during-unknown-${failure}`, reservationVersion: 3 };
        const journal = f.rewind.readIntent()!; const path = join(dirname(journal.backupPath), 'intent.json');
        const newerBytes = JSON.stringify({ ...journal, operation: newer });
        writeFileSync(path, newerBytes); f.setAuthoritative(newer); rejectUnknown(new Error('operation mismatch'));
        await expect(pending).rejects.toMatchObject({ operationId: newer.operationId });
        expect(readFileSync(path, 'utf8')).toBe(newerBytes);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it.each([false, true])('does not retry a failed post-commit unknown report when authority is unchanged or unavailable (offline=%s)', async offline => {
        const f = fixture(); const actualReport = f.report.getMockImplementation()!; let failRefresh = false; let attempts = 0;
        f.consumeCommitted.mockRejectedValueOnce(new Error('consumption failed'));
        f.report.mockImplementation(async value => {
            if (value.phase === 'unknown') { attempts++; failRefresh = offline; throw new Error('report failed'); }
            return actualReport(value);
        });
        const controller = f.restart({ workerId: 'worker', getAuthoritativeOperation: async () => {
            if (failRefresh) throw new Error('metadata offline'); return f.getAuthoritative();
        } });
        expect(await controller.execute(operation)).toMatchObject({ outcome: 'unknown' });
        expect(attempts).toBe(1);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it.each(['consumption', 'applied-ack'] as const)('latches O2 appearing during an accepted post-commit unknown report (%s)', async failure => {
        const f = fixture(); const actualReport = f.report.getMockImplementation()!;
        let acceptUnknown!: () => void;
        f.report.mockImplementation(async value => {
            if (value.phase === 'unknown') return await new Promise(resolve => { acceptUnknown = () => resolve({ ...operation, phase: 'committed' }); });
            const result = await actualReport(value);
            if (failure === 'applied-ack' && value.phase === 'applied') throw new Error('applied ACK lost');
            return result;
        });
        if (failure === 'consumption') f.consumeCommitted.mockRejectedValueOnce(new Error('consumption failed'));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(acceptUnknown).toBeTypeOf('function'));
        const newer = { ...operation, operationId: `during-accepted-unknown-${failure}`, reservationVersion: 3 };
        const journal = f.rewind.readIntent()!; const path = join(dirname(journal.backupPath), 'intent.json');
        const newerBytes = JSON.stringify({ ...journal, operation: newer });
        writeFileSync(path, newerBytes); f.setAuthoritative(newer); acceptUnknown();
        await expect(pending).rejects.toMatchObject({ operationId: newer.operationId });
        expect(readFileSync(path, 'utf8')).toBe(newerBytes);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it.each([false, true])('does not retry an accepted post-commit unknown report when authority is unchanged or unavailable (offline=%s)', async offline => {
        const f = fixture(); const actualReport = f.report.getMockImplementation()!; let failRefresh = false; let attempts = 0;
        f.consumeCommitted.mockRejectedValueOnce(new Error('consumption failed'));
        f.report.mockImplementation(async value => {
            if (value.phase === 'unknown') { attempts++; failRefresh = offline; return { ...operation, phase: 'committed' }; }
            return actualReport(value);
        });
        const controller = f.restart({ workerId: 'worker', getAuthoritativeOperation: async () => {
            if (failRefresh) throw new Error('metadata offline'); return f.getAuthoritative();
        } });
        expect(await controller.execute(operation)).toMatchObject({ outcome: 'unknown' });
        expect(attempts).toBe(1);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('guards an unconfirmed applied-report response against a newer reservation', async () => {
        const f = fixture(); const report = f.report.getMockImplementation()!;
        const newer = { ...operation, operationId: 'after-unconfirmed-applied', reservationVersion: 3 };
        f.report.mockImplementation(async value => {
            if (value.phase === 'applied') { f.setAuthoritative(newer); return { ...operation, phase: 'unknown' }; }
            return report(value);
        });
        await expect(f.rewind.execute(operation)).rejects.toMatchObject({ operationId: newer.operationId });
        expect(f.rewind.readIntent()).toMatchObject({ operation: { operationId: operation.operationId }, phase: 'applied' });
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.reports.map(item => item.phase)).toEqual(['prepared']);
    });

    it('retains applied intent if metadata is unavailable after applied-report acknowledgement loss', async () => {
        const f = fixture(); let offline = false;
        const report = f.report.getMockImplementation()!;
        f.report.mockImplementation(async value => {
            if (value.phase === 'applied') { offline = true; throw new Error('applied ACK lost'); }
            return report(value);
        });
        const controller = f.restart({ workerId: 'worker', getAuthoritativeOperation: async () => {
            if (offline) throw new Error('offline'); return f.getAuthoritative();
        } });
        await expect(controller.execute(operation)).rejects.toThrow();
        expect(controller.readIntent()?.phase).toBe('applied');
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.reports.map(item => item.phase)).toEqual(['prepared']);
    });

    it('does not overwrite a newer journal after applied-report acknowledgement loss', async () => {
        const f = fixture(); const report = f.report.getMockImplementation()!;
        let rejectApplied!: (error: Error) => void;
        f.report.mockImplementation(async value => {
            if (value.phase === 'applied') return await new Promise((_resolve, reject) => { rejectApplied = reject; });
            return report(value);
        });
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(rejectApplied).toBeTypeOf('function'));
        const old = f.rewind.readIntent()!; const newer = { ...operation, operationId: 'newer-after-applied', reservationVersion: 3 };
        const path = join(dirname(old.backupPath), 'intent.json'); const newerBytes = JSON.stringify({ ...old, operation: newer });
        writeFileSync(path, newerBytes); f.setAuthoritative(newer); rejectApplied(new Error('applied ACK lost'));
        await expect(pending).rejects.toMatchObject({ operationId: newer.operationId });
        expect(readFileSync(path, 'utf8')).toBe(newerBytes);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('keeps the gate blocked when committed consumption rejects with a falsy value', async () => {
        const f = fixture(); f.consumeCommitted.mockImplementationOnce(async () => { throw undefined; });
        expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'unknown' });
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.rewind.readIntent()?.phase).toBe('unknown');
    });

    it('preserves the committed journal and gate if authority refresh fails after consumption', async () => {
        const f = fixture(); let failRefresh = false; let release!: () => void;
        const controller = f.restart({ workerId: 'worker', getAuthoritativeOperation: async () => {
            if (failRefresh) throw new Error('offline after consumption'); return f.getAuthoritative();
        } });
        f.consumeCommitted.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = controller.execute(operation);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const journal = controller.readIntent()!; const path = join(dirname(journal.backupPath), 'intent.json');
        const before = readFileSync(path, 'utf8'); failRefresh = true; release();
        await expect(pending).rejects.toThrow();
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.reports.map(item => item.phase)).toEqual(['prepared', 'applied']);
    });

    it('preserves the old journal when consumption fails after a newer reservation', async () => {
        const f = fixture(); let rejectConsumption!: (error: Error) => void;
        f.consumeCommitted.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectConsumption = reject; }));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(rejectConsumption).toBeTypeOf('function'));
        const journal = f.rewind.readIntent()!; const path = join(dirname(journal.backupPath), 'intent.json');
        const before = readFileSync(path, 'utf8');
        const newer = { ...operation, operationId: 'newer-after-failed-consumption', reservationVersion: 3 };
        f.setAuthoritative(newer); rejectConsumption(new Error('load failed'));
        await expect(pending).rejects.toMatchObject({ operationId: newer.operationId });
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('does not overwrite a newer journal after committed consumption', async () => {
        const f = fixture(); let release!: () => void;
        f.consumeCommitted.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const old = f.rewind.readIntent()!;
        const newer = { ...operation, operationId: 'newer-journal', reservationVersion: 3 };
        const path = join(dirname(old.backupPath), 'intent.json');
        const newerBytes = JSON.stringify({ ...old, operation: newer });
        writeFileSync(path, newerBytes); f.setAuthoritative(newer); release();
        await expect(pending).rejects.toThrow();
        expect(readFileSync(path, 'utf8')).toBe(newerBytes);
        expect(f.gate.isBlocked()).toBe(true);
    });

    it('does not release input before postcommit native consumption has completed', async () => {
        const f = fixture(); let release!: () => void;
        f.consumeCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = f.rewind.execute(operation);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(f.gate.isBlocked()).toBe(true);
        release(); await pending;
        expect(f.gate.isBlocked()).toBe(false);
    });

    it('dequeue admission is synchronous before ACK, including an internal item without a localId', async () => {
        const f = fixture(); const queue = new MessageQueue2<import('./types').OpencodeMode>(() => 'mode');
        const session = new OpencodeSession({ api: {} as never,
            client: { keepAlive: vi.fn(), emitMessagesConsumed: vi.fn() } as never,
            path: '/fixture', logPath: '/fixture/log', sessionId: 'native', messageQueue: queue,
            onModeChange: () => {}, startedBy: 'runner', startingMode: 'remote', runtimeGate: f.gate });
        cleanups.push(() => session.stopKeepAlive());
        queue.push('internal message', { permissionMode: 'default' });
        const batch = queue.waitForMessagesAndGetAsString();
        await expect(f.rewind.execute(operation)).rejects.toThrow('busy');
        expect((await batch)?.message).toBe('internal message');
        expect(f.request).not.toHaveBeenCalled(); session.takeDequeuedRuntimeRelease()!();
    });

    it('blocks corrupted projected backup recovery rather than advertising recoverability', async () => {
        const f = fixture(); await f.rewind.execute(operation);
        writeFileSync(f.rewind.readIntent()!.backupPath, '{}');
        await expect(f.restart().recover({ ...operation, phase: 'committed' })).rejects.toThrow();
        expect(f.gate.isBlocked()).toBe(true);
    });
});
