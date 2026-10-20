import { getProcessStartMarker, isProcessAlive, isWindows } from '@/utils/process';
import { listWindowsProcessesWithCommandLineAsync } from './orphanReap';

export type HeartbeatProcessState = { alive: boolean; startMarker: string | null };

/** Observe the PIDs present at the start of one heartbeat. */
export async function observeHeartbeatProcesses(pids: Iterable<number>): Promise<Map<number, HeartbeatProcessState>> {
    const states = new Map<number, HeartbeatProcessState>();
    const candidates = new Set(pids);
    if (candidates.size === 0) return states;
    if (isWindows()) {
        // An invalid/failed snapshot must not fall back to the synchronous
        // per-PID probes that made startup webhooks miss their deadlines.
        const processes = new Map((await listWindowsProcessesWithCommandLineAsync()).map(proc => [proc.pid, proc]));
        for (const pid of candidates) {
            const proc = processes.get(pid);
            states.set(pid, { alive: Boolean(proc), startMarker: proc?.startMarker ?? null });
        }
        return states;
    }
    for (const pid of candidates) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const alive = isProcessAlive(pid);
        states.set(pid, { alive, startMarker: alive ? getProcessStartMarker(pid) : null });
    }
    return states;
}
