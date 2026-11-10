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
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { createBerryBackend, resolveBerryDataDir } from './utils/berryBackend'
import { buildBerryPromptContent } from './utils/berryPromptContent'
import type { BerrySession } from './session'

export class BerryRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createBerryBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    private displayPermissionMode: PermissionMode | undefined
    /** Isolated berry dataDir (sessions.db + sticky tool-policy.json) keyed
     * by the HAPI row id — stable across respawns and runner restarts. */
    private readonly dataDir: string
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
            /** Spawn-time model override (`provider/model-id`; passed to the
             * child as BERRY_AGENT_MODEL — berry's only model lever). */
            model?: string
            onModelRollback?: (model: string | null) => void
            onConfigDiscovered?: (model: string | null) => void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
        this.dataDir = resolveBerryDataDir(session.client.sessionId)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() })
    }

    async kill(): Promise<void> {
        if (!this.backend) return
        await this.handleAbort()
    }

    /**
     * Mirror a mid-session permission-mode switch into the terminal log.
     *
     * Berry has no session/set_mode (and no other runtime mode RPC): the
     * HAPI permission bridge is the ONLY live enforcement — it consults the
     * session's current mode through the getter handed to
     * AcpPermissionHandler on every request_permission (read-only denies
     * writes via the classifier, yolo auto-approves), so a switch takes
     * effect on the very next request without any agent-side push. All this
     * method does is publish the display mode immediately instead of at the
     * next turn boundary.
     */
    async applyModeNow(): Promise<void> {
        if (!this.backend || !this.session.sessionId) return
        this.applyDisplayMode(this.session.getPermissionMode() as PermissionMode | undefined)
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'Berry'
        })
    }

    /**
     * Spawn a berry ACP backend with the session's spawn-time levers: the
     * model override (BERRY_AGENT_MODEL) and the isolated data dir
     * (BERRY_AGENT_DATA_DIR). Berry reads both only at process start, so
     * every backend creation — initial launch and respawn alike — must go
     * through here.
     */
    private spawnBackend(): ReturnType<typeof createBerryBackend> {
        const backend = createBerryBackend(process.env, {
            model: this.opts.model,
            dataDir: this.dataDir
        })
        backend.onStderrError((error) => {
            logger.debug('[berry-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })
        return backend
    }

    protected async runMainLoop(): Promise<void> {
        // `let`: a mid-loop respawn replaces both the backend instance and the
        // ACP session id it talks to.
        let backend = this.spawnBackend()
        this.backend = backend
        // Native session_info_update titles are deliberately NOT mirrored:
        // the Hub owns Berry session titles, matching the other ACP flavors
        // without a native rename tool. Mirroring a native title into
        // metadata.summary would suppress the Hub's own title generation.

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

        // Auto-approval consults the LIVE session mode through the getter:
        // a mid-turn switch to yolo starts auto-approving request_permission
        // immediately. Berry has no agent-side mode axis to push (no
        // session/set_mode, no sandbox preset RPC) — the HAPI permission
        // bridge is the only enforcement layer.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined,
            // Berry persists allow_always answers STICKILY in tool-policy.json
            // (surviving even process restarts). A HAPI "allow for session"
            // pick means exactly one session, so it must map to allow_once
            // there; other flavors keep the shared default.
            { sessionScopedPermissionGrants: true }
        )
        this.applyDisplayMode(this.session.getPermissionMode() as PermissionMode | undefined)
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

            // Display-only: read-only turns are still SENT — the HAPI
            // permission bridge classifies and denies write requests; there
            // is no agent-side sandbox switch that could fail and skip the
            // turn.
            this.applyDisplayMode(batch.mode.permissionMode)

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
            // Image attachments are read once here (authorized per session)
            // and the built content is reused verbatim by the respawn retry,
            // so a reconnect never re-reads or re-orders the batch's images.
            // Per-image failures are handled inside (status notice + skip);
            // this guard only catches unexpected preparation errors so they
            // degrade to a text-only turn instead of killing the loop.
            let prompt: PromptContent[]
            try {
                prompt = await buildBerryPromptContent(
                    backend,
                    batch.message,
                    batch.mode.imageAttachments,
                    {
                        sessionId: this.session.client.sessionId,
                        onNotice: (message) => this.session.sendSessionEvent({ type: 'message', message })
                    }
                )
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[berry-acp] prompt preparation failed', { message })
                prompt = [{ type: 'text', text: batch.message }]
            }
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const respawned = this.shouldRespawnAfterPromptFailure(error)
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
     * Establish an ACP session on `backend`: restore the persisted Berry
     * session id through `session/load` when the backend advertises
     * `agentCapabilities.loadSession`, otherwise (no persisted id,
     * unsupported, or load failure) start a fresh one. Shared by the
     * initial launch and the post-crash respawn.
     */
    private async establishAcpSession(
        backend: ReturnType<typeof createBerryBackend>
    ): Promise<string> {
        const resumeSessionId = this.session.sessionId
        if (resumeSessionId) {
            try {
                // Berry has NO session/resume — its resume path is
                // session/load (agentCapabilities.loadSession: replay the
                // full stored history, then live-attach). The replayed
                // history is suppressed so it never reaches the hub
                // transcript (the Hub stays the transcript source).
                if (!backend.supportsLoadSession()) {
                    throw new Error('Berry ACP server does not advertise session/load (agentCapabilities.loadSession)')
                }
                const sessionId = await backend.suppressUpdatesDuring(() =>
                    backend.loadSession({
                        sessionId: resumeSessionId,
                        cwd: this.session.path,
                        mcpServers: []
                    })
                )
                // Berry answers session/load with {} — AcpSdkBackend.loadSession
                // then falls back to the REQUESTED id (verified semantics), so
                // the persisted id is what both sides keep using.
                return sessionId || resumeSessionId
            } catch (error) {
                logger.warn('[berry-acp] session/load failed, starting a new session', error)
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'Berry session load failed; starting a new session.'
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
     * Whether a failed prompt should trigger a backend respawn: only the
     * transport's typed indeterminate marker (child exited, transport
     * closed, failed stdin write — the request never reached a JSON-RPC
     * outcome) qualifies. A LIVE backend's ordinary JSON-RPC error must not
     * respawn, even when its text mentions "process exited" — an agent-side
     * error message saying so still leaves a healthy transport that would
     * serve the next turn. Never respawn while tearing down.
     */
    private shouldRespawnAfterPromptFailure(error: unknown): boolean {
        if (this.shouldExit) return false
        return isAcpIndeterminateError(error)
    }

    /**
     * Rebuild the ACP backend after its subprocess died mid-session. The
     * transport never comes back on its own — every later prompt on the dead
     * backend fails — so prompt-level recovery means: dispose the dead
     * backend, spawn a fresh one (same spawn-time model + dataDir levers),
     * re-establish the ACP session (loading the persisted Berry session id
     * when possible), and rebind the per-backend state (permission bridge,
     * model). Returns the new backend + session id, or null when the
     * respawn itself failed — the caller then reports the original prompt
     * error and the loop stays alive for the next turn.
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
            const backend = this.spawnBackend()
            this.backend = backend
            await backend.initialize()
            const acpSessionId = await this.establishAcpSession(backend)
            this.acpSessionId = acpSessionId
            this.catalogBackend = backend
            this.session.onSessionFound(acpSessionId)

            // Model state: a restored session usually resumes the model it
            // died with (the spawn-time BERRY_AGENT_MODEL lever re-applies it
            // too), but re-capture the server default and re-assert the live
            // override so the picker cannot drift from the backend.
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
                () => this.session.getPermissionMode() as PermissionMode | undefined,
                { sessionScopedPermissionGrants: true }
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
