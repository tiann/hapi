/** A late RPC retry joins the original stop instead of racing its tree signals. */
export function coalesceStopRequests<T>(stop: (id: string, opts?: { processStartMarker?: string }) => Promise<T>) {
    const pending = new Map<string, Promise<T>>()
    return async (id: string, opts?: { processStartMarker?: string }): Promise<T> => {
        // Raw PID calls from different generations must never share evidence.
        const key = JSON.stringify([id, opts?.processStartMarker ?? null])
        const existing = pending.get(key)
        if (existing) return existing
        const operation = stop(id, opts)
        pending.set(key, operation)
        try { return await operation } finally {
            if (pending.get(key) === operation) pending.delete(key)
        }
    }
}
