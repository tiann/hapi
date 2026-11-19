import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
import { canEnumerateProcChildren, captureServeProcesses, createServeFence, waitForServeExit } from './oldTreeFence';

it.skipIf(process.platform !== 'linux')('enables recovery only when proc exposes readable child lists', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce('');
    try {
        expect(canEnumerateProcChildren()).toBe(true);
        for (const code of ['ENOENT', 'EACCES']) {
            read.mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
            expect(canEnumerateProcChildren()).toBe(false);
        }
        expect(read).toHaveBeenCalledWith(`/proc/self/task/${process.pid}/children`, 'utf8');
    } finally {
        read.mockRestore();
    }
});

it('refuses an unsupported platform or an incomplete capture', async () => {
    expect(captureServeProcesses(process.pid, 'win32')).toBeNull();
    expect(captureServeProcesses(process.pid, 'darwin')).toBeNull();
    await expect(waitForServeExit(null)).resolves.toBe(false);
    await expect(waitForServeExit([])).resolves.toBe(false);
});

it.skipIf(!canEnumerateProcChildren())('passively verifies every captured direct serve generation', async () => {
    const children = Array.from({length: 2}, () => spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '--', 'serve', '--stdio']));
    const exited = children.map(child => once(child, 'exit'));
    try {
        const entries = captureServeProcesses(process.pid);
        expect(entries?.map(row => row.pid).sort()).toEqual(children.map(child => child.pid).sort());
        expect(await waitForServeExit(entries, 50)).toBe(false);
        expect(await waitForServeExit(entries!.map(row => ({ ...row, startMarker: 'previous' })), 200)).toBe(true);
        children[0]!.kill();
        await exited[0];
        expect(await waitForServeExit(entries, 50)).toBe(false);
        children[1]!.kill();
        await exited[1];
        expect(await waitForServeExit(entries)).toBe(true);
    } finally {
        children.forEach(child => child.kill());
        await Promise.all(exited);
    }
});

it.skipIf(!canEnumerateProcChildren())('distinguishes a missing writer identity even after the real child exits', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'serve', '--stdio']);
    const exited = once(child, 'exit');
    try {
        const verify = vi.fn(waitForServeExit);
        const fence = createServeFence(() => [], verify);
        child.kill();
        await exited;
        expect(fence.complete).toBe(false);
        await expect(fence.verify()).resolves.toBe(false);
        expect(verify).not.toHaveBeenCalled();
    } finally {
        child.kill();
        await exited;
    }
});

it('keeps every observed generation when the direct serve changes at dispatch', async () => {
    const lateServe = [{ pid: 11, startMarker: 'b' }];
    const snapshots = [[{ pid: 10, startMarker: 'a' }], lateServe, lateServe];
    const checked: string[] = [];
    const fence = createServeFence(() => snapshots.shift()!, async servers => {
        checked.push(...servers.map(server => server.startMarker));
        return !servers.some(server => server.startMarker === 'b');
    });
    fence.refresh();
    fence.refresh();
    expect(await fence.verify()).toBe(false);
    expect(checked).toEqual(['a', 'b']);
});

it.each([
    { reason: 'unreadable', ambiguous: null },
    { reason: 'empty', ambiguous: [] },
    { reason: 'multiple', ambiguous: [{ pid: 1, startMarker: 'a' }, { pid: 2, startMarker: 'b' }] }
])(
    'refuses $reason observations even after a subsequent single server', async ({ ambiguous }) => {
        const one = [{ pid: 1, startMarker: 'a' }];
        const observations = [one, ambiguous, one];
        const fence = createServeFence(() => observations.shift()!, async () => true);
        fence.refresh();
        fence.refresh();
        expect(await fence.verify()).toBe(false);
    }
);

it.skipIf(!canEnumerateProcChildren())('retries a disappearing child once and recognizes a zombie with the same start ticks', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'serve', '--stdio']);
    const exited = once(child, 'exit');
    const original = (await vi.importActual<typeof fs>('node:fs')).readFileSync;
    const cmdline = `/proc/${child.pid}/cmdline`;
    const stat = `/proc/${child.pid}/stat`;
    let remainingFailures = 1;
    let zombie = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
        if (path === cmdline && remainingFailures-- > 0) {
            throw Object.assign(new Error('child vanished'), { code: 'ENOENT' });
        }
        const result = original(path, options);
        if (path === stat && zombie && typeof result === 'string') return result.replace(/\) \S /, ') Z ');
        return result;
    });
    try {
        const servers = captureServeProcesses(process.pid);
        expect(servers?.map(server => server.pid)).toEqual([child.pid]);
        remainingFailures = 2;
        expect(captureServeProcesses(process.pid)).toBeNull();
        zombie = true;
        expect(await waitForServeExit(servers, 100)).toBe(true);
    } finally {
        spy.mockRestore();
        child.kill();
        await exited;
    }
});
