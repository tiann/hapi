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

/**
 * Prompt failures that mean the ACP subprocess (or its stdio transport) is
 * gone — "ACP process exited (code=…, signal=…)", "ACP transport closed".
 * They never heal on the same backend: every later prompt on it fails too.
 * One prompt-level respawn on such failures recovers sessions whose agent
 * subprocess died mid-session (crash, upgrade, gateway restart) instead of
 * wedging the chat until it is manually reopened.
 */
const ACP_TRANSPORT_DEATH_RE = /process exited|ACP process|transport closed/i

export class BerryRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createBerryBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    private lastAppliedAcpMode: string | null = null
    private displayPermissionMode: PermissionMode | undefined
    /** Live ACP session id — mirrors the loop variable so the once-registered
     * catalog RPC handler can follow a mid-session backend respawn. */
    private acpSessionId: string | null = null
    /** Backend the catalog RPC answers from. Separate from this.backend
     * because cleanup() nulls that at teardown while the handler may still
     * be mounted; updated at startup and on every respawn. */
    private catalogBackend: ReturnType<typeof createBerryBackend> | null = null

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

    /**
     * Push the live permission mode to the agent immediately (mid-session
     * config switches). The queued-turn loop already applies modes at turn
     * boundaries; without this, a switch to read-only publishes on the HAPI
     * side right away while the native sandbox lags until the next prompt —
     * a window where bridge auto-approval and the real sandbox disagree.
     */
    async applyModeNow(): Promise<void> {
        if (!this.backend || !this.session.sessionId) return
        const permissionMode = this.session.getPermissionMode() as PermissionMode | undefined
        this.applyDisplayMode(permissionMode)
        await this.applyBerryAcpMode(this.backend, this.session.sessionId, permissionMode)
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'Berry'
        })
    }

    protected async runMainLoop(): Promise<void> {
        // `let`: a mid-loop respawn replaces both the backend instance and the
        // ACP session id it talks to.
        let backend = createBerryBackend()
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
            try {
                await ready
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `Berry session is not available: ${message}` }
            }
            // Read live state, not the startup closure: a mid-session respawn
            // swaps the backend and ACP session id while this handler (registered
            // exactly once) stays mounted.
            const backend = this.catalogBackend
            const acpSessionId = this.acpSessionId
            if (!backend || !acpSessionId) {
                return { success: false, error: 'Berry session is not available' }
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
            acpSessionId = await this.establishAcpSession(backend)
            this.session.onSessionFound(acpSessionId)
            this.acpSessionId = acpSessionId
            this.catalogBackend = backend
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
                const respawned = this.shouldRespawnAfterPromptFailure(backend, message)
                    ? await this.respawnBackend()
                    : null
                if (respawned) {
                    backend = respawned.backend
                    acpSessionId = respawned.acpSessionId
                    // Exactly one retry on the fresh backend — a repeated
                    // failure is reported like any other and the loop stays
                    // alive for the next turn (no respawn cycles).
                    try {
                        await backend.prompt(acpSessionId, prompt, (msg) => this.handleAgentMessage(msg))
                    } catch (retryError) {
                        this.reportPromptFailure(retryError)
                    }
                } else {
                    this.reportPromptFailure(error)
                }
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

    /**
     * Establish an ACP session on `backend`: resume the persisted Berry
     * session id when the backend advertises `session/resume`, otherwise
     * (no persisted id, unsupported, or resume failure) start a fresh one.
     * Shared by the initial launch and the post-crash respawn.
     */
    private async establishAcpSession(
        backend: ReturnType<typeof createBerryBackend>
    ): Promise<string> {
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
                return await backend.suppressUpdatesDuring(() =>
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
            }
        }
        return backend.newSession({
            cwd: this.session.path,
            // The Berry ACP server configures its own tools; HAPI
            // does not bridge MCP servers for it in v1.
            mcpServers: []
        })
    }

    /**
     * Whether a failed prompt should trigger a backend respawn: the failure
     * must look like the subprocess/transport dying AND the transport must
     * really be gone (an ordinary JSON-RPC error on a live transport — e.g.
     * an unknown model — must not respawn). Never respawn while tearing down.
     */
    private shouldRespawnAfterPromptFailure(
        backend: ReturnType<typeof createBerryBackend>,
        message: string
    ): boolean {
        if (this.shouldExit) return false
        if (!ACP_TRANSPORT_DEATH_RE.test(message)) return false
        return !backend.isTransportAlive()
    }

    /**
     * Rebuild the ACP backend after its subprocess died mid-session. The
     * transport never comes back on its own — every later prompt on the dead
     * backend fails — so prompt-level recovery means: dispose the dead
     * backend, spawn a fresh one, re-establish the ACP session (resuming the
     * persisted Berry session id when possible), and rebind the per-backend
     * state (permission bridge, sandbox mode, model). Returns the new backend
     * + session id, or null when the respawn itself failed — the caller then
     * reports the original prompt error and the loop stays alive for the
     * next turn.
     */
    private async respawnBackend(): Promise<{
        backend: ReturnType<typeof createBerryBackend>
        acpSessionId: string
    } | null> {
        this.session.sendSessionEvent({
            type: 'message',
            message: 'Berry agent process exited; restarting it.'
        })
        this.messageBuffer.addMessage('Berry agent exited — restarting', 'status')

        // The permission bridge is bound to the dead backend's transport;
        // cancel whatever is still pending through it before dropping it.
        const deadBackend = this.backend
        this.backend = null
        try {
            await this.permissionHandler?.cancelAll('Backend respawned')
        } catch (error) {
            logger.debug('[berry-acp] cancelAll during respawn failed', error)
        }
        this.permissionHandler = null
        try {
            await deadBackend?.disconnect()
        } catch (error) {
            logger.debug('[berry-acp] disconnect of dead backend failed', error)
        }

        try {
            const backend = createBerryBackend()
            this.backend = backend
            backend.onStderrError((error) => {
                logger.debug('[berry-acp] stderr error', error)
                this.session.sendSessionEvent({ type: 'message', message: error.message })
                this.messageBuffer.addMessage(error.message, 'status')
            })
            await backend.initialize()
            const acpSessionId = await this.establishAcpSession(backend)
            this.acpSessionId = acpSessionId
            this.catalogBackend = backend
            this.session.onSessionFound(acpSessionId)

            // Model state: a resumed session usually restores the model it
            // died with, but re-capture the server default and re-assert the
            // live override so the picker cannot drift from the backend.
            const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
            this.initialBackendModel = modelOption?.currentValue
                ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
                ?? this.initialBackendModel
            if (modelOption && this.currentBackendModel && this.currentBackendModel !== modelOption.currentValue) {
                await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
            }

            this.permissionHandler = new AcpPermissionHandler(
                this.session.client,
                backend,
                () => this.session.getPermissionMode() as PermissionMode | undefined
            )
            // Force the sandbox mode onto the fresh session — the new backend
            // has never seen this session's mode.
            this.lastAppliedAcpMode = null
            await this.applyBerryAcpMode(
                backend,
                acpSessionId,
                this.session.getPermissionMode() as PermissionMode | undefined
            )
            this.messageBuffer.addMessage('Berry agent restarted', 'status')
            return { backend, acpSessionId }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[berry-acp] respawn failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Berry agent restart failed: ${message}`
            })
            this.messageBuffer.addMessage(`Berry agent restart failed: ${message}`, 'status')
            return null
        }
    }

    private reportPromptFailure(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[berry-acp] prompt failed', { message })
        this.session.sendSessionEvent({ type: 'message', message: `Berry prompt failed: ${message}` })
        this.messageBuffer.addMessage(`Berry prompt failed: ${message}`, 'status')
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
