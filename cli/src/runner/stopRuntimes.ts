import { type CodexRuntimeRecord, runtimeMayBeAlive } from '@/codex/shared/registry';
import { isWindows } from '@/utils/process';
import { listWindowsProcessesWithCommandLine } from './orphanReap';
import { logger } from '@/ui/logger';

/** Registry candidates used only for stop-time shared-root protection. */
export function readStopRuntimeCandidates(records: CodexRuntimeRecord[], sessionId: string): CodexRuntimeRecord[] {
    let markers: ReadonlyMap<number, string | null> | undefined;
    if (isWindows() && records.length > 0) {
        try {
            const processes = listWindowsProcessesWithCommandLine();
            if (!processes.length) throw new Error('Empty Windows process snapshot');
            markers = new Map(processes.map(proc => [proc.pid, proc.startMarker ?? null]));
        } catch (error) {
            logger.warn(`[RUNNER RUN] Cannot verify Windows runtimes during stop of ${sessionId}: ${String(error)}`);
            // Unknown liveness preserves sibling protection for these PIDs,
            // but must not prevent stopping an unrelated, identified target.
            return records;
        }
    }
    return records.filter(runtime => runtimeMayBeAlive(runtime, markers));
}
