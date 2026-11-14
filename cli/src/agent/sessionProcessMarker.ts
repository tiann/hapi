import { readFileSync } from 'node:fs'
import { getProcessStartMarker, getSystemBootId } from '@/utils/process'

/** Lease identity on Linux comes from the kernel, including installations without ps. */
export function getSessionProcessMarker(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    if (process.platform !== 'linux') return getProcessStartMarker(pid)
    const bootId = getSystemBootId()
    if (!bootId) return null
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const end = stat.lastIndexOf(')')
        if (!stat.startsWith(`${pid} (`) || end < `${pid} (`.length) return null
        // comm (field 2) can contain spaces and parentheses; starttime is field 22.
        const start = stat.slice(end + 1).trim().split(/\s+/)[19]
        return start && /^\d+$/.test(start) ? `linux:${bootId}:${start}` : null
    } catch {
        return null
    }
}
