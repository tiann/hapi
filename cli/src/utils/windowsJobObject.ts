/**
 * Windows Job Object containment for agent process trees (#2021).
 *
 * Node/libuv's implicit job enables SILENT_BREAKAWAY, so grandchildren escape
 * taskkill /T after the root exits. A dedicated job without breakaway keeps
 * every descendant that CreateProcess-forks after AssignProcessToJobObject,
 * and QueryInformationJobObject / TerminateJobObject give settlement evidence
 * that survives root exit — the Approach gap ancestry snapshots cannot close.
 *
 * Binding uses bun:ffi → kernel32 on win32. Non-Windows, missing FFI, or
 * Assign failure returns null so callers keep the sticky-incomplete fallback.
 *
 * https://learn.microsoft.com/windows/win32/procthread/job-objects
 */

const isWin32 = (): boolean => process.platform === 'win32';

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
/** JobObjectBasicAccountingInformation */
const JobObjectBasicAccountingInformation = 1;
/** JobObjectExtendedLimitInformation */
const JobObjectExtendedLimitInformation = 9;
/** PROCESS_SET_QUOTA | PROCESS_TERMINATE */
const PROCESS_ASSIGN_ACCESS = 0x0101;
/** DWORD ActiveProcesses offset in JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (x64). */
const ACTIVE_PROCESSES_OFFSET = 40;
const BASIC_ACCOUNTING_SIZE = 48;
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION size on x64. */
const EXTENDED_LIMIT_SIZE = 144;

export type WindowsJobKernel = {
    CreateJobObjectW(attrs: null, name: null): number | bigint;
    SetInformationJobObject(
        job: number | bigint,
        infoClass: number,
        info: Buffer,
        length: number,
    ): number;
    OpenProcess(access: number, inherit: number, pid: number): number | bigint;
    AssignProcessToJobObject(job: number | bigint, process: number | bigint): number;
    QueryInformationJobObject(
        job: number | bigint,
        infoClass: number,
        info: Buffer,
        length: number,
        returnLength: null,
    ): number;
    TerminateJobObject(job: number | bigint, exitCode: number): number;
    CloseHandle(handle: number | bigint): number;
    GetLastError(): number;
    ptr(buffer: Buffer): unknown;
    closeLibrary(): void;
};

type BunFfiModule = {
    dlopen: (
        name: string,
        symbols: Record<string, { args: string[]; returns: string }>,
    ) => {
        symbols: Record<string, (...args: never[]) => unknown>;
        close: () => void;
    };
    ptr: (buffer: Buffer) => unknown;
    FFIType: Record<string, string>;
};

/** Test seam — inject a fake kernel without loading bun:ffi. */
let kernelFactory: (() => WindowsJobKernel | null) | null = null;

export function setWindowsJobKernelFactoryForTests(
    factory: (() => WindowsJobKernel | null) | null,
): void {
    kernelFactory = factory;
}

