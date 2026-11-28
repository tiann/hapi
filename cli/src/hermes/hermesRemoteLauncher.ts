import React from 'react'
import { setTimeout as delay } from 'node:timers/promises'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { HermesPermissionMode } from '@hapi/protocol/modes'
import { createAcpSessionTitleSync, registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { createHermesBackend } from './utils/hermesBackend'
import { resolveHermesConfigModels } from './utils/hermesConfiguredModels'
import type { HermesSession } from './session'

function mapPermissionModeToHermesAcpMode(mode: HermesPermissionMode | undefined): string {
    switch (mode) {
        case 'yolo':
            return 'dont_ask'
        case 'safe-yolo':
            return 'accept_edits'
        case 'read-only':
        case 'default':
        default:
            return 'default'
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }))
}

function isClosedTransportError(
    backend: ReturnType<typeof createHermesBackend>,
    error: unknown
): boolean {
    if (isAcpIndeterminateError(error)) return true
    if (typeof (backend as { isTransportAlive?: () => boolean }).isTransportAlive === 'function'
        && !(backend as { isTransportAlive: () => boolean }).isTransportAlive()) {
        return true
    }
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
    return message.includes('acp transport is closed')
        || message.includes('acp transport not initialized')
        || message.includes('acp transport closed')
        || message.includes('acp process exited')
}

export function parseHermesModelSlashCommand(text: string): string | null {
    const trimmed = text.trim()
    if (trimmed.includes('\n') || trimmed.includes('\r')) {
        return null
    }
    const match = /^\/model[ \t]+(\S.*)$/i.exec(trimmed)
    return match ? match[1].trim() : null
}

