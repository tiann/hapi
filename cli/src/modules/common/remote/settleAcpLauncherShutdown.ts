import { logger } from '@/ui/logger'

// Match the grace period for Antigravity's launcher settlement.
const SHUTDOWN_SETTLE_MS = 5_000

export async function settleAcpLauncherShutdown(options: {
    logTag: string
    cancel: () => Promise<void>
    disconnect: () => Promise<void> | undefined
    running: Promise<unknown>
}): Promise<void> {
    const { logTag, cancel, disconnect, running } = options
    const teardown = async () => {
        // Start cancellation first so the launcher records exit intent before disconnect.
        const cancelling = (async () => cancel())().catch((error) => {
            logger.debug(`[${logTag}] Error cancelling during shutdown`, error)
        })
        let disconnecting: Promise<void> | undefined
        try {
            disconnecting = disconnect()
        } catch (error) {
            disconnecting = Promise.reject(error)
        }
        // Once the backend and launcher have settled, a delayed cancel has nothing left to stop.
        const results = await Promise.allSettled([disconnecting ?? cancelling, running])
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.debug(`[${logTag}] Error during shutdown`, result.reason)
            }
        }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            teardown(),
            new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    logger.debug(`[${logTag}] Timed out waiting for shutdown`)
                    resolve()
                }, SHUTDOWN_SETTLE_MS)
            })
        ])
    } finally {
        clearTimeout(timer)
    }
}
