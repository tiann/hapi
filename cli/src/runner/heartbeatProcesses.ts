import { getProcessStartMarker, isProcessAlive, isWindows } from '@/utils/process';
import { readWindowsProcessTable } from '@/utils/windowsProcessStop';

export type HeartbeatProcessState = { alive: boolean; startMarker: string | null };

/** Observe the PIDs present at the start of one heartbeat. */
export async function observeHeartbeatProcesses(
    pids: Iterable<number>,
    verifyGeneration?: ReadonlySet<number>,
): Promise<Map<number, HeartbeatProcessState>> {
    const states = new Map<number, HeartbeatProcessState>();
    const candidates = new Set(pids);
    if (candidates.size === 0) return states;
    if (isWindows()) {
        // An invalid/failed snapshot must not fall back to the synchronous
        // per-PID probes that made startup webhooks miss their deadlines.
        const processes = await readWindowsProcessTable(10_000, [...candidates]);
        if (!processes) throw new Error('Windows heartbeat process snapshot failed');
        for (const pid of candidates) {
            const proc = processes.get(pid);
            states.set(pid, { alive: Boolean(proc), startMarker: proc?.marker ?? null });
        }
        return states;
    }
    for (const pid of candidates) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const alive = isProcessAlive(pid);
        const needsMarker = verifyGeneration === undefined || verifyGeneration.has(pid);
        states.set(pid, { alive, startMarker: alive && needsMarker ? getProcessStartMarker(pid) : null });
    }
    return states;
}