export class HermesRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createHermesBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private happyServer: { stop: () => void } | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    private currentBackendModelRevision: number | undefined = undefined
    private initialBackendModel: string | null = null
    private currentBackendAcpMode: string | null = null
    private activeTurnPermissionMode: HermesPermissionMode | undefined = undefined

    constructor(
        private readonly session: HermesSession,
        private readonly opts: {
            model?: string
            initialModelRevision?: number
            onModelRollback?: (model: string | null, revision?: number) => void
            onConfigDiscovered?: (model: string | null, revision?: number) => void
            onModelChanged?: (model: string | null, revision?: number) => number | null | void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() })
    }

    async kill(): Promise<void> {
        if (!this.backend) return
        await this.runAbortUnderBarrier(() => this.handleAbort(true))
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'Hermes'
        })
    }

    protected async runMainLoop(): Promise<void> {
        const titleSync = createAcpSessionTitleSync(this.session.client)
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(this.session.client, {
            onChangeTitle: () => titleSync.markManualTitle(),
            skillLookup: { workingDirectory: this.session.path, flavor: 'hermes' }
        })
        this.happyServer = happyServer

        let backend = createHermesBackend()
        this.backend = backend
        this.attachBackendListeners(backend, titleSync)

        // Register catalog RPC before initialize() so a picker opened during
        // startup parks on readiness instead of hitting an unregistered-method error.
        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        void ready.catch(() => {})
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListHermesModels, async () => {
            let acpSessionId: string
            try {
                acpSessionId = await ready
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `Hermes session is not available: ${message}` }
            }
            const activeBackend = this.backend ?? backend
            const metadata = activeBackend.getSessionModelsMetadata(acpSessionId)
            const currentModelId = this.currentBackendModel ?? metadata?.currentModelId ?? null
            const configuredModels = resolveHermesConfigModels(undefined, currentModelId)
            const availableModels = configuredModels ?? metadata?.availableModels ?? []
            if (availableModels.length === 0) {
                return { success: false, error: 'Hermes model metadata is not available' }
            }
            return {
                success: true,
                availableModels,
                currentModelId
            }
        })

        const acpMcpServers = toAcpMcpServers(mcpServers)
        let acpSessionId: string
        try {
            await backend.initialize()

            const resumeSessionId = this.session.sessionId
            if (resumeSessionId) {
                try {
                    await backend.loadSession({
                        sessionId: resumeSessionId,
                        cwd: this.session.path,
                        mcpServers: acpMcpServers
                    })
                    acpSessionId = resumeSessionId
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[hermes-acp] loadSession failed', error)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: `Hermes resume failed: ${message}`
                    })
                    this.messageBuffer.addMessage(`Hermes resume failed: ${message}`, 'status')
                    throw error
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    mcpServers: acpMcpServers
                })
            }
            this.session.onSessionFound(acpSessionId)
        } catch (error) {
            markFailed(error)
            throw error
        }

        const discoveredModel = backend.getSessionModelsMetadata(acpSessionId)?.currentModelId ?? null
        const initialRevision = this.opts.initialModelRevision
        this.initialBackendModel = discoveredModel
        this.currentBackendModel = discoveredModel
        this.currentBackendModelRevision = initialRevision

        if (this.opts.model && this.opts.model !== discoveredModel) {
            try {
                await backend.setModel(acpSessionId, this.opts.model, { flavor: 'hermes' })
                this.currentBackendModel = this.opts.model
            } catch (err) {
                logger.debug('[hermes-acp] initial setModel failed', err)
                this.opts.onModelRollback?.(this.currentBackendModel, initialRevision)
            }
        }
        this.opts.onConfigDiscovered?.(this.currentBackendModel, initialRevision)
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        markReady(acpSessionId)
        if (typeof this.session.client.emitSessionReady === 'function') {
            this.session.client.emitSessionReady()
        }

        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.activeTurnPermissionMode ?? (this.session.getPermissionMode() as HermesPermissionMode | undefined)
        )
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        }, () => this.abortController.abort(), () => {
            if (this.abortController.signal.aborted) {
                this.abortController = new AbortController()
            }
        })

        let retryDelay = 1000
        let consecutiveReconnects = 0
        const recoverFromClosedTransport = async (
            cause: unknown,
            uncommittedBatch?: NonNullable<Awaited<ReturnType<HermesSession['queue']['waitForDeferredBatch']>>>
        ): Promise<ReturnType<typeof createHermesBackend>> => {
            if (consecutiveReconnects < 1) {
                consecutiveReconnects += 1
                try {
                    return await this.reconnectBackend(acpSessionId, acpMcpServers, titleSync)
                } catch (reconnectError) {
                    if (uncommittedBatch) {
                        this.session.queue.releaseBatch(uncommittedBatch)
                    }
                    const message = reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
                    logger.warn('[hermes-acp] transport reconnect failed', { message })
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: `Hermes transport closed: ${message}`
                    })
                    this.messageBuffer.addMessage(`Hermes transport closed: ${message}`, 'status')
                    throw reconnectError
                }
            }
            if (uncommittedBatch) {
                this.session.queue.releaseBatch(uncommittedBatch)
            }
            const message = cause instanceof Error ? cause.message : String(cause)
            logger.warn('[hermes-acp] transport closed repeatedly', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Hermes transport closed: ${message}`
            })
            this.messageBuffer.addMessage(`Hermes transport closed: ${message}`, 'status')
            throw cause instanceof Error ? cause : new Error(message)
        }

        while (!this.shouldExit) {
            await this.waitForAbortBarrier()
            if (this.shouldExit) break
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForDeferredBatch(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }

            if (typeof (backend as { isTransportAlive?: () => boolean }).isTransportAlive === 'function'
                && !(backend as { isTransportAlive: () => boolean }).isTransportAlive()) {
                if (this.shouldExit || this.session.queue.isClosed()) {
                    this.session.queue.releaseBatch(batch)
                    break
                }
                backend = await recoverFromClosedTransport(new Error('ACP transport is closed'), batch)
                this.session.queue.unshiftBatch(batch)
                continue
            }

            try {
                await this.syncAcpPermissionMode(backend, acpSessionId, batch.mode.permissionMode)
                retryDelay = 1000
            } catch (error) {
                if (this.shouldExit || this.session.queue.isClosed()) {
                    this.session.queue.releaseBatch(batch)
                    break
                }
                if (isClosedTransportError(backend, error)) {
                    backend = await recoverFromClosedTransport(error, batch)
                    retryDelay = 1000
                    this.session.queue.unshiftBatch(batch)
                    continue
                }
                this.session.queue.unshiftBatch(batch)
                if (retryDelay === 1000) this.session.sendSessionEvent({
                    type: 'message', message: `Hermes permission change failed. Prompt remains queued for retry or cancellation: ${error}`
                })
                await delay(retryDelay, undefined, { signal }).catch(() => {})
                retryDelay = Math.min(retryDelay * 2, 10000)
                continue
            }

            if (this.shouldExit) {
                this.session.queue.releaseBatch(batch)
                break
            }
            if (signal.aborted) {
                await this.waitForAbortBarrier()
                if (this.shouldExit || this.session.queue.isClosed()) {
                    this.session.queue.releaseBatch(batch)
                    break
                }
                this.session.queue.unshiftBatch(batch)
                continue
            }

            const slashModelTarget = parseHermesModelSlashCommand(batch.message)
            if (slashModelTarget !== null) {
                if (this.shouldExit) {
                    this.session.queue.releaseBatch(batch)
                    break
                }
                if (signal.aborted) {
                    await this.waitForAbortBarrier()
                    if (this.shouldExit || this.session.queue.isClosed()) {
                        this.session.queue.releaseBatch(batch)
                        break
                    }
                    this.session.queue.unshiftBatch(batch)
                    continue
                }

                try {
                    await backend.setModel(acpSessionId, slashModelTarget, { flavor: 'hermes' })
                } catch (err) {
                    if (isClosedTransportError(backend, err)) {
                        if (this.shouldExit || this.session.queue.isClosed()) {
                            this.session.queue.releaseBatch(batch)
                            break
                        }
                        backend = await recoverFromClosedTransport(err, batch)
                        this.session.queue.unshiftBatch(batch)
                        continue
                    }
                    const message = err instanceof Error ? err.message : String(err)
                    logger.warn('[hermes-acp] /model switch failed', { message })
                    this.session.queue.commitBatch(batch)
                    this.messageBuffer.addMessage(batch.message, 'user')
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: `Hermes model switch failed: ${message}`
                    })
                    this.messageBuffer.addMessage(`Hermes model switch failed: ${message}`, 'status')
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }

                if (signal.aborted) {
                    await this.waitForAbortBarrier()
                    if (this.shouldExit || this.session.queue.isClosed()) {
                        this.session.queue.releaseBatch(batch)
                        break
                    }
                    this.session.queue.unshiftBatch(batch)
                    continue
                }

                consecutiveReconnects = 0
                this.session.queue.commitBatch(batch)
                this.currentBackendModel = slashModelTarget
                const nextRev = this.opts.onModelChanged?.(slashModelTarget, batch.mode.modelRevision)
                if (typeof nextRev === 'number') {
                    this.currentBackendModelRevision = nextRev
                } else if (batch.mode.modelRevision !== undefined) {
                    this.currentBackendModelRevision = batch.mode.modelRevision
                }
                this.messageBuffer.addMessage(batch.message, 'user')
                this.messageBuffer.addMessage(`[MODEL:${slashModelTarget}]`, 'system')
                this.handleAgentMessage({ type: 'text', text: `Switched model to ${slashModelTarget}` })
                if (this.session.queue.size() === 0 && !this.shouldExit) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
                continue
            }

            const requestedModel = batch.mode.model
            const isStaleBatchModel = batch.mode.modelRevision !== undefined
                && this.currentBackendModelRevision !== undefined
                && batch.mode.modelRevision < this.currentBackendModelRevision
            if (!isStaleBatchModel) {
                if (requestedModel === null) {
                    if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                        try {
                            await backend.setModel(acpSessionId, this.initialBackendModel, { flavor: 'hermes' })
                            this.currentBackendModel = this.initialBackendModel
                            if (batch.mode.modelRevision !== undefined) {
                                this.currentBackendModelRevision = batch.mode.modelRevision
                            }
                            this.messageBuffer.addMessage(`[MODEL:${this.initialBackendModel}]`, 'system')
                        } catch (err) {
                            if (isClosedTransportError(backend, err)) {
                                if (this.shouldExit || this.session.queue.isClosed()) {
                                    this.session.queue.releaseBatch(batch)
                                    break
                                }
                                backend = await recoverFromClosedTransport(err, batch)
                                this.session.queue.unshiftBatch(batch)
                                continue
                            }
                            logger.debug('[hermes-acp] reset setModel failed', err)
                            this.opts.onModelRollback?.(this.currentBackendModel, batch.mode.modelRevision)
                        }
                    } else if (batch.mode.modelRevision !== undefined) {
                        this.currentBackendModelRevision = batch.mode.modelRevision
                    }
                } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                    try {
                        await backend.setModel(acpSessionId, requestedModel, { flavor: 'hermes' })
                        this.currentBackendModel = requestedModel
                        if (batch.mode.modelRevision !== undefined) {
                            this.currentBackendModelRevision = batch.mode.modelRevision
                        }
                        this.messageBuffer.addMessage(`[MODEL:${requestedModel}]`, 'system')
                    } catch (err) {
                        if (isClosedTransportError(backend, err)) {
                            if (this.shouldExit || this.session.queue.isClosed()) {
                                this.session.queue.releaseBatch(batch)
                                break
                            }
                            backend = await recoverFromClosedTransport(err, batch)
                            this.session.queue.unshiftBatch(batch)
                            continue
                        }
                        logger.debug('[hermes-acp] setModel failed', err)
                        this.opts.onModelRollback?.(this.currentBackendModel, batch.mode.modelRevision)
                    }
                } else if (batch.mode.modelRevision !== undefined) {
                    this.currentBackendModelRevision = batch.mode.modelRevision
                }
            }

            if (this.shouldExit) {
                this.session.queue.releaseBatch(batch)
                break
            }
            if (signal.aborted) {
                await this.waitForAbortBarrier()
                if (this.shouldExit || this.session.queue.isClosed()) {
                    this.session.queue.releaseBatch(batch)
                    break
                }
                this.session.queue.unshiftBatch(batch)
                continue
            }

            const prompt: PromptContent[] = [{ type: 'text', text: batch.message }]
            let batchDispatched = false
            const markDispatched = () => {
                if (batchDispatched) return
                batchDispatched = true
                consecutiveReconnects = 0
                this.session.queue.commitBatch(batch)
                this.session.onThinkingChange(true)
                this.messageBuffer.addMessage(batch.message, 'user')
            }
            let promptClosedTransportError: unknown = null
            this.activeTurnPermissionMode = batch.mode.permissionMode
                ?? (this.session.getPermissionMode() as HermesPermissionMode | undefined)
            try {
                const isAlive = () =>
                    typeof (backend as { isTransportAlive?: () => boolean }).isTransportAlive !== 'function'
                    || (backend as { isTransportAlive: () => boolean }).isTransportAlive()
                const sent = await backend.prompt(
                    acpSessionId,
                    prompt,
                    (message) => {
                        markDispatched()
                        this.handleAgentMessage(message)
                    },
                    {
                        shouldSend: () => !this.shouldExit && !signal.aborted && isAlive(),
                        timing: {
                            onSent: markDispatched
                        }
                    }
                )
                if (sent === false) {
                    await this.waitForAbortBarrier()
                    if (this.shouldExit || this.session.queue.isClosed()) {
                        this.session.queue.releaseBatch(batch)
                        break
                    }
                    if (!signal.aborted && !isAlive()) {
                        promptClosedTransportError = new Error('ACP transport is closed')
                    } else {
                        this.session.queue.unshiftBatch(batch)
                        continue
                    }
                } else {
                    markDispatched()
                }
            } catch (error) {
                if (isClosedTransportError(backend, error)) {
                    promptClosedTransportError = error
                } else {
                    markDispatched()
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[hermes-acp] prompt failed', { message })
                    this.session.sendSessionEvent({ type: 'message', message: `Hermes prompt failed: ${message}` })
                    this.messageBuffer.addMessage(`Hermes prompt failed: ${message}`, 'status')
                }
            } finally {
                this.activeTurnPermissionMode = undefined
                if (batchDispatched) {
                    this.session.onThinkingChange(false)
                    await this.permissionHandler?.cancelAll('Prompt finished')
                }
            }

            if (promptClosedTransportError !== null) {
                if (this.shouldExit || this.session.queue.isClosed()) {
                    if (!batchDispatched) {
                        this.session.queue.releaseBatch(batch)
                    }
                    break
                }
                if (!batchDispatched) {
                    backend = await recoverFromClosedTransport(promptClosedTransportError, batch)
                    this.session.queue.unshiftBatch(batch)
                    continue
                }
                const message = promptClosedTransportError instanceof Error
                    ? promptClosedTransportError.message
                    : String(promptClosedTransportError)
                logger.warn('[hermes-acp] prompt transport failed after dispatch', { message })
                this.session.sendSessionEvent({ type: 'message', message: `Hermes prompt failed: ${message}` })
                this.messageBuffer.addMessage(`Hermes prompt failed: ${message}`, 'status')
                backend = await recoverFromClosedTransport(promptClosedTransportError)
            }

            if (this.session.queue.size() === 0 && !this.shouldExit) {
                this.session.sendSessionEvent({ type: 'ready' })
            }
        }
    }

    private attachBackendListeners(
        backend: ReturnType<typeof createHermesBackend>,
        titleSync: ReturnType<typeof createAcpSessionTitleSync>
    ): void {
        registerAcpSessionTitleSync(backend, this.session.client, titleSync)
        backend.onStderrError((error) => {
            logger.debug('[hermes-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })
    }

    private async reconnectBackend(
        acpSessionId: string,
        acpMcpServers: McpServerStdio[],
        titleSync: ReturnType<typeof createAcpSessionTitleSync>
    ): Promise<ReturnType<typeof createHermesBackend>> {
        this.activeTurnPermissionMode = undefined
        await this.permissionHandler?.cancelAll('Transport closed')
        this.permissionHandler = null
        await this.backend?.disconnect().catch(() => {})
        this.backend = null
        this.currentBackendAcpMode = null

        const nextBackend = createHermesBackend()
        this.backend = nextBackend
        this.attachBackendListeners(nextBackend, titleSync)
        await nextBackend.initialize()
        await nextBackend.loadSession({
            sessionId: acpSessionId,
            cwd: this.session.path,
            mcpServers: acpMcpServers
        })
        const discoveredModel = nextBackend.getSessionModelsMetadata(acpSessionId)?.currentModelId ?? null
        const desiredModel = this.currentBackendModel
        this.currentBackendModel = discoveredModel
        if (desiredModel && desiredModel !== discoveredModel) {
            try {
                await nextBackend.setModel(acpSessionId, desiredModel, { flavor: 'hermes' })
                this.currentBackendModel = desiredModel
            } catch (err) {
                logger.debug('[hermes-acp] reconnect setModel failed', err)
                this.opts.onModelRollback?.(this.currentBackendModel, this.currentBackendModelRevision)
            }
        }
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            nextBackend,
            () => this.activeTurnPermissionMode ?? (this.session.getPermissionMode() as HermesPermissionMode | undefined)
        )
        return nextBackend
    }

    protected async cleanup(): Promise<void> {
        this.activeTurnPermissionMode = undefined
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        await this.backend?.disconnect()
        this.backend = null
        this.happyServer?.stop()
        this.happyServer = null
    }

    private async syncAcpPermissionMode(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        permissionMode: HermesPermissionMode | undefined
    ): Promise<void> {
        const targetAcpMode = mapPermissionModeToHermesAcpMode(permissionMode)
        if (targetAcpMode === this.currentBackendAcpMode) return
        try {
            await backend.setMode(acpSessionId, targetAcpMode)
            this.currentBackendAcpMode = targetAcpMode
        } catch (err) {
            this.currentBackendAcpMode = null
            throw err
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                if (message.live) break
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
                break
            case 'usage':
            case 'reasoning':
            case 'tool_call':
            case 'tool_result':
            case 'plan':
            case 'round_summary':
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    private async handleAbort(terminal = false): Promise<void> {
        this.abortController.abort()
        this.abortController = new AbortController()
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        if (terminal) this.session.queue.reset()
        this.session.onThinkingChange(false)
        this.abortController.abort()
        this.abortController = new AbortController()
    }

    private handleExitFromUi(): void {
        void this.requestExit('exit', () => this.handleAbort(true))
    }
}
