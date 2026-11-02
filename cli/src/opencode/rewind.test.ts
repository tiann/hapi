import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { OpencodeSession } from './session';
import { OpenCodeRewind, OpenCodeRuntimeGate } from './rewind';
import type { OpenCodeRewindReport } from '@hapi/protocol/apiTypes';
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas';

const rows = [
    { id: 'u1', type: 'user', text: 'one' },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { id: 'u2', type: 'user', text: 'two' },
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'second answer' }] }
];
const operation = { operationId: 'operation', nativeSessionId: 'native', workerId: 'worker', requestedLocalId: 'local2',
    nativeMessageId: 'u2', cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 4, reservationVersion: 2, sourceTranscriptHash: 'c'.repeat(64), phase: 'reserved' as const };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const f of cleanups.splice(0)) f(); });

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-rewind-'));
    let current = structuredClone(rows);
    let staged: string | undefined;
    const ownership = { nativeGone: false, workerGone: false };
    const gate = new OpenCodeRuntimeGate();
    const reports: OpenCodeRewindReport[] = [];
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
        return { ...operation, phase: value.phase === 'applied' ? 'committed' : value.phase };
    });
    const consumeCommitted = vi.fn(async () => {});
    const options = { directory, hapiSessionId: 'hapi', workerId: 'worker', gate,
        baseUrl: 'http://native', nativeSessionId: 'native', headers: {}, request,
        report, flush: async () => true, isIdle: () => true,
        sourceCheckpoint: () => ({ sessionId: 'native', messageIds: rows.map(r => r.id), userMessageIds: ['u1', 'u2'], localMessageIds: [] }),
        sourceIndexes: () => ({ local1: 0, local2: 1 }), requestsFromPreviousWorkerCannotRun: () => ownership.nativeGone,
        previousWorkerCannotRun: () => ownership.workerGone, consumeCommitted,
        nativeProcess: { pid: 101, startMarker: 'original-native-generation' } };
    const rewind = new OpenCodeRewind(options);
    return { rewind, gate, directory, reports, report, request, ownership, consumeCommitted,
        restart: (overrides: Partial<typeof options> = {}) => new OpenCodeRewind({ ...options, workerId: 'replacement', ...overrides }),
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
        expect(await f.rewind.execute(operation)).toMatchObject({ success: false, outcome: 'rejected' });
        expect(f.request).not.toHaveBeenCalled();
        expect(readFileSync(path, 'utf8')).toBe(backup);
    });

    it('keeps a durable reservation without a matching intent blocked before all native requests', async () => {
        const f = fixture();
        await expect(f.rewind.recover(operation)).rejects.toThrow('no matching local intent');
        expect(f.gate.isBlocked()).toBe(true);
        expect(f.request).not.toHaveBeenCalled();
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
