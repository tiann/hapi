import React from 'react'
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { logger } from '@/ui/logger'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { ReasonixDisplay } from '@/ui/ink/ReasonixDisplay'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { ReasonixSession } from './session'
import type { ReasonixLiveConfig } from './loop'
import type { PermissionMode } from './types'
import { createReasonixBackend } from './utils/reasonixBackend'
import { ReasonixPermissionHandler } from './utils/permissionHandler'

class ReasonixRemoteLauncher extends RemoteLauncherBase {
    private readonly session: ReasonixSession
    private readonly model?: string
    private readonly effort?: string
    private backend: ReturnType<typeof createReasonixBackend> | null = null
    private permissionHandler: ReasonixPermissionHandler | null = null
    private happyServer: { stop: () => void } | null = null
    private abortController = new AbortController()
    private currentModel: string | null = null
    private currentEffort: string | null = null
    private displayedMode: PermissionMode | null = null
    private displayedModel: string | null = null
    private appliedPermissionMode: PermissionMode | null = null
    private nativeCollaborationMode: 'normal' | 'plan' | 'goal' = 'normal'
    private nativeApprovalMode: 'ask' | 'auto' | 'yolo' = 'ask'
    private transcriptPersistenceAcknowledged = false
    private readonly displayedTools = new Map<string, string>()

