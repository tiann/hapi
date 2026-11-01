import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeStorageScanner, type OpencodeStorageScannerHandle } from './opencodeStorageScanner';
import { OpencodeCompactionProjector } from './opencodeCompactionProjector';

const database = vi.hoisted(() => ({ enabled: false, messages: [] as Record<string, unknown>[], parts: [] as Record<string, unknown>[] }));
const reads = vi.hoisted(() => new Map<string, { wait: Promise<void>; entered: () => void }>());
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
        const gate = reads.get(String(args[0]));
        if (gate) { const snapshot = await actual.readFile(...args); gate.entered(); await gate.wait; return snapshot; }
        return actual.readFile(...args);
    } };
});
vi.mock('bun:sqlite', () => ({ Database: class {
    constructor() { if (!database.enabled) throw new Error('File fixture'); }
    prepare(query: string) { return { all: () => query.includes('FROM message') ? database.messages : database.parts, get: () => ({ exists: 1 }) }; }
    close() {}
} }));
beforeEach(() => { reads.clear(); database.enabled = false; database.messages = []; database.parts = []; });
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-compaction-scan-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const write = async (path: string, data: unknown) => { const file = join(dir, path); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data)); return file; };
    const onSummary = vi.fn(); const onText = vi.fn();
    const projector = new OpencodeCompactionProjector({ sessionId: 'ses', onSummary, onText });
    const start = async (startupTimestampMs = 0): Promise<OpencodeStorageScannerHandle> => {
        const scanner = await createOpencodeStorageScanner({ sessionId: 'ses', cwd: dir, storageDir: dir, intervalMs: 20, startupTimestampMs,
            onEvent: event => {
                const payload = event.payload as { info?: Record<string, unknown>; part?: Record<string, unknown> };
                if (payload.info) projector.message(payload.info);
                if (payload.part) projector.part(payload.part);
                if (event.event === 'transcript.scan.completed') projector.flush();
            }
        });
        cleanup.push(() => scanner.cleanup());return scanner;
    };
    const marker = { id: 'marker', sessionID: 'ses', role: 'user', time: { created: 1 } };
    const summary = { id: 'summary', sessionID: 'ses', role: 'assistant', parentID: 'marker', summary: true, finish: 'stop', time: { created: 1 } };
    await write('message/ses/marker.json', marker);
    await write('message/ses/summary.json', summary);
    await write('part/marker/marker-part.json', { id: 'marker-part', sessionID: 'ses', messageID: 'marker', type: 'compaction', auto: true });
    const part = (id: string, text: string) => ({ id, sessionID: 'ses', messageID: 'summary', type: 'text', text, time: { end: 1 } });
    return { dir, write, start, part, onSummary, onText };
}
describe('OpenCode compaction storage scans', () => {
    it('does not settle a partial scan and retries a repaired part at the same mtime', async () => {
        const f = await fixture();
        await f.write('part/summary/one.json', f.part('one', 'First'));
        const file = await f.write('part/summary/two.json', '{incomplete');
        const fixedTime = new Date(10000);await utimes(file, fixedTime, fixedTime);
        await f.start();expect(f.onSummary).not.toHaveBeenCalled();
        await f.write('part/summary/two.json', f.part('two', 'Second'));await utimes(file, fixedTime, fixedTime);
        await vi.waitFor(() => expect(f.onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'First\n\nSecond', 'auto'));
    });
    it('keeps old structural markers for a compaction finishing after attachment without replaying old output', async () => {
        const f = await fixture();
        await f.write('part/summary/one.json', f.part('one', 'Old partial'));
        await f.write('message/ses/old-user.json', { id: 'old-user', sessionID: 'ses', role: 'user', time: { created: 1 } });
        await f.write('part/old-user/text.json', { id: 'old-text', sessionID: 'ses', messageID: 'old-user', type: 'text', text: 'Old user input' });
        await f.start(Date.now());expect(f.onSummary).not.toHaveBeenCalled();expect(f.onText).not.toHaveBeenCalled();
        await f.write('part/summary/one.json', f.part('one', 'Finished after attachment'));
        await vi.waitFor(() => expect(f.onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'Finished after attachment', 'auto'));
        expect(f.onText).not.toHaveBeenCalled();
    });
    it('does not advance a failed SQLite part version or finalize a truncated checkpoint', async () => {
        const f = await fixture();database.enabled = true;
        const row = (id: string, data: unknown) => ({ id, session_id: 'ses', time_created: 1, time_updated: 10, data: JSON.stringify(data) });
        database.messages = [row('marker', { role: 'user' }), row('summary', { role: 'assistant', parentID: 'marker', summary: true, finish: 'stop' })];
        database.parts = [
            { ...row('marker-part', { type: 'compaction', auto: true }), message_id: 'marker' },
            { ...row('one', f.part('one', 'First')), message_id: 'summary' },
            { ...row('two', {}), message_id: 'summary', data: '{broken' }
        ];
        await f.start();expect(f.onSummary).not.toHaveBeenCalled();
        database.parts[2].data = JSON.stringify(f.part('two', 'Second'));
        await vi.waitFor(() => expect(f.onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'First\n\nSecond', 'auto'));
    });

    it('does not attribute an old scan completion to a new session while its multipart prime is pending', async () => {
        const f = await fixture();await f.write('part/summary/one.json', f.part('one', 'A'));
        await f.write('message/other/b-marker.json', { id: 'b-marker', sessionID: 'other', role: 'user', time: { created: 1 } });
        await f.write('message/other/b-summary.json', { id: 'b-summary', sessionID: 'other', role: 'assistant', summary: true, parentID: 'b-marker', finish: 'stop', time: { created: 1 } });
        await f.write('part/b-marker/marker.json', { id: 'b-marker-part', sessionID: 'other', messageID: 'b-marker', type: 'compaction', auto: true });
        await f.write('part/b-summary/one.json', { ...f.part('b-one', 'First'), sessionID: 'other', messageID: 'b-summary' });
        const bFile = await f.write('part/b-summary/two.json', { ...f.part('b-two', 'Second'), sessionID: 'other', messageID: 'b-summary' });
        const onSummary = vi.fn();const projector = new OpencodeCompactionProjector({ sessionId: 'other', onSummary });
        const scanner = await createOpencodeStorageScanner({ sessionId: 'ses', cwd: f.dir, storageDir: f.dir, startupTimestampMs: 0, intervalMs: 20, onEvent: event => {
            const p = event.payload as { info?: Record<string, unknown>; part?: Record<string, unknown> };
            if (p.info) projector.message(p.info);if (p.part) projector.part(p.part);
            if (event.event === 'transcript.scan.completed' && event.sessionId === 'other') projector.flush();
        } });cleanup.push(() => scanner.cleanup());
        const gate = (path: string) => {
            let release!: () => void;let entered!: () => void;
            const started = new Promise<void>(resolve => { entered = resolve; });
            const wait = new Promise<void>(resolve => { release = resolve; });
            reads.set(path, { wait, entered });return { started, release };
        };
        const aGate = gate(join(f.dir, 'part/summary/one.json'));const bGate = gate(bFile);
        try {
            await f.write('part/summary/one.json', f.part('one', 'Updated A'));
            await aGate.started;
            scanner.onNewSession('other');await bGate.started;
            aGate.release();await new Promise(resolve => setTimeout(resolve, 30));
            expect(onSummary).not.toHaveBeenCalled();
            bGate.release();await vi.waitFor(() => expect(onSummary).toHaveBeenCalledExactlyOnceWith('b-marker', 'First\n\nSecond', 'auto'));
        } finally { aGate.release();bGate.release(); }
    });

    it('rejects a stale file read after an A to B to A generation change', async () => {
        const f = await fixture();const file = await f.write('part/summary/one.json', f.part('one', 'Initial'));
        await f.write('message/other/other.json', { id: 'other', sessionID: 'other', role: 'user', time: { created: 1 } });
        const events: string[] = [];const found = vi.fn();
        const scanner = await createOpencodeStorageScanner({ sessionId: 'ses', cwd: f.dir, storageDir: f.dir, startupTimestampMs: 0, intervalMs: 20, onSessionFound: found, onEvent: event => {
            const p = event.payload as { part?: { text?: string } };if (p.part?.text) events.push(p.part.text);
        } });cleanup.push(() => scanner.cleanup());events.length = 0;
        let release!: () => void;const wait = new Promise<void>(resolve => { release = resolve; });const entered = vi.fn();reads.set(file, { wait, entered });
        try {
            await f.write('part/summary/one.json', f.part('one', 'Stale A'));
            await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
            scanner.onNewSession('other');await vi.waitFor(() => expect(found).toHaveBeenCalledWith('other'));
            await f.write('part/summary/one.json', f.part('one', 'Current A'));
            scanner.onNewSession('ses');await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
            release();await vi.waitFor(() => expect(events).toContain('Current A'));
            expect(events).not.toContain('Stale A');
        } finally { release(); }
    });

});
