// Regression tests: a committed rewind with a missing or finalized
// local journal is terminal — admission is released without re-running
// consumption.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeRewind, OpenCodeRuntimeGate } from './rewind';
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas';
import { getProcessStartMarker } from '@/utils/process';

const rows = [
    { id: 'u1', type: 'user', content: [{ type: 'text', text: 'one' }] },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { id: 'u2', type: 'user', content: [{ type: 'text', text: 'two' }] },
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'second answer' }] }
];

const operation: OpenCodeRewindOperation = { operationId: 'operation', nativeSessionId: 'native', workerId: 'worker',
    requestedLocalId: 'local2', nativeMessageId: 'u2', cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 4,
    reservationVersion: 2, sourceTranscriptHash: 'c'.repeat(64), workerPid: process.pid,
    workerStartMarker: getProcessStartMarker(process.pid)!, phase: 'committed' as const };

async function fixtureWithIntent(directory: string, mintFinalizedJournal: boolean) {
    const gate = new OpenCodeRuntimeGate();
    const consumeCommitted = vi.fn(async () => {});
    const rewind = new OpenCodeRewind({
        directory, hapiSessionId: 'hapi', workerId: 'worker', gate,
        baseUrl: 'http://native', nativeSessionId: 'native', headers: {},
        request: vi.fn(async () => Response.json({ data: {} })),
        report: vi.fn(async (value: { operation: OpenCodeRewindOperation; phase: string }) => value.operation),
        getAuthoritativeOperation: async () => operation,
        flush: async () => true, isIdle: () => true,
        sourceCheckpoint: () => ({ sessionId: 'native', messageIds: rows.map(r => r.id), userMessageIds: ['u1', 'u2'], localMessageIds: [] }),
        sourceIndexes: () => ({ local1: 0, local2: 1 }),
        requestsFromPreviousWorkerCannotRun: () => false,
        consumeCommitted,
        nativeProcess: { pid: process.pid, startMarker: getProcessStartMarker(process.pid)! }
    });
    if (mintFinalizedJournal) {
        // Reuse a real controller run to mint a schema-valid finalized journal:
        // execute() drives the full prepare/stage/commit flow against the
        // stubbed native server and leaves intent.json + backup on disk.
        let current = structuredClone(rows);
        let staged: string | undefined;
        let authoritative: OpenCodeRewindOperation = { ...operation, phase: 'reserved' as const };
        const seed = new OpenCodeRewind({
            directory, hapiSessionId: 'hapi', workerId: 'worker', gate: new OpenCodeRuntimeGate(),
            baseUrl: 'http://native', nativeSessionId: 'native', headers: {},
            request: vi.fn(async (path: string, init?: RequestInit) => {
                if (path.endsWith('/revert/stage')) { staged = JSON.parse(init!.body as string).messageID; return Response.json({}); }
                if (path.endsWith('/revert/commit')) { current = current.slice(0, 2); staged = undefined; return new Response(null, { status: 204 }); }
                if (path.includes('/message?')) return Response.json({ data: current, cursor: {} });
                if (path.endsWith('/active')) return Response.json({ data: {} });
                if (path.endsWith('/inbox')) return Response.json({ data: [] });
                return Response.json({ data: { id: 'native', ...(staged ? { revert: { messageID: staged } } : {}) } });
            }),
            report: vi.fn(async (value: { operation: OpenCodeRewindOperation; phase: string }) => {
                authoritative = { ...value.operation, phase: value.phase === 'applied' ? 'committed' : value.phase } as OpenCodeRewindOperation;
                return authoritative;
            }),
            getAuthoritativeOperation: async () => authoritative,
            flush: async () => true, isIdle: () => true,
            sourceCheckpoint: () => ({ sessionId: 'native', messageIds: rows.map(r => r.id), userMessageIds: ['u1', 'u2'], localMessageIds: [] }),
            sourceIndexes: () => ({ local1: 0, local2: 1 }),
            requestsFromPreviousWorkerCannotRun: () => false,
            consumeCommitted: async () => {},
            nativeProcess: { pid: process.pid, startMarker: getProcessStartMarker(process.pid)! }
        });
        expect(await seed.execute({ ...operation, phase: 'reserved' })).toMatchObject({ success: true });
    }
    return { rewind, gate, consumeCommitted };
}

describe('committed tombstone recovery', () => {
    it('treats a committed operation with no local intent as already consumed and releases admission', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'opencode-rewind-'));
        const { rewind, gate, consumeCommitted } = await fixtureWithIntent(directory, false);
        gate.block();
        const result = await rewind.recover(operation);
        expect(result).toMatchObject({ success: true });
        expect(consumeCommitted).not.toHaveBeenCalled();
        expect(gate.isBlocked()).toBe(false);
    });

    it('does not re-consume a committed operation whose local intent is already finalized', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'opencode-rewind-'));
        const { rewind, gate, consumeCommitted } = await fixtureWithIntent(directory, true);
        expect(rewind.readIntent()?.phase).toBe('finalized');
        gate.block();
        const result = await rewind.recover(operation);
        expect(result).toMatchObject({ success: true });
        expect(consumeCommitted).not.toHaveBeenCalled();
        expect(rewind.readIntent()?.phase).toBe('finalized');
        expect(gate.isBlocked()).toBe(false);
    });
});