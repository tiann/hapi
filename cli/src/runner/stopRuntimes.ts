import { type CodexRuntimeRecord, runtimeMayBeAlive } from '@/codex/shared/registry';
import { isWindows } from '@/utils/process';
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
    if (!isWindows()) return records.filter(runtime => runtimeMayBeAlive(runtime));
    const unchecked = records.filter(record => !knownLive.has(generationKey(record)));
    if (!unchecked.length) return records;
    const pids = [...new Set(unchecked.flatMap(record => [record.pid, ...(record.serverPid ? [record.serverPid] : [])]))];
    const table = await readWindowsProcessTable(10_000, pids);
    if (!table) {
        logger.warn(`[RUNNER RUN] Cannot verify Windows runtimes during stop of ${sessionId}: empty process snapshot`);
        // Unknown liveness preserves sibling protection but is never cached.
        return records;
    }
    return records.filter(record => {
        const key = generationKey(record);
        if (knownLive.has(key)) return true;
        if ((record.marker && table.get(record.pid)?.marker === record.marker)
            || (record.kind !== 'attached' && record.serverPid && record.serverMarker
                && table.get(record.serverPid)?.marker === record.serverMarker)) {
            knownLive.add(key);
            return true;
        }
        return runtimeMayBeAlive(record, table);
    });
}
