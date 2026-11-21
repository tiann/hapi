import type { WorkerInspection } from '@hapi/protocol/rpcMethods'
import { getProcessStartMarker, isWindows } from '@/utils/process'
import { readWindowsProcessTable } from '@/utils/windowsProcessStop'

export async function inspectWorkerGeneration(pid: number, expected: string): Promise<WorkerInspection['state']> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || !expected) return 'unknown'
    let marker: string | null
    if (isWindows()) {
        const table = await readWindowsProcessTable(5_000, [pid])
        if (!table) return 'unknown'
        const entry = table.get(pid)
        if (!entry) return 'gone'
        marker = entry.marker
    } else {
        marker = getProcessStartMarker(pid)
        if (!marker) {
            try { process.kill(pid, 0) } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
            }
        }
    }
    return !marker ? 'unknown' : marker === expected ? 'matching' : 'replaced'
}