    constructor(session: ReasonixSession, private readonly opts: {
        model?: string
        effort?: string
        permissionModeExplicit?: boolean
        resuming?: boolean
        onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void
        onPermissionModeDiscovered?: (mode: PermissionMode) => void
        onConfigApplyReady?: (apply: (config: ReasonixLiveConfig) => Promise<ReasonixLiveConfig>) => void
        onModelRollback?: (model: string | null) => void
        onEffortRollback?: (effort: string | null) => void
        onPermissionRollback?: (mode: PermissionMode) => void
    }) {
        super(process.env.DEBUG ? session.logPath : undefined)
        this.session = session
        this.model = opts.model
        this.effort = opts.effort
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            // Reasonix has no HAPI local launcher yet. A switch request exits;
            // the web can reopen the same native ACP session afterwards.
            onSwitchToLocal: () => this.handleExitFromUi()
        })
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(ReasonixDisplay, context)
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session
        const { server, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'reasonix' }
        })
        this.happyServer = server

        const backend = createReasonixBackend()
        this.backend = backend
        registerAcpSessionTitleSync(backend, session.client)
        this.permissionHandler = new ReasonixPermissionHandler(session.client, backend)
        backend.setAgentActivityListener((thinking) => {
            // ACP emits both busy and idle transitions. Keep the HAPI state
            // in sync in both directions so a completed prompt cannot leave
            // the session stuck displaying an active-thinking indicator.
            if (session.thinking !== thinking) session.onThinkingChange(thinking)
        })
        backend.onStderrError((error) => {
            logger.debug('[reasonix-remote] stderr error', error)
            const message = error.message
            session.sendSessionEvent({ type: 'message', message })
            this.messageBuffer.addMessage(message, 'status')
        })

        try {
            await backend.initialize()
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            const setupHint = /auth|credential|api.?key|setup|login|not configured|provider/i.test(detail)
                ? ' Run `reasonix setup` (or configure DEEPSEEK_API_KEY) first.'
                : ''
            throw new Error(`Reasonix ACP failed to initialize: ${detail}${setupHint}`)
        }

        const acpConfig = toAcpMcpServers(mcpServers)
        const nativeId = session.sessionId
        const hadTranscriptPersistenceMarker =
            session.client.getMetadata()?.reasonixTranscriptPersisted === true
        let acpSessionId: string
        if (nativeId) {
            try {
                // A failed load must not silently fork a new native thread: it
                // would make a HAPI resume appear successful while losing context.
                acpSessionId = backend.resumeSession
                    ? await backend.resumeSession({ sessionId: nativeId, cwd: session.path, mcpServers: acpConfig })
                    : await backend.loadSession({ sessionId: nativeId, cwd: session.path, mcpServers: acpConfig })
            } catch (error) {
                throw reasonixOperationError('resume', error)
            }
        } else {
            try {
                acpSessionId = await backend.newSession({ cwd: session.path, mcpServers: acpConfig })
            } catch (error) {
                throw reasonixOperationError('session creation', error)
            }
        }
        // A successful session/resume proves that Reasonix found this id in its
        // native store. Record that evidence even for a HAPI row created via a
        // direct `hapi reasonix --resume <native-id>` invocation; otherwise an
        // untouched row has zero HAPI messages and can later be mistaken for an
        // unpersisted fresh session.
        this.transcriptPersistenceAcknowledged = nativeId !== null
        session.onSessionFound(acpSessionId, {
            reasonixTranscriptPersisted: this.transcriptPersistenceAcknowledged
        })
        if (!nativeId || !hadTranscriptPersistenceMarker) {
            // Pin the opaque Reasonix session id before advertising startup
            // readiness. Otherwise a hub restart between session/new and the
            // asynchronous metadata ACK can strand an unrecoverable native
            // transcript even though the reopen API already returned success.
            const flushed = await session.client.flushMetadata()
            if (!flushed) {
                const field = nativeId
                    ? 'reasonixTranscriptPersisted'
                    : 'reasonixSessionId'
                const message =
                    `[reasonix-remote] ${field} metadata write did not ACK within 5s `
                    + `(acpSessionId=${acpSessionId})`
                // Do not advertise readiness or consume queued work until the
                // native identity is durable. A fresh ACP session cannot be
                // resumed safely without this metadata, so continuing here
                // would create an apparently healthy but unrecoverable row.
                logger.warn(message)
                throw new Error(`${message}; refusing to start without durable session identity`)
            }
        }

        // Reasonix can rebuild its provider/model catalog after a mode or
        // preset change and reports the authoritative snapshot asynchronously.
        // Keep the HAPI runtime fields aligned with that snapshot so the web
        // composer does not send stale model/effort values on the next turn.
        backend.setSessionConfigOptionsUpdateListener((update) => {
            if (update.sessionId !== acpSessionId) return
            const model = update.options.find((option) => option.id === 'model' || option.category === 'model')
            const effort = update.options.find((option) => (
                option.id === 'effort'
                || option.category === 'thought_level'
                || option.id === 'x.ai/reasoning-effort'
            ))
            const approval = update.options.find((option) => option.id === 'tool_approval')
            // ACP config_option_update is a complete replacement snapshot.
            // Switching provider/config catalogs can remove either descriptor;
            // clear both cached values instead of retaining stale HAPI state.
            this.currentModel = model?.currentValue ?? null
            session.setModel(this.currentModel)
            this.currentEffort = effort?.currentValue ?? null
            session.setEffort(this.currentEffort)
            if (approval?.currentValue) {
                this.nativeApprovalMode = approval.currentValue === 'yolo'
                    ? 'yolo'
                    : approval.currentValue === 'auto'
                        ? 'auto'
                        : 'ask'
                const mode = this.effectivePermissionMode()
                this.appliedPermissionMode = mode
                session.setPermissionMode(mode)
                this.opts.onPermissionModeDiscovered?.(mode)
            }
            this.opts.onConfigDiscovered?.({
                model: this.currentModel,
                effort: this.currentEffort
            })
        })
        backend.setSessionModeUpdateListener?.((update) => {
            if (update.sessionId !== acpSessionId) return
            // Collaboration plan is represented by HAPI's plan permission
            // mode. Normal/goal retain the approval axis advertised by the
            // latest tool_approval option; goal has no HAPI equivalent yet.
            if (update.modeId === 'plan') {
                this.nativeCollaborationMode = 'plan'
                const mode = this.effectivePermissionMode()
                this.appliedPermissionMode = mode
                session.setPermissionMode('plan')
                this.opts.onPermissionModeDiscovered?.(mode)
            } else if (update.modeId === 'normal' || update.modeId === 'goal') {
                this.nativeCollaborationMode = update.modeId
                const approval = this.readOption(backend, acpSessionId, 'tool_approval')?.currentValue
                if (approval) this.nativeApprovalMode = approval === 'yolo'
                    ? 'yolo'
                    : approval === 'auto'
                        ? 'auto'
                        : 'ask'
                const mode: PermissionMode = this.effectivePermissionMode()
                this.appliedPermissionMode = mode
                session.setPermissionMode(mode)
                this.opts.onPermissionModeDiscovered?.(mode)
            }
        })

        this.currentModel = this.readOption(backend, acpSessionId, 'model')?.currentValue
            ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
            ?? null
        this.currentEffort = this.readOption(backend, acpSessionId, 'effort')?.currentValue
            ?? this.readOption(backend, acpSessionId, 'thought_level')?.currentValue
            ?? null
        const initialMode = backend.getSessionModeMetadata?.(acpSessionId)?.currentModeId
        if (initialMode === 'plan' || initialMode === 'goal' || initialMode === 'normal') {
            this.nativeCollaborationMode = initialMode
        }
        const initialApproval = this.readOption(backend, acpSessionId, 'tool_approval')?.currentValue
        if (initialApproval === 'auto' || initialApproval === 'yolo' || initialApproval === 'ask') {
            this.nativeApprovalMode = initialApproval
        }
        // The ACP response is authoritative for resumed sessions. Keep HAPI's
        // runtime state aligned even when the user did not pass explicit CLI
        // overrides, so keep-alive metadata and the composer reflect the native
        // model/effort immediately after load/new.
        session.setModel(this.currentModel)
        session.setEffort(this.currentEffort)
        this.opts.onConfigDiscovered?.({
            model: this.currentModel,
            effort: this.currentEffort
        })

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListReasonixConfigOptions, async () => {
            const models = backend.getSessionModelsMetadata(acpSessionId)
            const effort = this.readOption(backend, acpSessionId, 'effort')
                ?? this.readOption(backend, acpSessionId, 'thought_level')
            if (!models && !effort) {
                return { success: false, error: 'Reasonix configuration metadata is not available' }
            }
            return {
                success: true,
                availableModels: models?.availableModels ?? [],
                currentModelId: this.currentModel,
                effortOptions: effort?.options ?? [],
                currentEffort: this.currentEffort
            }
        })

        if (this.model) {
            await this.applyModel(backend, acpSessionId, this.model)
            if (this.currentModel !== this.model) {
                throw new Error(`Reasonix rejected model ${this.model}`)
            }
        }
        if (this.effort) {
            await this.applyEffort(backend, acpSessionId, this.effort)
            if (this.currentEffort !== this.effort) {
                throw new Error(`Reasonix rejected effort ${this.effort}`)
            }
        }
        // A persisted native collaboration mode is authoritative on resume
        // unless the HAPI caller explicitly requested a different mode. Do not
        // collapse a resumed plan/goal session back to normal merely because
        // the HAPI row predates the native mode metadata.
        const requestedPermissionMode = this.opts.permissionModeExplicit === true
            ? session.getPermissionMode() as PermissionMode | undefined
            : undefined
        // `undefined` means HAPI has no explicit preference; retain the
        // native mode reported by ACP (including a resumed plan/goal session).
        // A concrete HAPI value, including `default`, is an intentional
        // override and should be applied.
        const startupPermissionMode = requestedPermissionMode ?? this.effectivePermissionMode()
        if (this.opts.permissionModeExplicit === true || this.opts.resuming !== true) {
            await this.applyPermissionMode(backend, acpSessionId, startupPermissionMode)
            if (this.appliedPermissionMode !== startupPermissionMode) {
                throw new Error(`Reasonix rejected permission mode ${startupPermissionMode}`)
            }
        } else {
            this.appliedPermissionMode = this.effectivePermissionMode()
            session.setPermissionMode(this.appliedPermissionMode)
            this.opts.onPermissionModeDiscovered?.(this.appliedPermissionMode)
        }
        this.publishDisplayState(session.getPermissionMode() as PermissionMode | undefined)

        // Expose a confirmation-based config path only after initial startup
        // overrides have completed. This avoids concurrent ACP writes when a
        // web config RPC arrives while the launcher is still bootstrapping.
        this.opts.onConfigApplyReady?.(async (config) => {
            if (config.permissionMode !== undefined) {
                await this.applyPermissionMode(backend, acpSessionId, config.permissionMode)
                if (this.appliedPermissionMode !== config.permissionMode) {
                    throw new Error(`Reasonix rejected permission mode ${config.permissionMode}`)
                }
            }
            if (config.model !== undefined) {
                if (config.model === null) {
                    throw new Error('Reasonix does not advertise a default model reset')
                }
                await this.applyModel(backend, acpSessionId, config.model)
                if (this.currentModel !== config.model) {
                    throw new Error(`Reasonix rejected model ${config.model}`)
                }
            }
            if (config.effort !== undefined) {
                await this.applyEffort(backend, acpSessionId, config.effort)
                if (config.effort !== null && this.currentEffort !== config.effort) {
                    throw new Error(`Reasonix rejected effort ${config.effort}`)
                }
                if (config.effort === null) {
                    // ACP's null/default UI value maps to Reasonix's explicit
                    // `auto` effort, even when a resumed session started at a
                    // different effort level.
                    const option = this.readOption(backend, acpSessionId, 'effort')
                        ?? this.readOption(backend, acpSessionId, 'thought_level')
                    const expectedEffort = option?.options.some((entry) => entry.value === 'auto')
                        ? 'auto'
                        : null
                    if (this.currentEffort !== expectedEffort) {
                        throw new Error('Reasonix did not reset effort')
                    }
                }
            }
            return {
                permissionMode: session.getPermissionMode() as PermissionMode,
                model: this.currentModel,
                effort: this.currentEffort
            }
        })

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        })

        // ACP session creation/resume and all requested startup overrides are
        // complete. Advertise readiness before waiting for the first prompt so
        // hub resume callers cannot observe the bootstrap keepalive as a
        // successful native resume while ACP is still initializing.
        session.client.emitSessionReady()

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal)
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) continue
                break
            }

            // An omitted per-message mode means "keep the native Reasonix
            // state". This matters after resuming goal/plan sessions: treating
            // undefined as HAPI's `default` would silently force Normal + Ask
            // on the first prompt.
            if (batch.mode.permissionMode !== undefined) {
                await this.applyPermissionMode(backend, acpSessionId, batch.mode.permissionMode)
            }
            if (batch.mode.model !== undefined && batch.mode.model !== this.currentModel) {
                await this.applyModel(backend, acpSessionId, batch.mode.model)
            }
            if (batch.mode.effort !== undefined && batch.mode.effort !== this.currentEffort) {
                await this.applyEffort(backend, acpSessionId, batch.mode.effort)
            }
            this.publishDisplayState(batch.mode.permissionMode ?? this.effectivePermissionMode())
            this.messageBuffer.addMessage(batch.message, 'user')
            session.onThinkingChange(true)
            try {
                const content: PromptContent[] = [{ type: 'text', text: batch.message }]
                await backend.prompt(acpSessionId, content, (message: AgentMessage) => this.handleAgentMessage(message))
                if (!this.transcriptPersistenceAcknowledged) {
                    session.client.updateMetadata((metadata) => ({
                        ...metadata,
                        reasonixTranscriptPersisted: true
                    }))
                    this.transcriptPersistenceAcknowledged = await session.client.flushMetadata()
                    if (!this.transcriptPersistenceAcknowledged) {
                        logger.warn(
                            '[reasonix-remote] transcript persisted natively, but its HAPI metadata ACK timed out'
                        )
                    }
                }
                void backend.refreshSessionInfo(acpSessionId, session.path)
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                logger.warn('[reasonix-remote] prompt failed', detail)
                session.sendSessionEvent({ type: 'message', message: `Reasonix prompt failed: ${detail}` })
                this.messageBuffer.addMessage(`Reasonix prompt failed: ${detail}`, 'status')
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
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        if (this.backend) {
            await this.backend.disconnect()
            this.backend = null
        }
        this.happyServer?.stop()
        this.happyServer = null
    }

    private readOption(
        backend: ReturnType<typeof createReasonixBackend>,
        sessionId: string,
        key: string
    ) {
        return backend.getSessionConfigOptions(sessionId)?.find((option) =>
            option.id === key || option.category === key
        )
    }

    private effectivePermissionMode(): PermissionMode {
        if (this.nativeCollaborationMode === 'plan') return 'plan'
        if (this.nativeApprovalMode === 'yolo') return 'yolo'
        if (this.nativeApprovalMode === 'auto') return 'auto'
        return 'default'
    }

    private async applyModel(
        backend: ReturnType<typeof createReasonixBackend>,
        sessionId: string,
        model: string | null
    ): Promise<void> {
        if (!model) {
            throw new Error('Reasonix does not advertise a default model reset')
        }
        const option = this.readOption(backend, sessionId, 'model')
        try {
            if (option) {
                if (!option.options.some((entry) => entry.value === model)) {
                    throw new Error(`Reasonix does not advertise model ${model}`)
                }
                await backend.setConfigOption(sessionId, option.id, model)
            } else {
                await backend.setModel(sessionId, model, { flavor: 'reasonix' })
            }
            this.currentModel = model
            this.session.setModel(model)
            this.opts.onConfigDiscovered?.({ model: this.currentModel, effort: this.currentEffort })
        } catch (error) {
            logger.warn('[reasonix-remote] model switch failed', error)
            const detail = error instanceof Error ? error.message : String(error)
            this.session.sendSessionEvent({ type: 'message', message: `Failed to switch Reasonix model to ${model}: ${detail}.` })
            this.opts.onModelRollback?.(this.currentModel)
        }
    }

    private async applyEffort(
        backend: ReturnType<typeof createReasonixBackend>,
        sessionId: string,
        effort: string | null
    ): Promise<void> {
        if (!effort) {
            // `auto` is Reasonix's protocol default. A resumed session's
            // current effort is not necessarily its default value.
            const fallback = 'auto'
            const option = this.readOption(backend, sessionId, 'effort')
                ?? this.readOption(backend, sessionId, 'thought_level')
            try {
                if (option && option.options.some((entry) => entry.value === fallback)) {
                    await backend.setConfigOption(sessionId, option.id, fallback)
                    this.currentEffort = fallback
                    this.session.setEffort(fallback)
                    this.opts.onConfigDiscovered?.({ model: this.currentModel, effort: this.currentEffort })
                } else {
                    this.currentEffort = null
                    this.session.setEffort(null)
                    this.opts.onConfigDiscovered?.({ model: this.currentModel, effort: this.currentEffort })
                }
            } catch (error) {
                // A transient reset failure must not tear down the whole ACP
                // session. Keep the confirmed value and report the rollback.
                logger.warn('[reasonix-remote] effort reset failed', error)
                const detail = error instanceof Error ? error.message : String(error)
                this.session.sendSessionEvent({
                    type: 'message',
                    message: `Failed to reset Reasonix effort to ${fallback}: ${detail}.`
                })
                this.opts.onEffortRollback?.(this.currentEffort)
            }
            return
        }
        const option = this.readOption(backend, sessionId, 'effort')
            ?? this.readOption(backend, sessionId, 'thought_level')
        if (!option) {
            logger.debug('[reasonix-remote] agent exposes no effort option')
            return
        }
        try {
            if (option.options.length > 0 && !option.options.some((entry) => entry.value === effort)) {
                throw new Error(`Reasonix does not advertise effort ${effort}`)
            }
            await backend.setConfigOption(sessionId, option.id, effort)
            this.currentEffort = effort
            this.session.setEffort(effort)
            this.opts.onConfigDiscovered?.({ model: this.currentModel, effort: this.currentEffort })
        } catch (error) {
            logger.warn('[reasonix-remote] effort switch failed', error)
            const detail = error instanceof Error ? error.message : String(error)
            this.session.sendSessionEvent({ type: 'message', message: `Failed to switch Reasonix effort to ${effort}: ${detail}.` })
            this.opts.onEffortRollback?.(this.currentEffort)
        }
    }

    private async applyPermissionMode(
        backend: ReturnType<typeof createReasonixBackend>,
        sessionId: string,
        mode: PermissionMode
    ): Promise<void> {
        const resolved = mode
        const targetCollaborationMode = resolved === 'plan' ? 'plan' : 'normal'
        const targetApprovalMode = resolved === 'yolo' ? 'yolo' : resolved === 'auto' ? 'auto' : 'ask'
        if (
            this.nativeCollaborationMode === targetCollaborationMode
            && this.nativeApprovalMode === targetApprovalMode
        ) {
            this.appliedPermissionMode = resolved
            // The native state may already match the requested projection
            // (notably a fresh Reasonix session whose configured default is
            // Auto). Still publish it: runReasonix starts with an unset HAPI
            // mode when no CLI override was supplied, and otherwise the
            // keepalive would incorrectly remain at `default` forever.
            this.session.setPermissionMode(resolved)
            this.opts.onPermissionModeDiscovered?.(resolved)
            return
        }
        const previousCollaborationMode = this.nativeCollaborationMode
        const previousApprovalMode = this.nativeApprovalMode
        let collaborationChanged = false
        try {
            await backend.setMode(sessionId, targetCollaborationMode)
            this.nativeCollaborationMode = targetCollaborationMode
            collaborationChanged = this.nativeCollaborationMode !== previousCollaborationMode
            const option = this.readOption(backend, sessionId, 'tool_approval')
            if (!option) {
                if (resolved !== 'default') {
                    throw new Error('Reasonix did not advertise the tool_approval config option')
                }
                // Default is the protocol's Ask posture. If an older agent
                // omits the optional descriptor, normal mode remains a
                // conservative, usable fallback.
                this.appliedPermissionMode = resolved
                this.session.setPermissionMode(resolved)
                this.opts.onPermissionModeDiscovered?.(resolved)
                return
            }
            await backend.setConfigOption(sessionId, option.id, targetApprovalMode)
            this.nativeApprovalMode = targetApprovalMode
            this.appliedPermissionMode = resolved
            // `session/set_mode` may emit a mode update before the separate
            // tool_approval write completes. Publish the final two-axis
            // result so an intermediate native approval value cannot leak
            // into HAPI metadata or the web composer.
            this.session.setPermissionMode(resolved)
            this.opts.onPermissionModeDiscovered?.(resolved)
        } catch (error) {
            // set_mode and tool_approval are separate ACP transactions. If the
            // second write fails, compensate the first so native and HAPI do
            // not advertise different permission semantics on the next turn.
            if (collaborationChanged) {
                try {
                    await backend.setMode(sessionId, previousCollaborationMode)
                } catch (rollbackError) {
                    logger.warn('[reasonix-remote] native permission rollback failed', rollbackError)
                }
            }
            this.nativeCollaborationMode = previousCollaborationMode
            this.nativeApprovalMode = previousApprovalMode
            // set_mode/config_option_update notifications can arrive between
            // the two ACP writes and optimistically update this field. Derive
            // it again after compensation so callers can detect the rejection.
            this.appliedPermissionMode = this.effectivePermissionMode()
            logger.warn('[reasonix-remote] permission mode switch failed', error)
            const detail = error instanceof Error ? error.message : String(error)
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch Reasonix permission mode to ${resolved}: ${detail}.`
            })
            this.opts.onPermissionRollback?.(this.appliedPermissionMode)
        }
    }

    private publishDisplayState(mode: PermissionMode | undefined): void {
        if (mode && mode !== this.displayedMode) {
            this.displayedMode = mode
            this.messageBuffer.addMessage(`[MODE:${mode}]`, 'system')
        }
        if (this.currentModel && this.currentModel !== this.displayedModel) {
            this.displayedModel = this.currentModel
            this.messageBuffer.addMessage(`[MODEL:${this.currentModel}]`, 'system')
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentModel)
        if (converted) this.session.sendAgentMessage(converted)
        switch (message.type) {
            case 'text': this.messageBuffer.addMessage(message.text, 'assistant'); break
            case 'reasoning': this.messageBuffer.addMessage(`[Thinking] ${message.text.slice(0, 100)}...`, 'system'); break
            case 'tool_call':
                if (this.displayedTools.get(message.id) !== message.name) {
                    this.displayedTools.set(message.id, message.name)
                    this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool')
                }
                break
            case 'tool_result': this.messageBuffer.addMessage('Tool result received', 'result'); break
            case 'plan': this.messageBuffer.addMessage('Plan updated', 'status'); break
            case 'error': this.messageBuffer.addMessage(message.message, 'status'); break
            case 'generated_image': this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant'); break
            case 'turn_complete': this.messageBuffer.addMessage('Turn complete', 'status'); break
            case 'usage': break
            default: {
                const exhaustive: never = message
                return exhaustive
            }
        }
    }

    private async handleAbort(): Promise<void> {
        if (this.backend && this.session.sessionId) {
            try {
                await this.backend.cancelPrompt(this.session.sessionId)
            } catch (error) {
                logger.debug('[reasonix-remote] cancel prompt failed', error)
            }
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

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort())
    }
}

function reasonixOperationError(operation: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error)
    const hint = /auth|credential|api.?key|setup|login|not configured|provider/i.test(detail)
        ? ' Run `reasonix setup` (or configure DEEPSEEK_API_KEY) first.'
        : ''
    return new Error(`Reasonix ${operation} failed: ${detail}.${hint}`)
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({ name, command: entry.command, args: entry.args, env: [] }))
}

export async function reasonixRemoteLauncher(
    session: ReasonixSession,
    opts: {
        model?: string
        effort?: string
        permissionModeExplicit?: boolean
        resuming?: boolean
        onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void
        onPermissionModeDiscovered?: (mode: PermissionMode) => void
        onConfigApplyReady?: (apply: (config: ReasonixLiveConfig) => Promise<ReasonixLiveConfig>) => void
        onModelRollback?: (model: string | null) => void
        onEffortRollback?: (effort: string | null) => void
        onPermissionRollback?: (mode: PermissionMode) => void
    }
): Promise<'switch' | 'exit'> {
    return new ReasonixRemoteLauncher(session, opts).launch()
}
