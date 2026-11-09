import React from 'react'
import { RPC_METHODS } from '@hapi/protocol'
import type { PermissionMode } from '@hapi/protocol/types'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { createBerryBackend } from './utils/berryBackend'
import type { BerrySession } from './session'

/** Berry ACP mode axis (`berry acp` session/set_mode). The ids land on Berry's
 * sandbox axis (default / read_only / accept_edits / dont_ask → workspace-write /
 * read-only / workspace-write / danger). Tool approvals still emit
 * request_permission in every mode — the HAPI-side bridge decides those. */
const BERRY_ACP_MODE_BY_PERMISSION: Record<string, string> = {
    default: 'default',
    'read-only': 'read_only',
    'safe-yolo': 'accept_edits',
    yolo: 'dont_ask'
}

export class BerryRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createBerryBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    private lastAppliedAcpMode: string | null = null
    private displayPermissionMode: PermissionMode | undefined

    constructor(
        private readonly session: BerrySession,
        private readonly opts: {
            /** Spawn-time model override (opaque ACP config-option value). */
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
            agentLabel: 'Berry'
        })
    }

    protected async runMainLoop(): Promise<void> {
        const backend = createBerryBackend()
        this.backend = backend
        // Native session_info_update titles are deliberately NOT mirrored:
        // the Hub owns Berry session titles, matching the other ACP flavors
        // without a native rename tool. Mirroring a native title into
        // metadata.summary would suppress the Hub's own title generation.
        backend.onStderrError((error) => {
            logger.debug('[berry-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session exists
        // and model discovery has settled.
        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListBerryModels, async () => {
            let acpSessionId: string
            try {
                acpSessionId = await ready
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `Berry session is not available: ${message}` }
            }
            const metadata = backend.getSessionModelsMetadata(acpSessionId)
            if (!metadata) {
                return { success: false, error: 'Berry model metadata is not available' }
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: this.currentBackendModel ?? metadata.currentModelId
            }
        })

        let acpSessionId: string
        try {
            await backend.initialize()

            const resumeSessionId = this.session.sessionId
            if (resumeSessionId) {
                try {
                    // Berry implements `session/resume`. The Hub remains the
                    // transcript source for the UI, so any replayed history is
                    // suppressed; without this every resume would duplicate
                    // the transcript.
                    if (!backend.supportsSessionResume()) {
                        throw new Error('Berry ACP server does not advertise session/resume')
                    }
                    acpSessionId = await backend.suppressUpdatesDuring(() =>
                        backend.resumeSession({
                            sessionId: resumeSessionId,
                            cwd: this.session.path,
                            mcpServers: []
                        })
                    )
                } catch (error) {
                    logger.warn('[berry-acp] resume failed, starting a new session', error)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Berry resume failed; starting a new session.'
                    })
                    acpSessionId = await backend.newSession({
                        cwd: this.session.path,
                        // The Berry ACP server configures its own tools; HAPI
                        // does not bridge MCP servers for it in v1.
                        mcpServers: []
                    })
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    // The Berry ACP server configures its own tools; HAPI
                    // does not bridge MCP servers for it in v1.
                    mcpServers: []
                })
            }
            this.session.onSessionFound(acpSessionId)
        } catch (error) {
            markFailed(error)
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        // Capture the server default BEFORE applying any override: an explicit
        // "Default" reset later in the session (queued as model: null) switches
        // back to this value; without it the reset would silently keep the
        // last explicitly-applied model.
        this.initialBackendModel = modelOption?.currentValue
            ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
            ?? null
        if (this.opts.model && modelOption) {
            this.currentBackendModel = await this.applyModelSwitch(backend, acpSessionId, this.opts.model)
        }
        if (!this.currentBackendModel) {
            this.currentBackendModel = this.initialBackendModel
        }
        this.opts.onConfigDiscovered?.(this.currentBackendModel)
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        markReady(acpSessionId)

        // Auto-approval consults the LIVE session mode: a mid-turn switch to
        // yolo starts auto-approving request_permission immediately, while the
        // Berry-side sandbox mode (session/set_mode) catches up at the next
        // turn boundary below.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined
        )
        this.applyDisplayMode(this.session.getPermissionMode() as PermissionMode | undefined)
        await this.applyBerryAcpMode(backend, acpSessionId, this.session.getPermissionMode() as PermissionMode | undefined)
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

            this.applyDisplayMode(batch.mode.permissionMode)
            if (batch.mode.permissionMode !== undefined) {
                const applied = await this.applyBerryAcpMode(backend, acpSessionId, batch.mode.permissionMode)
                if (!applied && batch.mode.permissionMode === 'read-only') {
                    // The sandbox is the only enforcement layer for read-only;
                    // a failed tightening must not fall through to prompting
                    // under the previous writable sandbox.
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Turn skipped: Berry did not accept the read-only sandbox switch.'
                    })
                    this.messageBuffer.addMessage('Turn skipped (read-only switch failed)', 'status')
                    continue
                }
            }

            const requestedModel = batch.mode.model
            if (requestedModel === null) {
                // Explicit "Default": switch back to the server default captured
                // at session creation. The web picker resets the session model
                // to null and the next queued turn carries it here.
                if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                    const applied = await this.applyModelSwitch(backend, acpSessionId, this.initialBackendModel)
                    if (applied) {
                        batch.mode.model = applied
                    } else {
                        batch.mode.model = this.currentBackendModel ?? undefined
                        this.opts.onModelRollback?.(this.currentBackendModel)
                    }
                } else if (!this.initialBackendModel) {
                    // Nothing captured to go back to — keep the running model and
                    // report it back so the picker does not claim "Default".
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Cannot reset the Berry model: the agent did not report a default model.'
                    })
                } else {
                    // Already running the default.
                    batch.mode.model = this.currentBackendModel ?? undefined
                }
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                const applied = await this.applyModelSwitch(backend, acpSessionId, requestedModel)
                if (applied) {
                    batch.mode.model = applied
                } else {
                    batch.mode.model = this.currentBackendModel ?? undefined
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
                logger.warn('[berry-acp] prompt failed', { message })
                this.session.sendSessionEvent({ type: 'message', message: `Berry prompt failed: ${message}` })
                this.messageBuffer.addMessage(`Berry prompt failed: ${message}`, 'status')
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
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                // Interim idle snapshots; the settled text arrives at the
                // segment boundary, which is what belongs in the local log.
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

    /** Mirrors the effective permission mode into the terminal log so remote
     *  sessions show what the bridge will auto-approve (kimi-style). */
    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system')
        }
    }

    /**
     * Push the HAPI permission mode onto Berry's sandbox axis via
     * `session/set_mode` (default / read_only / accept_edits / dont_ask →
     * Berry sandbox workspace-write / read-only / workspace-write / danger).
     * Tool approvals always arrive as request_permission and are decided by
     * the HAPI permission bridge. No-op when the mode is unchanged.
     *
     * Returns whether the agent accepted the switch. Tightenings to read-only
     * are the one case the caller must not ignore: the sandbox IS the
     * enforcement layer there, so a failed tightening leaves the agent more
     * permissive than the advertised mode. Relaxations may degrade to a
     * status note — the bridge still honors the stricter HAPI mode.
     */
    private async applyBerryAcpMode(
        backend: ReturnType<typeof createBerryBackend>,
        acpSessionId: string,
        permissionMode: PermissionMode | undefined
    ): Promise<boolean> {
        const acpMode = BERRY_ACP_MODE_BY_PERMISSION[permissionMode ?? 'default'] ?? 'default'
        if (acpMode === this.lastAppliedAcpMode) return true
        try {
            await backend.setMode(acpSessionId, acpMode, { syncThoughtLevel: false })
            this.lastAppliedAcpMode = acpMode
            logger.debug(`[berry-acp] Applied sandbox mode via set_mode: ${acpMode}`)
            return true
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[berry-acp] set_mode failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Berry sandbox mode switch failed: ${message}`
            })
            return false
        }
    }

    /**
     * Switch the Berry model through `session/set_config_option` — Berry
     * surfaces its model catalog as a config option of category `model`.
     * Model ids are opaque `provider/model` strings sent back verbatim;
     * unknown ids fail loud with -32602. Returns the applied model, or null
     * when the switch failed (caller keeps the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createBerryBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[berry-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the Berry agent exposes no model config option.'
            })
            return null
        }
        try {
            await backend.setConfigOption(acpSessionId, option.id, model)
            this.currentBackendModel = model
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system')
            return model
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[berry-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch Berry model: ${message}`
            })
            return null
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
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
    }
}
