import { type CodexRuntimeRecord, runtimeMayBeAlive } from '@/codex/shared/registry';
import { isWindows } from '@/utils/process';
import { readWindowsProcessTable } from '@/utils/windowsProcessStop';
import { logger } from '@/ui/logger';

/** Registry candidates used only for stop-time shared-root protection. */
export async function readStopRuntimeCandidates(records: CodexRuntimeRecord[], sessionId: string): Promise<CodexRuntimeRecord[]> {
    let markers: ReadonlyMap<number, string | null> | undefined;
    if (isWindows() && records.length > 0) {
        try {
            const pids = [...new Set(records.flatMap(record => [
                record.pid,
                ...(record.serverPid ? [record.serverPid] : []),
            ]))];
            const table = await readWindowsProcessTable(10_000, pids);
            if (!table || table.size === 0) throw new Error('Empty Windows process snapshot');
            markers = new Map([...table].map(([pid, entry]) => [pid, entry.marker ?? null]));
        } catch (error) {
            logger.warn(`[RUNNER RUN] Cannot verify Windows runtimes during stop of ${sessionId}: ${String(error)}`);
            // Unknown liveness preserves sibling protection for these PIDs,
            // but must not prevent stopping an unrelated, identified target.
            return records;
        }
    }
    return records.filter(runtime => runtimeMayBeAlive(runtime, markers));
}
