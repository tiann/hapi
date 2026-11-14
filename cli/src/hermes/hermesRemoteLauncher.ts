import React from 'react'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { HermesPermissionMode } from '@hapi/protocol/modes'
import { createAcpSessionTitleSync, registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
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

export class HermesRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createHermesBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private happyServer: { stop: () => void } | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    private initialBackendModel: string | null = null
    private currentBackendAcpMode: string | null = null

    constructor(
        private readonly session: HermesSession,
        private readonly opts: {
            model?: string
            onModelRollback?: (model: string | null) => void
            onConfigDiscovered?: (model: string | null) => void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() })
    }

    async kill(): Promise<void> {
        if (!this.backend) return
        await this.handleAbort()
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

        const backend = createHermesBackend()
        this.backend = backend
        registerAcpSessionTitleSync(backend, this.session.client, titleSync)
        backend.onStderrError((error) => {
            logger.debug('[hermes-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        // Register catalog RPC before initialize() so a picker opened during
        // startup parks on readiness instead of hitting an unregistered-method error.
        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListHermesModels, async () => {
            let acpSessionId: string
            try {
                acpSessionId = await ready
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `Hermes session is not available: ${message}` }
            }
            const metadata = backend.getSessionModelsMetadata(acpSessionId)
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
                    logger.warn('[hermes-acp] loadSession failed, starting a new session', error)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Hermes resume failed; starting a new session.'
                    })
                    acpSessionId = await backend.newSession({
                        cwd: this.session.path,
                        mcpServers: acpMcpServers
                    })
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
        this.initialBackendModel = discoveredModel
        this.currentBackendModel = discoveredModel

        if (this.opts.model && this.opts.model !== discoveredModel) {
            try {
                await backend.setModel(acpSessionId, this.opts.model, { flavor: 'hermes' })
                this.currentBackendModel = this.opts.model
            } catch (err) {
                logger.debug('[hermes-acp] initial setModel failed', err)
                this.opts.onModelRollback?.(this.currentBackendModel)
            }
        }
        this.opts.onConfigDiscovered?.(this.currentBackendModel)
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        markReady(acpSessionId)

        await this.syncAcpPermissionMode(
            backend,
            acpSessionId,
            this.session.getPermissionMode() as HermesPermissionMode | undefined
        )

        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as HermesPermissionMode | undefined
        )
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            const batch = await this.session.queue.waitForMessagesAndGetAsString(this.abortController.signal)
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) continue
                break
            }

            await this.syncAcpPermissionMode(backend, acpSessionId, batch.mode.permissionMode)

            const requestedModel = batch.mode.model
            if (requestedModel === null) {
                if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                    try {
                        await backend.setModel(acpSessionId, this.initialBackendModel, { flavor: 'hermes' })
                        this.currentBackendModel = this.initialBackendModel
                        this.messageBuffer.addMessage(`[MODEL:${this.initialBackendModel}]`, 'system')
                    } catch (err) {
                        logger.debug('[hermes-acp] reset setModel failed', err)
                        this.opts.onModelRollback?.(this.currentBackendModel)
                    }
                }
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                try {
                    await backend.setModel(acpSessionId, requestedModel, { flavor: 'hermes' })
                    this.currentBackendModel = requestedModel
                    this.messageBuffer.addMessage(`[MODEL:${requestedModel}]`, 'system')
                } catch (err) {
                    logger.debug('[hermes-acp] setModel failed', err)
                    this.opts.onModelRollback?.(this.currentBackendModel)
                }
            }

            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            const prompt: PromptContent[] = [{ type: 'text', text: batch.message }]
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[hermes-acp] prompt failed', { message })
                this.session.sendSessionEvent({ type: 'message', message: `Hermes prompt failed: ${message}` })
                this.messageBuffer.addMessage(`Hermes prompt failed: ${message}`, 'status')
            } finally {
                this.session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (this.session.queue.size() === 0 && !this.shouldExit) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
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
            logger.debug('[hermes-acp] setMode failed', err)
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

    private async handleAbort(): Promise<void> {
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.queue.reset()
        this.session.onThinkingChange(false)
        this.abortController.abort()
        this.abortController = new AbortController()
    }

    private handleExitFromUi(): void {
        void this.requestExit('exit', () => this.handleAbort())
    }
}
