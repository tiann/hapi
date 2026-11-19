import { EventEmitter } from 'node:events';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { startFileWatcher } from './startFileWatcher';

vi.mock('node:fs', async (load) => ({ ...await load<typeof import('node:fs')>(), statSync: vi.fn(), watch: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

beforeEach(() => {
    vi.mocked(statSync).mockReturnValue({ dev: 1n, ino: 2n } as ReturnType<typeof statSync>);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('backs off to 30 s, recovers on attach, and cancels a queued retry on stop', () => {
    vi.useFakeTimers();
    const fsWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    const open = vi.mocked(watch).mockImplementation(() => { throw Error('ENOENT'); });
    const health = vi.fn();
    const stop = startFileWatcher('transcript', vi.fn(), health);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const calls = open.mock.calls.length;
        vi.advanceTimersByTime(delay - 1);
        expect(open).toHaveBeenCalledTimes(calls);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(calls + 1);
    }
    open.mockReturnValue(fsWatcher as unknown as FSWatcher);
    vi.advanceTimersByTime(30000);
    expect(health).toHaveBeenLastCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
    fsWatcher.emit('error', Error('lost watcher'));
    expect(health).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['rename', 'inode', 'stable', 'change'])('restarts on %s and ignores callbacks from the old watcher', (mode) => {
    vi.useFakeTimers();
    const fake = () => Object.assign(new EventEmitter(), { close: vi.fn() });
    const first = fake();
    const second = fake();
    const open = vi.mocked(watch)
        .mockImplementationOnce(() => { throw Error('ENOENT'); })
        .mockReturnValueOnce(first as unknown as FSWatcher)
        .mockReturnValue(second as unknown as FSWatcher);
    const changed = vi.fn();
    const health = vi.fn();
    const stop = startFileWatcher('wire', changed, health);
    vi.advanceTimersByTime(1000);
    const callback = open.mock.calls.at(-1)![1] as (event: string) => void;
    if (mode === 'stable') vi.advanceTimersByTime(30000);
    if (mode === 'change') callback('change');
    if (mode === 'inode') {
        vi.mocked(statSync).mockReturnValue({ dev: 1n, ino: 9n } as ReturnType<typeof statSync>);
        stop.verifyIdentity();
    } else if (mode === 'rename') callback('rename');
    else first.emit('error', Error('watch lost'));
    expect(health).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(mode === 'inode' ? 2000 : 1000);
    expect(health.mock.calls.map(([value]) => value)).toEqual([false, true, false, true]);
    changed.mockClear();
    callback('rename');
    first.emit('close');
    expect(changed).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    stop();
});

it('reattaches after rename-over even when the old inode is held and the watcher stays silent', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { tmpdir } = await import('node:os');
    vi.useFakeTimers();
    vi.mocked(statSync).mockImplementation(fs.statSync);
    const dir = fs.mkdtempSync(tmpdir() + '/hapi-watch-');
    const path = dir + '/wire';
    fs.writeFileSync(path, 'old');
    const fd = fs.openSync(path, 'r');
    const current = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(watch).mockImplementation(() => current as unknown as FSWatcher);
    const health = vi.fn();
    const stop = startFileWatcher(path, vi.fn(), health);
    try {
        fs.writeFileSync(dir + '/new', 'replacement');
        fs.renameSync(dir + '/new', path);
        stop.verifyIdentity();
        expect(current.close).toHaveBeenCalledOnce();
        expect(health).toHaveBeenLastCalledWith(false);
        vi.advanceTimersByTime(1000);
        expect(health).toHaveBeenLastCalledWith(true);
    } finally {
        stop();
        fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
