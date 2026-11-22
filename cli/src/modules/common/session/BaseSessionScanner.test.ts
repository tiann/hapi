import { afterEach, expect, it, vi } from 'vitest';
import { BaseSessionScanner, type SessionFileScanStats } from './BaseSessionScanner';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';

vi.mock('@/modules/watcher/startFileWatcher', () => ({ startFileWatcher: vi.fn() }));

class Scanner extends BaseSessionScanner<string> {
    constructor() { super({ intervalMs: 2000 }); }
    shouldWatchFile(path: string) { return path === 'a' || path === 'b'; }
    findSessionFiles = vi.fn(async () => ['a', 'b']);
    async parseSessionFile() { return { events: [], nextCursor: 0 }; }
    generateEventKey(event: string) { return event; }
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('polls at 30 s only while all file watchers are healthy, with immediate recovery scans', async () => {
    vi.useFakeTimers();
    const verifyIdentity = vi.fn();
    const health = new Map<string, (healthy: boolean) => void>();
    vi.mocked(startFileWatcher).mockImplementation((file, _, report) => {
        health.set(file, report!);
        report!(true);
        return Object.assign(() => {}, { verifyIdentity });
    });
    const scanner = new Scanner();
    await scanner.start();
    scanner.findSessionFiles.mockClear();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(scanner.findSessionFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(scanner.findSessionFiles).toHaveBeenCalledTimes(1);
    expect(verifyIdentity).toHaveBeenCalledTimes(2);
    health.get('b')!(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(scanner.findSessionFiles).toHaveBeenCalledTimes(2);
    health.get('b')!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(scanner.findSessionFiles).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(scanner.findSessionFiles).toHaveBeenCalledTimes(3);
    await scanner.cleanup();
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['discovery', 'empty', 'pruned'])('keeps the discovery cadence for %s targets', async (mode) => {
    vi.useFakeTimers();
    vi.mocked(startFileWatcher).mockImplementation((_file, _, health) => {
        health!(true);
        return Object.assign(() => {}, { verifyIdentity: vi.fn() });
    });
    const scanner = new Scanner();
    if (mode === 'discovery') Object.defineProperty(scanner, 'shouldWatchFile', { value: undefined });
    await scanner.start();
    if (mode !== 'discovery') {
        scanner.findSessionFiles.mockResolvedValue([]);
        if (mode === 'pruned') scanner['pruneWatchers']([]);
        else await scanner.flush();
    }
    scanner.findSessionFiles.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(scanner.findSessionFiles).toHaveBeenCalledOnce();
    await scanner.cleanup();
});

it.each(['timer', 'cleanup', 'overlapping cleanup'])('delivers a silent final append on %s after watcher activity', async (mode) => {
    vi.useFakeTimers();
    vi.mocked(startFileWatcher).mockImplementation((_path, _changed, health) => {
        health!(true);
        return Object.assign(() => {}, { verifyIdentity: vi.fn() });
    });
    let finishRead!: () => void;
    const readBarrier = new Promise<void>(resolve => { finishRead = resolve; });
    const readCursors: number[] = [];
    const transcript: string[] = [];
    const delivered: string[] = [];
    class TranscriptScanner extends BaseSessionScanner<string> {
        constructor() { super({ intervalMs: 2000 }); }
        shouldWatchFile() { return true; }
        async findSessionFiles() { return ['wire']; }
        async parseSessionFile(_path: string, cursor: number) {
            readCursors.push(cursor);
            const result = { events: transcript.slice(cursor).map(event => ({ event })), nextCursor: transcript.length };
            if (mode === 'overlapping cleanup' && result.events.length && cursor === 0) await readBarrier;
            return result;
        }
        generateEventKey(event: string) { return event; }
        async handleFileScan({ events }: SessionFileScanStats<string>) { delivered.push(...events); }
    }
    const scanner = new TranscriptScanner();
    await scanner.start();
    const [, changed] = vi.mocked(startFileWatcher).mock.calls[0]!;
    transcript.push('first');
    changed('wire');
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'overlapping cleanup') {
        transcript.push('tail');
        const draining = scanner.cleanup();
        changed('wire');
        const secondCleanup = scanner.cleanup();
        finishRead();
        await Promise.all([draining, secondCleanup]);
        await scanner.cleanup();
        expect(readCursors).toEqual([0, 0, 1]);
        expect(delivered).toEqual(['first', 'tail']);
        expect(vi.getTimerCount()).toBe(0);
        return;
    }
    expect(delivered).toEqual(['first']);
    transcript.push('tail');
    await vi.advanceTimersByTimeAsync(1999);
    expect(delivered).toEqual(['first']);
    if (mode === 'timer') await vi.advanceTimersByTimeAsync(1);
    else await scanner.cleanup();
    expect(delivered).toEqual(['first', 'tail']);
    await scanner.cleanup();
    expect(vi.getTimerCount()).toBe(0);
});