async function loadKernel(): Promise<WindowsJobKernel | null> {
    if (kernelFactory) return kernelFactory();
    if (!isWin32()) return null;
    try {
        const ffi = (await import('bun:ffi')) as unknown as BunFfiModule;
        const { dlopen, FFIType, ptr } = ffi;
        const lib = dlopen('kernel32.dll', {
            CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
            SetInformationJobObject: {
                args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
            OpenProcess: {
                args: [FFIType.u32, FFIType.i32, FFIType.u32],
                returns: FFIType.u64,
            },
            AssignProcessToJobObject: {
                args: [FFIType.u64, FFIType.u64],
                returns: FFIType.i32,
            },
            QueryInformationJobObject: {
                args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
                returns: FFIType.i32,
            },
            TerminateJobObject: {
                args: [FFIType.u64, FFIType.u32],
                returns: FFIType.i32,
            },
            CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
            GetLastError: { args: [], returns: FFIType.u32 },
        });
        const s = lib.symbols;
        return {
            CreateJobObjectW: (attrs, name) =>
                s.CreateJobObjectW(attrs as never, name as never) as number | bigint,
            SetInformationJobObject: (job, infoClass, info, length) =>
                s.SetInformationJobObject(
                    job as never,
                    infoClass as never,
                    ptr(info) as never,
                    length as never,
                ) as number,
            OpenProcess: (access, inherit, pid) =>
                s.OpenProcess(access as never, inherit as never, pid as never) as number | bigint,
            AssignProcessToJobObject: (job, process) =>
                s.AssignProcessToJobObject(job as never, process as never) as number,
            QueryInformationJobObject: (job, infoClass, info, length, returnLength) =>
                s.QueryInformationJobObject(
                    job as never,
                    infoClass as never,
                    ptr(info) as never,
                    length as never,
                    returnLength as never,
                ) as number,
            TerminateJobObject: (job, exitCode) =>
                s.TerminateJobObject(job as never, exitCode as never) as number,
            CloseHandle: (handle) => s.CloseHandle(handle as never) as number,
            GetLastError: () => s.GetLastError() as number,
            ptr,
            closeLibrary: () => lib.close(),
        };
    } catch {
        return null;
    }
}

function handleOk(handle: number | bigint | null | undefined): boolean {
    if (handle === null || handle === undefined) return false;
    if (typeof handle === 'bigint') return handle !== 0n;
    return handle !== 0;
}

/**
 * Containment handle for one agent root. Keep the job open for the agent
 * lifetime; {@link WindowsAgentJob.terminate} kills the tree; {@link WindowsAgentJob.release}
 * closes the handle (KILL_ON_JOB_CLOSE also terminates any remaining members).
 */
export class WindowsAgentJob {
    private constructor(
        private readonly kernel: WindowsJobKernel,
        private job: number | bigint,
    ) {}

    /** Module-private construction — prefer {@link tryAssignWindowsAgentJob}. */
    static fromAssigned(kernel: WindowsJobKernel, job: number | bigint): WindowsAgentJob {
        return new WindowsAgentJob(kernel, job);
    }

    /** ActiveProcesses from JobObjectBasicAccountingInformation, or null on query failure. */
    activeProcessCount(): number | null {
        if (!handleOk(this.job)) return null;
        const buf = Buffer.alloc(BASIC_ACCOUNTING_SIZE);
        if (
            !this.kernel.QueryInformationJobObject(
                this.job,
                JobObjectBasicAccountingInformation,
                buf,
                buf.byteLength,
                null,
            )
        ) {
            return null;
        }
        return buf.readUInt32LE(ACTIVE_PROCESSES_OFFSET);
    }

    /** True when the job reports zero live members (root and descendants exited). */
    isEmpty(): boolean {
        const count = this.activeProcessCount();
        return count === 0;
    }

    /** Kill every process currently in the job. */
    terminate(exitCode = 1): boolean {
        if (!handleOk(this.job)) return false;
        return !!this.kernel.TerminateJobObject(this.job, exitCode);
    }

    /**
     * Drop the last handle. With KILL_ON_JOB_CLOSE, remaining members die.
     * Safe to call more than once.
     */
    release(): void {
        if (!handleOk(this.job)) return;
        try {
            this.kernel.CloseHandle(this.job);
        } catch {
            // ignore
        }
        this.job = 0;
        try {
            this.kernel.closeLibrary();
        } catch {
            // ignore
        }
    }
}

/**
 * Create a kill-on-close job and assign `rootPid` immediately after spawn.
 * Returns null when containment is unavailable — callers keep incomplete sticky.
 */
export async function tryAssignWindowsAgentJob(rootPid: number): Promise<WindowsAgentJob | null> {
    if (!Number.isFinite(rootPid) || rootPid <= 0) return null;
    // Test factory bypasses the platform gate so Linux CI can exercise settle
    // semantics without kernel32. Production still requires win32 + bun:ffi.
    if (!kernelFactory && !isWin32()) return null;
    const kernel = await loadKernel();
    if (!kernel) return null;

    let job: number | bigint = 0;
    let processHandle: number | bigint = 0;
    try {
        job = kernel.CreateJobObjectW(null, null);
        if (!handleOk(job)) {
            kernel.closeLibrary();
            return null;
        }

        const limits = Buffer.alloc(EXTENDED_LIMIT_SIZE);
        // LimitFlags DWORD at offset 16 in JOBOBJECT_BASIC_LIMIT_INFORMATION.
        limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
        if (
            !kernel.SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                limits,
                limits.byteLength,
            )
        ) {
            kernel.CloseHandle(job);
            kernel.closeLibrary();
            return null;
        }

        processHandle = kernel.OpenProcess(PROCESS_ASSIGN_ACCESS, 0, rootPid);
        if (!handleOk(processHandle)) {
            kernel.CloseHandle(job);
            kernel.closeLibrary();
            return null;
        }

        if (!kernel.AssignProcessToJobObject(job, processHandle)) {
            kernel.CloseHandle(processHandle);
            kernel.CloseHandle(job);
            kernel.closeLibrary();
            return null;
        }
        kernel.CloseHandle(processHandle);
        processHandle = 0;
        return WindowsAgentJob.fromAssigned(kernel, job);
    } catch {
        if (handleOk(processHandle)) kernel.CloseHandle(processHandle);
        if (handleOk(job)) kernel.CloseHandle(job);
        try {
            kernel.closeLibrary();
        } catch {
            // ignore
        }
        return null;
    }
}
