import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { logger } from '@/ui/logger'
import { CodexAppServerClient } from '../codexAppServerClient'
import { AttachedIneligibleThreadError, loadedThreadIds, runAttachedRuntime, validateAttachedEndpoint, type AttachedStopReason } from './attached'
import { AttachedHistoryChangedError } from './attachedHistory'
import { string } from './gateway'

type DesktopSyncOptions = {
    signal: AbortSignal
    discover: () => Promise<Set<string>>
    attach: (threadId: string, ready: () => void, signal: AbortSignal) => Promise<AttachedStopReason>
    checkSettings?: () => Promise<void>
    report?: (message: string) => void
    pollMs?: number
    retryMs?: number
}

/** One discovery connection, and one independently fenced bridge per loaded root. */
export async function superviseDesktopThreads({ signal, discover, attach, checkSettings, report, pollMs = 1_000, retryMs = 15_000 }: DesktopSyncOptions): Promise<void> {
    const workers = new Map<string, { abort: AbortController; task: Promise<void> }>()
    const retryAt = new Map<string, number>()
    let starting = false
    let discoveryError: string | undefined
    const stopWorkers = () => { for (const { abort } of workers.values()) abort.abort() }
    signal.addEventListener('abort', stopWorkers, { once: true })

    try {
        while (!signal.aborted) {
            // A credentials/settings change must close existing subscriptions
            // before discovery can publish anything to an outdated Hub.
            await checkSettings?.()
            let loaded: Set<string> | undefined
            try {
                loaded = await discover()
                discoveryError = undefined
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (discoveryError !== message && !signal.aborted) report?.(`Waiting for the desktop daemon: ${message}`)
                discoveryError = message
            }
            if (signal.aborted) break
            if (loaded) {
                const current = loaded
                for (const threadId of retryAt.keys()) if (!current.has(threadId)) retryAt.delete(threadId)
                for (const [threadId, worker] of workers) if (!current.has(threadId)) worker.abort.abort()
                const next = !starting && [...current].find(id => !workers.has(id) && (retryAt.get(id) ?? 0) <= Date.now())
                if (next) {
                    const abort = new AbortController()
                    starting = true
                    let started = false
                    const task = Promise.resolve().then(() => attach(next, () => {
                        started = true
                        starting = false
                    }, abort.signal)).then(reason => {
                        if (!abort.signal.aborted) retryAt.set(next, reason === 'unavailable' ? Date.now() + retryMs : Infinity)
                    }, error => {
                        if (abort.signal.aborted) return
                        const held = error instanceof AttachedHistoryChangedError || error instanceof AttachedIneligibleThreadError
                        retryAt.set(next, held ? Infinity : Date.now() + retryMs)
                        if (!(error instanceof AttachedIneligibleThreadError)) {
                            report?.(`Could not sync a desktop session: ${error instanceof Error ? error.message : String(error)}`)
                        }
                    }).finally(() => {
                        if (!started) starting = false
                        workers.delete(next)
                    })
                    workers.set(next, { abort, task })
                }
            }
            await delay(pollMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error })
        }
    } finally {
        signal.removeEventListener('abort', stopWorkers)
        stopWorkers()
        await Promise.allSettled([...workers.values()].map(worker => worker.task))
    }
}

export async function syncCodexDesktop(home: string, signal: AbortSignal, checkSettings?: () => Promise<void>): Promise<void> {
    const endpoint = `unix://${join(home, 'app-server-control', 'app-server-control.sock')}`
    let discovery: CodexAppServerClient | undefined
    const close = async () => {
        const current = discovery
        discovery = undefined
        await current?.disconnect()
    }
    const onAbort = () => { void close().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
        await superviseDesktopThreads({
            signal,
            checkSettings,
            async discover() {
                try {
                    if (!discovery) {
                        const socket = await validateAttachedEndpoint(endpoint)
                        signal.throwIfAborted()
                        discovery = new CodexAppServerClient({ endpoint: socket })
                        const client = discovery
                        // Discovery never claims server requests or subscribes to a root.
                        client.setServerRequestHandler(() => {})
                        await client.connect()
                        const info = await client.initialize({ clientInfo: { name: 'hapi_desktop_sync', version: '1' }, capabilities: { experimentalApi: true } })
                        const nativeHome = string(info.codexHome)
                        if (!nativeHome || await realpath(nativeHome) !== await realpath(home)) {
                            throw new Error('Desktop daemon reported a different CODEX_HOME')
                        }
                    }
                    const loaded = new Set<string>()
                    for await (const id of loadedThreadIds(discovery)) loaded.add(id)
                    return loaded
                } catch (error) {
                    await close()
                    throw error
                }
            },
            attach: (threadId, ready, threadSignal) => runAttachedRuntime({ endpoint, threadId, desktopHome: home }, ready, threadSignal),
            report: message => logger.debug(`[Codex Desktop] ${message}`)
        })
    } finally {
        signal.removeEventListener('abort', onAbort)
        await close()
    }
}
