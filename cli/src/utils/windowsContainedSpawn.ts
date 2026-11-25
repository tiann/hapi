/**
 * CREATE_SUSPENDED agent spawn with Job Object membership before ResumeThread
 * (#2021 Approach).
 *
 * Post-spawn Assign (even with NtSuspendProcess) leaves a window where the
 * agent can fork outside the job. CreateProcessW(CREATE_SUSPENDED) closes that
 * window: Assign + IsProcessInJob happen while the initial thread is frozen.
 */

import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { WindowsAgentJob, canContainWithoutShell } from './windowsJobObject';

const CREATE_SUSPENDED = 0x0000_0004;
const CREATE_NO_WINDOW = 0x0800_0000;
const STARTF_USESTDHANDLES = 0x0000_0100;
const HANDLE_FLAG_INHERIT = 0x0000_0001;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const EXTENDED_LIMIT_SIZE = 144;
const STARTUPINFOW_SIZE = 104;
const PROCESS_INFORMATION_SIZE = 24;
const STILL_ACTIVE = 259;
const O_RDONLY_BINARY = 0x8000;
const O_WRONLY_BINARY = 0x8001;

export type ContainedSpawnOptions = {
    file: string;
    args: string[];
    cwd?: string;
    stdio: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe'];
};

export type ContainedWindowsChild = EventEmitter & {
    pid: number;
    stdin: WriteStream | null;
    stdout: ReadStream | null;
    stderr: ReadStream | null;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
    windowsAgentJob: WindowsAgentJob;
    /** True only for CREATE_SUSPENDED → Assign → Resume launches. */
    jobEstablishedAtCreate: true;
};

type FfiPtr = unknown;
type ContainedKernel = {
    CreateJobObjectW: (a: null, b: null) => number | bigint;
    SetInformationJobObject: (job: number | bigint, cls: number, info: Buffer, len: number) => number;
    AssignProcessToJobObject: (job: number | bigint, process: number | bigint) => number;
    IsProcessInJob: (process: number | bigint, job: number | bigint, result: Buffer) => number;
    CreatePipe: (readOut: Buffer, writeOut: Buffer, attrs: null, size: number) => number;
    SetHandleInformation: (handle: number | bigint, mask: number, flags: number) => number;
    CreateProcessW: (
        app: FfiPtr,
        cmd: FfiPtr,
        pa: null,
        ta: null,
        inherit: number,
        flags: number,
        env: null,
        cwd: FfiPtr | null,
        startup: FfiPtr,
        pi: FfiPtr,
    ) => number;
    ResumeThread: (thread: number | bigint) => number;
    TerminateProcess: (process: number | bigint, code: number) => number;
    GetExitCodeProcess: (process: number | bigint, codeOut: Buffer) => number;
    GetStdHandle: (id: number) => number | bigint;
    CloseHandle: (handle: number | bigint) => number;
    GetLastError: () => number;
    openOsFhandle: (handle: number | bigint, flags: number) => number;
    QueryInformationJobObject: WindowsAgentJob extends never ? never : (
        job: number | bigint,
        cls: number,
        info: Buffer,
        len: number,
        ret: null,
    ) => number;
    TerminateJobObject: (job: number | bigint, code: number) => number;
    ptr: (buf: Buffer) => FfiPtr;
    closeLibrary: () => void;
};

let kernelFactory: (() => ContainedKernel | null) | null = null;

export function setWindowsContainedSpawnKernelFactoryForTests(
    factory: (() => ContainedKernel | null) | null,
): void {
    kernelFactory = factory;
}

function ok(handle: number | bigint | null | undefined): boolean {
    if (handle === null || handle === undefined) return false;
    return typeof handle === 'bigint' ? handle !== 0n : handle !== 0;
}

