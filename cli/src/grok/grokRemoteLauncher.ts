import { randomUUID } from 'node:crypto'
import React from 'react'
import { logger } from '@/ui/logger'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { GrokDisplay } from '@/ui/ink/GrokDisplay'
import type { GrokSession } from './session'
import type { PermissionMode } from './types'
import {
    createGrokBackend,
    formatGrokError,
    isGrokBuildAuxiliaryQuotaError
} from './utils/grokBackend'
import { GrokPermissionHandler } from './utils/permissionHandler'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { GROK_TITLE_INSTRUCTION } from './utils/systemPrompt'

const PLAN_MODE_INSTRUCTION =
    'Work in plan-only mode. Analyze and propose a plan, but do not execute commands or modify files.'

type GrokRemoteLauncherOptions = {
    model?: string
    effort?: string
    onModelRollback?: (model: string | null) => void
    onEffortRollback?: (effort: string | null) => void
    onPermissionModeRollback?: (mode: PermissionMode) => void
    onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void
}

class GrokRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createGrokBackend> | null = null
    private permissionHandler: GrokPermissionHandler | null = null
    private happyServer: { stop: () => void } | null = null
    private abortController = new AbortController()
    private displayPermissionMode: PermissionMode | null = null
    private readonly lastDisplayedToolCall = new Map<string, string>()
    private currentBackendModel: string | null = null
    private defaultBackendModel: string | null = null
    private currentBackendEffort: string | null = null
    private defaultBackendEffort: string | null = null
    private currentBackendPermissionMode: 'default' | 'auto' | null = null
    private instructionsSent = false

    constructor(
        private readonly session: GrokSession,
        private readonly opts: GrokRemoteLauncherOptions
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        })
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(GrokDisplay, context)
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session
        const { server, mcpServers } = await buildHapiMcpBridge(session.client)
        this.happyServer = server

        const backend = createGrokBackend({
            cwd: session.path,
            ...this.opts
        })
        this.backend = backend
        backend.setSessionInfoUpdateListener(({ title }) => {
            if (typeof title !== 'string') return
            session.client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            })
        })
        backend.onStderrError((error) => {
            const activeModel = this.currentBackendModel ?? this.opts.model ?? null
            if (isGrokBuildAuxiliaryQuotaError(`${error.message}\n${error.raw}`, activeModel)) {
                logger.debug('[grok-remote] Suppressed non-fatal grok-build session-title quota error', {
                    activeModel
                })
                return
            }
            logger.debug('[grok-remote] stderr error', error)
            const message = formatGrokError(error.message)
            session.sendSessionEvent({ type: 'message', message })
            this.messageBuffer.addMessage(message, 'status')
        })

        await backend.initialize()

        const acpMcpServers = toAcpMcpServers(mcpServers)
        let acpSessionId: string
        try {
            if (session.sessionId) {
                try {
                    acpSessionId = await backend.loadSession({
                        sessionId: session.sessionId,
                        cwd: session.path,
                        mcpServers: acpMcpServers
                    })
                } catch (error) {
                    logger.warn('[grok-remote] resume failed, starting new session', error)
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'Grok resume failed; starting a new session.'
                    })
                    acpSessionId = await backend.newSession({
                        cwd: session.path,
                        mcpServers: acpMcpServers
                    })
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: acpMcpServers
                })
            }
        } catch (error) {
            const message = formatGrokError(error)
            session.sendSessionEvent({ type: 'message', message })
            throw new Error(message, { cause: error })
        }

        session.registerExistingNativeSession(acpSessionId)
        const modelMetadata = backend.getSessionModelsMetadata(acpSessionId)
        const effortMetadata = backend.getThoughtLevelConfigOption(acpSessionId)
        this.currentBackendModel = modelMetadata?.currentModelId ?? this.opts.model ?? null
        this.defaultBackendModel = this.currentBackendModel
        this.currentBackendEffort = effortMetadata?.currentValue ?? this.opts.effort ?? null
        this.defaultBackendEffort = this.currentBackendEffort
        this.opts.onConfigDiscovered?.({
            model: this.currentBackendModel,
            effort: this.currentBackendEffort
        })

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListGrokModels, async () => {
            const metadata = backend.getSessionModelsMetadata(acpSessionId)
            if (!metadata) return { success: false, error: 'Grok model metadata is not available' }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: metadata.currentModelId,
                autoPermissionModeSupported: backend.hasAvailableCommand(acpSessionId, 'auto')
            }
        })
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListGrokReasoningEffortOptions, async () => {
            const metadata = backend.getThoughtLevelConfigOption(acpSessionId)
            if (!metadata) return { success: false, error: 'Grok effort metadata is not available' }
            return {
                success: true,
                options: metadata.options,
                currentValue: metadata.currentValue ?? null
            }
        })
        this.permissionHandler = new GrokPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        )
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode | undefined)
        this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel ?? 'default'}]`, 'system')

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        })

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal)
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) continue
                break
            }

            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model
            if (requestedModel && requestedModel !== this.currentBackendModel) {
                try {
                    await backend.setModel(acpSessionId, requestedModel, { flavor: 'grok' })
                    this.currentBackendModel = requestedModel
                    batch.mode.model = requestedModel
                } catch (error) {
                    logger.warn('[grok-remote] Inline model switch failed', error)
                    this.rollbackModel(batch, this.currentBackendModel)
                    session.sendSessionEvent({
                        type: 'message',
                        message: `Failed to switch Grok model to ${requestedModel}.`
                    })
                }
            }

            const requestedEffort = batch.mode.effort === null
                ? this.defaultBackendEffort
                : batch.mode.effort
            if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
                try {
                    await backend.setMode(acpSessionId, requestedEffort)
                    this.currentBackendEffort = requestedEffort
                    batch.mode.effort = requestedEffort
                } catch (error) {
                    logger.warn('[grok-remote] Inline effort switch failed', error)
                    this.rollbackEffort(batch, this.currentBackendEffort)
                    session.sendSessionEvent({
                        type: 'message',
                        message: `Failed to switch Grok effort to ${requestedEffort}.`
                    })
                }
            }

            const requestedPermissionMode = batch.mode.permissionMode
            try {
                await this.syncBackendPermissionMode(acpSessionId, requestedPermissionMode)
            } catch (error) {
                logger.warn('[grok-remote] Inline permission mode switch failed', error)
                const fallbackMode: PermissionMode = this.currentBackendPermissionMode ?? 'default'
                this.rollbackPermissionMode(batch, fallbackMode)
                session.sendSessionEvent({
                    type: 'message',
                    message: requestedPermissionMode === 'auto'
                        ? 'Grok Auto permission mode is not enabled for this account or CLI build; using Default.'
                        : `Failed to switch Grok permission mode to ${requestedPermissionMode}.`
                })
            }

            this.applyDisplayMode(batch.mode.permissionMode)
            this.messageBuffer.addMessage(batch.message, 'user')
            const isSlashCommand = batch.message.trimStart().startsWith('/')
            let text = batch.mode.permissionMode === 'plan' && !isSlashCommand
                ? `${PLAN_MODE_INSTRUCTION}\n\n${batch.message}`
                : batch.message
            if (!this.instructionsSent && !isSlashCommand) {
                text = `${GROK_TITLE_INSTRUCTION}\n\n${text}`
                this.instructionsSent = true
            }
            const promptContent: PromptContent[] = [{ type: 'text', text }]

            session.onThinkingChange(true)
            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message)
                })
            } catch (error) {
                const message = formatGrokError(error)
                logger.warn('[grok-remote] prompt failed', error)
                session.sendSessionEvent({ type: 'message', message: `Grok prompt failed: ${message}` })
                this.messageBuffer.addMessage(`Grok prompt failed: ${message}`, 'status')
            } finally {
                session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (session.queue.size() === 0 && !this.shouldExit) {
                    session.sendSessionEvent({ type: 'ready' })
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        if (this.permissionHandler) {
            await this.permissionHandler.cancelAll('Session ended')
            this.permissionHandler = null
        }
        if (this.backend) {
            await this.backend.disconnect()
            this.backend = null
        }
        if (this.happyServer) {
            this.happyServer.stop()
            this.happyServer = null
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'reasoning':
                if (!message.live) {
                    this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system')
                }
                break
            case 'tool_call': {
                const previous = this.lastDisplayedToolCall.get(message.id)
                if (previous !== message.name) {
                    this.lastDisplayedToolCall.set(message.id, message.name)
                    this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool')
                }
                break
            }
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result')
                break
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status')
                break
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
                break
            case 'usage':
                break
            default: {
                const exhaustive: never = message
                return exhaustive
            }
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system')
        }
    }

    private rollbackModel(batch: { mode: { model?: string | null } }, model: string | null): void {
        batch.mode.model = model
        this.session.setModel(model)
        this.session.pushKeepAlive()
        this.opts.onModelRollback?.(model)
    }

    private rollbackEffort(batch: { mode: { effort?: string | null } }, effort: string | null): void {
        batch.mode.effort = effort
        this.session.setEffort(effort)
        this.session.pushKeepAlive()
        this.opts.onEffortRollback?.(effort)
    }

    private rollbackPermissionMode(
        batch: { mode: { permissionMode: PermissionMode } },
        permissionMode: PermissionMode
    ): void {
        batch.mode.permissionMode = permissionMode
        this.session.setPermissionMode(permissionMode)
        this.session.pushKeepAlive()
        this.opts.onPermissionModeRollback?.(permissionMode)
    }

    private async syncBackendPermissionMode(
        sessionId: string,
        permissionMode: PermissionMode
    ): Promise<void> {
        if (!this.backend) return

        if (permissionMode === 'auto') {
            if (this.currentBackendPermissionMode === 'auto') return
            if (!this.backend.hasAvailableCommand(sessionId, 'auto')) {
                await this.setBackendDefaultPermissionMode(sessionId)
                throw new Error('Grok did not advertise the /auto command')
            }
            await this.backend.prompt(
                sessionId,
                [{ type: 'text', text: '/auto' }],
                () => undefined
            )
            this.currentBackendPermissionMode = 'auto'
            return
        }

        await this.setBackendDefaultPermissionMode(sessionId)
    }

    private async setBackendDefaultPermissionMode(sessionId: string): Promise<void> {
        if (!this.backend || this.currentBackendPermissionMode === 'default') return
        await this.backend.prompt(
            sessionId,
            [{ type: 'text', text: '/always-approve off' }],
            () => undefined
        )
        this.currentBackendPermissionMode = 'default'
    }

    private async handleAbort(): Promise<void> {
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.queue.reset()
        this.session.onThinkingChange(false)
        this.abortController.abort()
        this.abortController = new AbortController()
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort())
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort())
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

export async function grokRemoteLauncher(
    session: GrokSession,
    opts: GrokRemoteLauncherOptions
): Promise<'switch' | 'exit'> {
    return new GrokRemoteLauncher(session, opts).launch()
}
