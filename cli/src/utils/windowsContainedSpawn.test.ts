import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildWindowsUnicodeEnvBlock,
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

function baseKernel(overrides: Record<string, unknown> = {}) {
    return {
        CreateJobObjectW: () => 0x1000n,
        SetInformationJobObject: () => 1,
        AssignProcessToJobObject: () => 1,
        IsProcessInJob: (_p: unknown, _j: unknown, result: Buffer) => {
            result.writeUInt32LE(1, 0);
            return 1;
        },
        CreatePipe: (readOut: Buffer, writeOut: Buffer) => {
            readOut.writeBigUInt64LE(0x10n, 0);
            writeOut.writeBigUInt64LE(0x11n, 0);
            return 1;
        },
        SetHandleInformation: () => 1,
        CreateProcessW: (
            _a: unknown, _c: unknown, _pa: unknown, _ta: unknown, _inh: unknown,
            _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, pi: unknown,
        ) => {
            writeProcessInfo(pi, 0x2000n, 0x3000n, 4242);
            return 1;
        },
        ResumeThread: () => 1,
        TerminateProcess: () => 1,
        GetExitCodeProcess: (_p: unknown, codeOut: Buffer) => {
            codeOut.writeUInt32LE(259, 0); // STILL_ACTIVE
            return 1;
        },
        GetStdHandle: () => 0n,
        CloseHandle: () => 1,
        GetLastError: () => 0,
        openOsFhandle: () => 3,
        QueryInformationJobObject: (_j: unknown, _c: unknown, info: Buffer) => {
            info.writeUInt32LE(0, 40);
            return 1;
        },
        TerminateJobObject: () => 1,
        ptr: (buf: Buffer) => buf,
        closeLibrary: vi.fn(),
        ...overrides,
    };
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

    it('passes a Unicode env block when env is configured (#2021 Major)', async () => {
        let seenFlags = 0;
        let seenEnv: unknown = null;
        setWindowsContainedSpawnKernelFactoryForTests(() => baseKernel({
            CreateProcessW: (
                _a: unknown, _c: unknown, _pa: unknown, _ta: unknown, _inh: unknown,
                flags: number, env: unknown, _cwd: unknown, _si: unknown, pi: unknown,
            ) => {
                seenFlags = flags;
                seenEnv = env;
                writeProcessInfo(pi, 0x2000n, 0x3000n, 11);
                return 1;
            },
        }) as never);

        const child = await spawnWindowsContainedProcess({
            file: 'C:\\Tools\\agent.exe',
            args: [],
            env: { HAPI_TEST: 'yes', PATH: 'C:\\bin' },
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        expect(child).not.toBeNull();
        expect(seenFlags & 0x400).toBe(0x400); // CREATE_UNICODE_ENVIRONMENT
        expect(seenEnv).not.toBeNull();
        child!.windowsAgentJob.release();
    });

    it('keeps the Job Object queryable after root exit (#2021 Major)', async () => {
        let exitPolls = 0;
        setWindowsContainedSpawnKernelFactoryForTests(() => baseKernel({
            GetExitCodeProcess: (_p: unknown, codeOut: Buffer) => {
                exitPolls += 1;
                codeOut.writeUInt32LE(exitPolls > 1 ? 0 : 259, 0);
                return 1;
            },
        }) as never);

        const child = await spawnWindowsContainedProcess({
            file: 'C:\\Tools\\agent.exe',
            args: [],
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        expect(child).not.toBeNull();
        await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
        // Launcher still verifies emptiness after root exit — handle must remain.
        expect(child!.windowsAgentJob.isEmpty()).toBe(true);
        child!.windowsAgentJob.release();
    });

    it('terminates the suspended process when stdio adapt fails (#2021 Major)', async () => {
        const terminate = vi.fn(() => 1);
        const resume = vi.fn(() => 1);
        setWindowsContainedSpawnKernelFactoryForTests(() => baseKernel({
            openOsFhandle: () => -1,
            TerminateProcess: terminate,
            ResumeThread: resume,
        }) as never);

        expect(await spawnWindowsContainedProcess({
            file: 'C:\\Tools\\agent.exe',
            args: [],
            stdio: ['pipe', 'pipe', 'pipe'],
        })).toBeNull();
        expect(terminate).toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
    });

    it('buildWindowsUnicodeEnvBlock is UTF-16LE KEY=value\\0…\\0', () => {
        const block = buildWindowsUnicodeEnvBlock({ A: '1', B: '2' });
        expect(block.toString('utf16le')).toBe('A=1\0B=2\0\0');
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
