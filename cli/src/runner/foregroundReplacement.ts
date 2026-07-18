import type { Readable } from 'node:stream'

export const FOREGROUND_REPLACEMENT_READY = 'HAPI_FOREGROUND_REPLACEMENT_READY_V1'

export async function waitForForegroundReplacementReady(options: {
    stdout: Readable
    exited: Promise<void>
    timeoutMs: number
}): Promise<boolean> {
    let buffered = ''
    let settleReady!: (ready: boolean) => void
    const ready = new Promise<boolean>((resolve) => { settleReady = resolve })
    const onData = (chunk: Buffer | string) => {
        buffered += chunk.toString()
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        settleReady(buffered.slice(0, newline).trim() === FOREGROUND_REPLACEMENT_READY)
    }
    options.stdout.on('data', onData)

    let timeout: NodeJS.Timeout | null = null
    const timedOut = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), options.timeoutMs)
        timeout.unref()
    })

    try {
        return await Promise.race([
            ready,
            options.exited.then(() => false),
            timedOut
        ])
    } finally {
        if (timeout) clearTimeout(timeout)
        options.stdout.off('data', onData)
    }
}

export async function waitForOldRunnerThenStart(options: {
    oldPid: number
    isAlive(pid: number): boolean
    startRunner(): Promise<boolean>
    sleep(ms: number): Promise<void>
    waitTimeoutMs: number
    maxStartAttempts: number
}): Promise<boolean> {
    const deadline = Date.now() + options.waitTimeoutMs
    while (options.isAlive(options.oldPid)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        await options.sleep(Math.min(100, remaining))
    }

    for (let attempt = 0; attempt < options.maxStartAttempts; attempt++) {
        if (await options.startRunner()) return true
        if (attempt + 1 < options.maxStartAttempts) await options.sleep(250)
    }
    return false
}