function quoteWinArg(argument: string): string {
    if (argument === '') return '""';
    if (!/[\s"]/u.test(argument)) return argument;
    let quoted = '"';
    for (let i = 0; i < argument.length; i += 1) {
        let bs = 0;
        while (i < argument.length && argument[i] === '\\') {
            bs += 1;
            i += 1;
        }
        if (i === argument.length) quoted += '\\'.repeat(bs * 2);
        else if (argument[i] === '"') quoted += '\\'.repeat(bs * 2 + 1) + '"';
        else quoted += '\\'.repeat(bs) + argument[i];
    }
    return `${quoted}"`;
}

function wstr(value: string): Buffer {
    return Buffer.from(`${value}\0`, 'utf16le');
}

async function loadKernel(): Promise<ContainedKernel | null> {
    if (kernelFactory) return kernelFactory();
    if (process.platform !== 'win32') return null;
    try {
        const { dlopen, FFIType, ptr } = await import('bun:ffi') as unknown as {
            dlopen: (
                name: string,
                symbols: Record<string, { args: string[]; returns: string }>,
            ) => {
                symbols: Record<string, (...args: never[]) => unknown>;
                close: () => void;
            };
            ptr: (buffer: Buffer) => FfiPtr;
            FFIType: Record<string, string>;
        };
        const lib = dlopen('kernel32.dll', {
            CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
            SetInformationJobObject: {
                args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
            AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
            IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
            CreatePipe: {
                args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
            SetHandleInformation: {
                args: [FFIType.u64, FFIType.u32, FFIType.u32],
                returns: FFIType.i32,
            },
            CreateProcessW: {
                args: [
                    FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32,
                    FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
                ],
                returns: FFIType.i32,
            },
            ResumeThread: { args: [FFIType.u64], returns: FFIType.u32 },
            TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
            GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
            GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
            CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
            GetLastError: { args: [], returns: FFIType.u32 },
            QueryInformationJobObject: {
                args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
                returns: FFIType.i32,
            },
            TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
        });
        let openOsFhandle: ContainedKernel['openOsFhandle'] | null = null;
        for (const crt of ['ucrtbase.dll', 'msvcrt.dll']) {
            try {
                const m = dlopen(crt, {
                    _open_osfhandle: { args: [FFIType.i64, FFIType.i32], returns: FFIType.i32 },
                });
                openOsFhandle = (handle, flags) =>
                    m.symbols._open_osfhandle(
                        (typeof handle === 'bigint' ? handle : BigInt(handle)) as never,
                        flags as never,
                    ) as number;
                break;
            } catch {
                // next
            }
        }
        if (!openOsFhandle) {
            lib.close();
            return null;
        }
        const s = lib.symbols;
        return {
            CreateJobObjectW: (a, b) => s.CreateJobObjectW(a as never, b as never) as number | bigint,
            SetInformationJobObject: (job, cls, info, len) =>
                s.SetInformationJobObject(job as never, cls as never, ptr(info) as never, len as never) as number,
            AssignProcessToJobObject: (job, process) =>
                s.AssignProcessToJobObject(job as never, process as never) as number,
            IsProcessInJob: (process, job, result) =>
                s.IsProcessInJob(process as never, job as never, ptr(result) as never) as number,
            CreatePipe: (r, w, _a, size) =>
                s.CreatePipe(ptr(r) as never, ptr(w) as never, null as never, size as never) as number,
            SetHandleInformation: (h, mask, flags) =>
                s.SetHandleInformation(h as never, mask as never, flags as never) as number,
            CreateProcessW: (app, cmd, pa, ta, inherit, flags, env, cwd, startup, pi) =>
                s.CreateProcessW(
                    app as never, cmd as never, pa as never, ta as never, inherit as never,
                    flags as never, env as never, cwd as never, startup as never, pi as never,
                ) as number,
            ResumeThread: (t) => s.ResumeThread(t as never) as number,
            TerminateProcess: (p, c) => s.TerminateProcess(p as never, c as never) as number,
            GetExitCodeProcess: (p, out) =>
                s.GetExitCodeProcess(p as never, ptr(out) as never) as number,
            GetStdHandle: (id) => s.GetStdHandle(id as never) as number | bigint,
            CloseHandle: (h) => s.CloseHandle(h as never) as number,
            GetLastError: () => s.GetLastError() as number,
            openOsFhandle,
            QueryInformationJobObject: (job, cls, info, len, ret) =>
                s.QueryInformationJobObject(
                    job as never, cls as never, ptr(info) as never, len as never, ret as never,
                ) as number,
            TerminateJobObject: (job, code) =>
                s.TerminateJobObject(job as never, code as never) as number,
            ptr,
            closeLibrary: () => lib.close(),
        };
    } catch {
        return null;
    }
}

function streamFromHandle(
    kernel: ContainedKernel,
    handle: bigint,
    kind: 'read' | 'write',
): ReadStream | WriteStream | null {
    // Test factory kernels skip real CRT handles — PassThrough stands in.
    if (kernelFactory) {
        return new PassThrough() as unknown as ReadStream & WriteStream;
    }
    const fd = kernel.openOsFhandle(handle, kind === 'read' ? O_RDONLY_BINARY : O_WRONLY_BINARY);
    if (fd < 0) return null;
    try {
        return kind === 'read'
            ? createReadStream('', { fd, autoClose: true })
            : createWriteStream('', { fd, autoClose: true });
    } catch {
        return null;
    }
}

/**
 * Spawn with CREATE_SUSPENDED, assign Job Object, confirm membership, resume.
 * Returns null when the host cannot establish create-time containment.
 */
export async function spawnWindowsContainedProcess(
    options: ContainedSpawnOptions,
): Promise<ContainedWindowsChild | null> {
    if (!kernelFactory && process.platform !== 'win32') return null;
    if (!kernelFactory && !canContainWithoutShell(options.file)) return null;

    const kernel = await loadKernel();
    if (!kernel) return null;

    let jobHandle: number | bigint = 0;
    let hProcess: number | bigint = 0;
    let hThread: number | bigint = 0;
    const toClose: Array<number | bigint> = [];

    try {
        jobHandle = kernel.CreateJobObjectW(null, null);
        if (!ok(jobHandle)) {
            kernel.closeLibrary();
            return null;
        }
        const limits = Buffer.alloc(EXTENDED_LIMIT_SIZE);
        limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
        if (!kernel.SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, limits, limits.byteLength)) {
            kernel.CloseHandle(jobHandle);
            kernel.closeLibrary();
            return null;
        }

        type PipeEnds = { child: bigint; parent: bigint; parentKind: 'read' | 'write' };
        const pipeEnds: [PipeEnds | null, PipeEnds | null, PipeEnds | null] = [null, null, null];

        for (let i = 0; i < 3; i += 1) {
            if (options.stdio[i] !== 'pipe') continue;
            const readOut = Buffer.alloc(8);
            const writeOut = Buffer.alloc(8);
            if (!kernel.CreatePipe(readOut, writeOut, null, 0)) {
                throw new Error(`CreatePipe failed (${kernel.GetLastError()})`);
            }
            const read = readOut.readBigUInt64LE(0);
            const write = writeOut.readBigUInt64LE(0);
            if (i === 0) {
                // stdin: child reads
                if (!kernel.SetHandleInformation(read, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
                    throw new Error('SetHandleInformation stdin');
                }
                pipeEnds[0] = { child: read, parent: write, parentKind: 'write' };
                toClose.push(read); // close child end in parent after CreateProcess
            } else {
                if (!kernel.SetHandleInformation(write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
                    throw new Error('SetHandleInformation stdio');
                }
                pipeEnds[i] = { child: write, parent: read, parentKind: 'read' };
                toClose.push(write);
            }
        }

        const STD_INPUT = 0xffff_fff6;
        const STD_OUTPUT = 0xffff_fff5;
        const STD_ERROR = 0xffff_fff4;
        const hIn = pipeEnds[0]?.child
            ?? (typeof kernel.GetStdHandle(STD_INPUT) === 'bigint'
                ? kernel.GetStdHandle(STD_INPUT) as bigint
                : BigInt(kernel.GetStdHandle(STD_INPUT) as number));
        const hOut = pipeEnds[1]?.child
            ?? (typeof kernel.GetStdHandle(STD_OUTPUT) === 'bigint'
                ? kernel.GetStdHandle(STD_OUTPUT) as bigint
                : BigInt(kernel.GetStdHandle(STD_OUTPUT) as number));
        const hErr = pipeEnds[2]?.child
            ?? (typeof kernel.GetStdHandle(STD_ERROR) === 'bigint'
                ? kernel.GetStdHandle(STD_ERROR) as bigint
                : BigInt(kernel.GetStdHandle(STD_ERROR) as number));

        const startup = Buffer.alloc(STARTUPINFOW_SIZE);
        startup.writeUInt32LE(STARTUPINFOW_SIZE, 0);
        startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
        startup.writeBigUInt64LE(typeof hIn === 'bigint' ? hIn : BigInt(hIn), 80);
        startup.writeBigUInt64LE(typeof hOut === 'bigint' ? hOut : BigInt(hOut), 88);
        startup.writeBigUInt64LE(typeof hErr === 'bigint' ? hErr : BigInt(hErr), 96);

        const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE);
        const app = wstr(options.file);
        const cmd = wstr([options.file, ...options.args].map(quoteWinArg).join(' '));
        const cwdBuf = options.cwd ? wstr(options.cwd) : null;

        if (!kernel.CreateProcessW(
            kernel.ptr(app),
            kernel.ptr(cmd),
            null,
            null,
            1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            null,
            cwdBuf ? kernel.ptr(cwdBuf) : null,
            kernel.ptr(startup),
            kernel.ptr(processInfo),
        )) {
            throw new Error(`CreateProcessW failed (${kernel.GetLastError()})`);
        }

        hProcess = processInfo.readBigUInt64LE(0);
        hThread = processInfo.readBigUInt64LE(8);
        const pid = processInfo.readUInt32LE(16);

        for (const handle of toClose) kernel.CloseHandle(handle);
        toClose.length = 0;

        if (!kernel.AssignProcessToJobObject(jobHandle, hProcess)) {
            kernel.TerminateProcess(hProcess, 1);
            throw new Error(`AssignProcessToJobObject failed (${kernel.GetLastError()})`);
        }
        const inJob = Buffer.alloc(4);
        if (!kernel.IsProcessInJob(hProcess, jobHandle, inJob) || inJob.readUInt32LE(0) === 0) {
            kernel.TerminateProcess(hProcess, 1);
            throw new Error('IsProcessInJob returned false');
        }
        if (kernel.ResumeThread(hThread) === 0xffff_ffff) {
            kernel.TerminateProcess(hProcess, 1);
            throw new Error(`ResumeThread failed (${kernel.GetLastError()})`);
        }
        kernel.CloseHandle(hThread);
        hThread = 0;

        // Adapt kernel shape to WindowsAgentJob without closing the shared lib early.
        const jobKernel = {
            CreateJobObjectW: kernel.CreateJobObjectW,
            SetInformationJobObject: kernel.SetInformationJobObject,
            OpenProcess: () => 0n,
            AssignProcessToJobObject: kernel.AssignProcessToJobObject,
            IsProcessInJob: kernel.IsProcessInJob,
            QueryInformationJobObject: kernel.QueryInformationJobObject,
            TerminateJobObject: kernel.TerminateJobObject,
            CloseHandle: kernel.CloseHandle,
            GetLastError: kernel.GetLastError,
            ptr: kernel.ptr,
            closeLibrary: () => {
                // Deferred: keep kernel alive until child exit watcher finishes.
            },
        };
        const job = WindowsAgentJob.fromAssigned(jobKernel, jobHandle, true);
        jobHandle = 0;

        const child = new EventEmitter() as ContainedWindowsChild;
        child.pid = pid;
        child.stdin = pipeEnds[0]
            ? streamFromHandle(kernel, pipeEnds[0].parent, 'write') as WriteStream
            : null;
        child.stdout = pipeEnds[1]
            ? streamFromHandle(kernel, pipeEnds[1].parent, 'read') as ReadStream
            : null;
        child.stderr = pipeEnds[2]
            ? streamFromHandle(kernel, pipeEnds[2].parent, 'read') as ReadStream
            : null;
        child.killed = false;
        child.exitCode = null;
        child.signalCode = null;
        child.windowsAgentJob = job;
        child.jobEstablishedAtCreate = true;
        child.kill = () => {
            child.killed = true;
            job.terminate(1);
            return true;
        };

        const processHandle = hProcess;
        hProcess = 0;
        void (async () => {
            try {
                for (;;) {
                    const codeOut = Buffer.alloc(4);
                    if (kernel.GetExitCodeProcess(processHandle, codeOut)) {
                        const code = codeOut.readUInt32LE(0);
                        if (code !== STILL_ACTIVE) {
                            child.exitCode = code;
                            kernel.CloseHandle(processHandle);
                            job.release();
                            kernel.closeLibrary();
                            child.emit('exit', code, null);
                            child.emit('close', code, null);
                            return;
                        }
                    }
                    await new Promise((r) => setTimeout(r, 50));
                }
            } catch {
                child.emit('error', new Error('contained spawn wait failed'));
            }
        })();

        return child;
    } catch {
        for (const handle of toClose) {
            try { kernel.CloseHandle(handle); } catch { /* ignore */ }
        }
        if (ok(hThread)) kernel.CloseHandle(hThread);
        if (ok(hProcess)) {
            try { kernel.TerminateProcess(hProcess, 1); } catch { /* ignore */ }
            kernel.CloseHandle(hProcess);
        }
        if (ok(jobHandle)) kernel.CloseHandle(jobHandle);
        try { kernel.closeLibrary(); } catch { /* ignore */ }
        return null;
    }
}

export function asNodeChild(contained: ContainedWindowsChild): ChildProcess {
    return contained as unknown as ChildProcess;
}
