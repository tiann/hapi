import { logger } from '@/ui/logger'
import { Future } from '@/utils/future'
import { getLocalLaunchExitReason } from '@/agent/localLaunchPolicy'
import type { LocalLaunchExitReason, StartedBy } from '@/agent/localLaunchPolicy'

type QueueLike = {
    size(): number
    reset(): void
    setOnMessage(callback: ((...args: unknown[]) => void) | null): void
}

type RpcHandlerManagerLike = {
    registerHandler(method: string, handler: () => Promise<void> | void): void
}

export type LocalLauncherControl = {
    abortSignal: AbortSignal
    requestExit: () => void
    requestSwitch: () => void
    getExitReason: () => LocalLaunchExitReason | null
}

export type LocalLauncherOptions = {
    label: string
    failureLabel: string
    queue: QueueLike
    rpcHandlerManager: RpcHandlerManagerLike
    startedBy?: StartedBy
    startingMode?: 'local' | 'remote'
    launch: (signal: AbortSignal) => Promise<void>
    onLaunchSuccess?: () => Promise<void> | void
    sendFailureMessage: (message: string) => void
    recordLocalLaunchFailure: (message: string, exitReason: LocalLaunchExitReason) => void
    abortLogMessage?: string
    switchLogMessage?: string
}

export class BaseLocalLauncher {
    private exitReason: LocalLaunchExitReason | null = null
    private readonly abortController = new AbortController()
    private readonly exitFuture = new Future<void>()

    constructor(private readonly options: LocalLauncherOptions) {}

    get control(): LocalLauncherControl {
        return {
            abortSignal: this.abortController.signal,
            requestExit: this.requestExit,
            requestSwitch: this.requestSwitch,
            getExitReason: () => this.exitReason
        }
    }

    async run(): Promise<LocalLaunchExitReason> {
        const {
            label,
            failureLabel,
            queue,
            rpcHandlerManager,
            startedBy,
            startingMode,
            launch,
            onLaunchSuccess,
            sendFailureMessage,
            recordLocalLaunchFailure,
            abortLogMessage = 'abort requested',
            switchLogMessage = 'switch requested'
        } = this.options

        try {
            const abortProcess = async () => {
                if (!this.abortController.signal.aborted) {
                    this.abortController.abort()
                }
                await this.exitFuture.promise
            }

            const doAbort = async () => {
                logger.debug(`[${label}]: ${abortLogMessage}`)
                this.setExitReason('switch')
                queue.reset()
                await abortProcess()
            }

            const doSwitch = async () => {
                logger.debug(`[${label}]: ${switchLogMessage}`)
                this.setExitReason('switch')
                await abortProcess()
            }

            rpcHandlerManager.registerHandler('abort', doAbort)
            rpcHandlerManager.registerHandler('switch', doSwitch)
            queue.setOnMessage(() => {
                void doSwitch()
            })

            if (this.exitReason) {
                return this.exitReason
            }

            if (queue.size() > 0) {
                return 'switch'
            }

            while (true) {
                if (this.exitReason) {
                    return this.exitReason
                }

                logger.debug(`[${label}]: launch`)
                try {
                    await launch(this.abortController.signal)
                    if (onLaunchSuccess) {
                        await onLaunchSuccess()
                    }

                    if (!this.exitReason) {
                        this.exitReason = 'exit'
                        break
                    }
                } catch (error) {
                    logger.debug(`[${label}]: launch error`, error)
                    const message = error instanceof Error ? error.message : String(error)
                    const failureMessage = `${failureLabel}: ${message}`
                    
                    // Only send failure message if we are NOT switching
                    if ((this.exitReason as string) !== 'switch') {
                        sendFailureMessage(failureMessage)
                    }

                    const failureExitReason = this.exitReason ?? getLocalLaunchExitReason({
                        startedBy,
                        startingMode
                    })
                    recordLocalLaunchFailure(message, failureExitReason)
                    if (!this.exitReason) {
                        this.exitReason = failureExitReason
                    }
                    if (failureExitReason === 'exit') {
                        logger.warn(`[${label}]: ${failureMessage}`)
                    }
                    break
                }
            }
        } finally {
            this.exitFuture.resolve(undefined)
            rpcHandlerManager.registerHandler('abort', async () => {})
            rpcHandlerManager.registerHandler('switch', async () => {})
            queue.setOnMessage(null)
        }

        return this.exitReason || 'exit'
    }

    private requestExit = (): void => {
        this.setExitReason('exit')
        if (!this.abortController.signal.aborted) {
            this.abortController.abort()
        }
    }

    private requestSwitch = (): void => {
        this.setExitReason('switch')
        if (!this.abortController.signal.aborted) {
            this.abortController.abort()
        }
    }

    private setExitReason(reason: LocalLaunchExitReason): void {
        if (!this.exitReason) {
            this.exitReason = reason
        }
    }
}
