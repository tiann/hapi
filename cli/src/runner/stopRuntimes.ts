import { type CodexRuntimeRecord, runtimeMayBeAlive } from '@/codex/shared/registry';
import { getProcessStartMarker, isProcessAlive, isWindows } from '@/utils/process';
import { readWindowsProcessTable } from '@/utils/windowsProcessStop';
import { logger } from '@/ui/logger';

function generationKey(record: CodexRuntimeRecord): string {
    return JSON.stringify([record.pid, record.marker, record.kind, record.serverPid, record.serverMarker]);
}

/** Registry candidates used only for stop-time shared-root protection. */
export async function readStopRuntimeCandidates(
    records: CodexRuntimeRecord[],
    sessionId: string,
    knownLive: Set<string> = new Set(),
): Promise<CodexRuntimeRecord[]> {
    const unchecked = records.filter(record => !knownLive.has(generationKey(record)));
    if (!unchecked.length) return records;
    const pids = [...new Set(unchecked.flatMap(record => [record.pid, ...(record.serverPid ? [record.serverPid] : [])]))];
    const windows = isWindows();
    const table = windows ? await readWindowsProcessTable(10_000, pids) : null;
    if (windows && !table) {
        logger.warn(`[RUNNER RUN] Cannot verify Windows runtimes during stop of ${sessionId}: empty process snapshot`);
        // Unknown liveness preserves sibling protection but is never cached.
        return records;
    }
    const markers = new Map<number, string | null>();
    if (table) {
        for (const [pid, entry] of table) markers.set(pid, entry.marker);
    }
    const observed = new Set<number>();
    const observePosix = (pid: number) => {
        if (table || observed.has(pid)) return;
        observed.add(pid);
        if (isProcessAlive(pid)) markers.set(pid, getProcessStartMarker(pid));
    };
    return records.filter(record => {
        const key = generationKey(record);
        if (knownLive.has(key)) return true;
        observePosix(record.pid);
        const rootMatches = Boolean(record.marker && markers.get(record.pid) === record.marker);
        const serverPid = record.kind !== 'attached' ? record.serverPid : undefined;
        if (!rootMatches && serverPid) observePosix(serverPid);
        if (rootMatches || (serverPid && record.serverMarker && markers.get(serverPid) === record.serverMarker)) {
            knownLive.add(key);
            return true;
        }
        return runtimeMayBeAlive(record, markers);
    });
}
