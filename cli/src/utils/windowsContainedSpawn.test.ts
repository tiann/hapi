import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    setWindowsContainedSpawnKernelFactoryForTests,
    spawnWindowsContainedProcess,
} from './windowsContainedSpawn';

afterEach(() => {
    setWindowsContainedSpawnKernelFactoryForTests(null);
});

function writeProcessInfo(pi: unknown, processHandle: bigint, threadHandle: bigint, pid: number): void {
    const buf = pi as Buffer;
    buf.writeBigUInt64LE(processHandle, 0);
    buf.writeBigUInt64LE(threadHandle, 8);
    buf.writeUInt32LE(pid, 16);
}

describe('spawnWindowsContainedProcess', () => {
    it('confirms Job Object membership while CREATE_SUSPENDED before Resume (#2021)', async () => {
        const order: string[] = [];
        let assigned = false;

        setWindowsContainedSpawnKernelFactoryForTests(() => ({
            CreateJobObjectW: () => 0x1000n,
            SetInformationJobObject: () => 1,
            AssignProcessToJobObject: () => {
                order.push('assign');
                assigned = true;
                return 1;
            },
            IsProcessInJob: (_p, _j, result) => {
                order.push('in-job');
                result.writeUInt32LE(assigned ? 1 : 0, 0);
                return 1;
            },
            CreatePipe: (readOut, writeOut) => {
                readOut.writeBigUInt64LE(0x10n, 0);
                writeOut.writeBigUInt64LE(0x11n, 0);
                return 1;
            },
            SetHandleInformation: () => 1,
            CreateProcessW: (_a, _c, _pa, _ta, _inh, flags, _env, _cwd, _si, pi) => {
                order.push('create');
                expect(flags & 0x4).toBe(0x4); // CREATE_SUSPENDED
                writeProcessInfo(pi, 0x2000n, 0x3000n, 4242);
                return 1;
            },
            ResumeThread: () => {
                order.push('resume');
                return 1;
            },
            TerminateProcess: () => 1,
            GetExitCodeProcess: (_p, codeOut) => {
                codeOut.writeUInt32LE(0, 0);
                return 1;
            },
            GetStdHandle: () => 0n,
            CloseHandle: () => 1,
            GetLastError: () => 0,
            openOsFhandle: () => 3,
            QueryInformationJobObject: (_j, _c, info) => {
                info.writeUInt32LE(0, 40);
                return 1;
            },
            TerminateJobObject: () => 1,
            ptr: (buf) => buf,
            closeLibrary: vi.fn(),
        }));

        const child = await spawnWindowsContainedProcess({
            file: 'C:\\Tools\\agent.exe',
            args: ['-p', 'hi'],
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(child).not.toBeNull();
        expect(child!.jobEstablishedAtCreate).toBe(true);
        expect(child!.windowsAgentJob.establishedAtCreate).toBe(true);
        expect(child!.pid).toBe(4242);
        expect(order).toEqual(['create', 'assign', 'in-job', 'resume']);
        child!.kill();
    });

    it('returns null when Assign fails while still suspended', async () => {
        setWindowsContainedSpawnKernelFactoryForTests(() => ({
            CreateJobObjectW: () => 0x1000n,
            SetInformationJobObject: () => 1,
            AssignProcessToJobObject: () => 0,
            IsProcessInJob: () => 0,
            CreatePipe: (r, w) => {
                r.writeBigUInt64LE(1n, 0);
                w.writeBigUInt64LE(2n, 0);
                return 1;
            },
            SetHandleInformation: () => 1,
            CreateProcessW: (_a, _c, _pa, _ta, _i, _f, _e, _cwd, _si, pi) => {
                writeProcessInfo(pi, 0x2000n, 0x3000n, 7);
                return 1;
            },
            ResumeThread: () => 1,
            TerminateProcess: () => 1,
            GetExitCodeProcess: () => 1,
            GetStdHandle: () => 0n,
            CloseHandle: () => 1,
            GetLastError: () => 5,
            openOsFhandle: () => 3,
            QueryInformationJobObject: () => 1,
            TerminateJobObject: () => 1,
            ptr: (buf) => buf,
            closeLibrary: vi.fn(),
        }));

        expect(await spawnWindowsContainedProcess({
            file: 'C:\\Tools\\agent.exe',
            args: [],
            stdio: ['ignore', 'ignore', 'ignore'],
        })).toBeNull();
    });
});
