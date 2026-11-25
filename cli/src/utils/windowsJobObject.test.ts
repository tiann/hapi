import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    setWindowsJobKernelFactoryForTests,
    tryAssignWindowsAgentJob,
    type WindowsJobKernel,
} from './windowsJobObject';

function fakeKernel(opts: {
    assignOk?: boolean;
    activeProcesses?: number;
}): WindowsJobKernel {
    const assignOk = opts.assignOk !== false;
    let active = opts.activeProcesses ?? 1;
    const jobHandle = 0x1111n;
    const processHandle = 0x2222n;
    return {
        CreateJobObjectW: () => jobHandle,
        SetInformationJobObject: () => 1,
        OpenProcess: () => processHandle,
        AssignProcessToJobObject: () => (assignOk ? 1 : 0),
        QueryInformationJobObject: (_job, _cls, info) => {
            info.writeUInt32LE(active, 40);
            return 1;
        },
        TerminateJobObject: () => {
            active = 0;
            return 1;
        },
        CloseHandle: () => 1,
        GetLastError: () => 0,
        ptr: (buf) => buf,
        closeLibrary: vi.fn(),
    };
}

afterEach(() => {
    setWindowsJobKernelFactoryForTests(null);
});

describe('tryAssignWindowsAgentJob', () => {
    it('returns null when assign fails so callers keep incomplete sticky (#2021)', async () => {
        setWindowsJobKernelFactoryForTests(() => fakeKernel({ assignOk: false }));
        expect(await tryAssignWindowsAgentJob(4242)).toBeNull();
    });

    it('settles on empty ActiveProcesses after terminate (#2021 Approach)', async () => {
        setWindowsJobKernelFactoryForTests(() => fakeKernel({ activeProcesses: 2 }));
        const job = await tryAssignWindowsAgentJob(4242);
        expect(job).not.toBeNull();
        expect(job!.isEmpty()).toBe(false);
        expect(job!.activeProcessCount()).toBe(2);
        expect(job!.terminate()).toBe(true);
        expect(job!.isEmpty()).toBe(true);
        job!.release();
    });

    it('rejects non-positive PIDs', async () => {
        setWindowsJobKernelFactoryForTests(() => fakeKernel({}));
        expect(await tryAssignWindowsAgentJob(0)).toBeNull();
        expect(await tryAssignWindowsAgentJob(-1)).toBeNull();
    });
});
