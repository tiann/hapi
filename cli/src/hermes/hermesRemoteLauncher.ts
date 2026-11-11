import React from 'react'
import { RPC_METHODS } from '@hapi/protocol'
import type { PermissionMode } from '@hapi/protocol/types'
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
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { createHermesBackend } from './utils/hermesBackend'
import type { HermesSession } from './session'

/** Hermes ACP edit-approval axis (acp_adapter/modes.py). Sensitive paths still
 * emit request_permission in every mode — the HAPI-side bridge decides those. */
const HERMES_EDIT_MODE_BY_PERMISSION: Record<string, string> = {
    default: 'default',
    'safe-yolo': 'accept_edits',
    yolo: 'dont_ask'
}

/**
 * Readiness handshake for the ListHermesModels catalog RPC (registered once
 * per launcher in runMainLoop). Replaced on every backend (re)establishment
 * so a picker query that arrives mid-respawn parks until the replacement
 * session exists and model discovery has settled — and one that arrives
 * while a respawn fails gets the failure instead of hanging forever. The
 * backend of the establishment the promise belongs to travels with it: the
 * handler must query metadata on the backend that captured that session,
 * which a respawn swap keeps visible to parked queries.
 */
type ModelsReadiness = {
    backend: ReturnType<typeof createHermesBackend>
    promise: Promise<string>
    resolve: (acpSessionId: string) => void
    reject: (error: unknown) => void
}

export class HermesRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createHermesBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    private lastAppliedEditMode: string | null = null
    private displayPermissionMode: PermissionMode | undefined
    /** ACP session id on the CURRENT backend — swapped by every respawn so
     * the main loop, abort path, and catalog RPC never act on a stale one. */
    private acpSessionId: string | null = null
    private modelsReadiness: ModelsReadiness | null = null
    /** Guards against concurrent backend rebuilds (prompt retry vs abort). */
    private respawnInProgress = false
    /** HAPI MCP bridge HTTP server; mounted into every (re)established session. */
    private happyServer: { stop: () => void } | null = null
    /** ACP form of the hapi MCP bridge servers (name/command/args/env). */
    private acpMcpServers: McpServerStdio[] = []

    constructor(
        private readonly session: HermesSession,
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
            agentLabel: 'Hermes'
        })
    }

    protected async runMainLoop(): Promise<void> {
        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session exists
        // and model discovery has settled, using the backend of whichever
        // establishment resolved it — a respawn swap is always visible.
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListHermesModels, async () => {
            const readiness = this.modelsReadiness
            if (!readiness) {
                return { success: false, error: 'Hermes session is not available' }
            }
            let acpSessionId: string
            try {
                acpSessionId = await readiness.promise
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `Hermes session is not available: ${message}` }
            }
            const metadata = readiness.backend.getSessionModelsMetadata(acpSessionId)
            if (!metadata) {
                return { success: false, error: 'Hermes model metadata is not available' }
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: this.currentBackendModel ?? metadata.currentModelId
            }
        })

        // Hermes mounts client MCP servers as the session's "editor MCP" on
        // BOTH session/new and session/resume (verified in the hermes ACP
        // source) — the old `mcpServers: []` sites pinned a stale claim that
        // v1 did not bridge MCP. Bridge the hapi MCP tools exactly like the
        // codex flavors: the bridge HTTP server is built ONCE per launcher and
        // every (re)establishment passes the same server list, so a respawn
        // remounts the tools cleanly (each fresh `hermes acp` child mounts
        // its own stdio bridge process via `--tools`, which also gates the
        // exposed tool set). buildHapiMcpBridge drops list_peers from the
        // auto-approved shortlist under HAPI_DISABLE_PEER_TOOLS.
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(this.session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: this.session.path, flavor: 'hermes' }
        })
        this.happyServer = happyServer
        this.acpMcpServers = toAcpMcpServers(mcpServers)

        await this.establishBackend({ respawn: false })

        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            // Capture the signal per iteration (ported from dsh): handleAbort
            // swaps in a fresh AbortController right after aborting, so
            // re-reading this.abortController.signal below would see the
            // replacement (never aborted) and mistake an aborted wait for a
            // closed queue — exiting the loop and tearing down the whole
            // session on a Stop that arrived while the queue was idle.
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }

            // A respawn that failed on an earlier batch leaves no backend
            // behind: rebuild before touching this batch. One fresh attempt
            // per message — a permanently down gateway surfaces one error per
            // message instead of wedging or exiting the loop.
            if (!this.backend || !this.acpSessionId) {
                let reconnected = false
                try {
                    await this.respawnBackend()
                    reconnected = true
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[hermes-acp] reconnect failed', { message })
                    this.session.sendSessionEvent({ type: 'message', message: `Hermes reconnect failed: ${message}` })
                    this.messageBuffer.addMessage(`Hermes reconnect failed: ${message}`, 'status')
                }
                if (!reconnected) {
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }
            }

            // Reference the CURRENT backend/session per iteration (not a
            // const captured at loop start): a respawn swaps both.
            const backend = this.backend!
            const acpSessionId = this.acpSessionId!

            this.applyDisplayMode(batch.mode.permissionMode)
            if (batch.mode.permissionMode !== undefined) {
                await this.applyHermesEditMode(backend, acpSessionId, batch.mode.permissionMode)
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
                        message: 'Cannot reset the Hermes model: the agent did not report a default model.'
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
            let failureMessage: string | null = null
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[hermes-acp] prompt failed', { message })
                // isAcpIndeterminateError is the transport's own typed marker
                // for failures whose request never reached a JSON-RPC outcome
                // (child exited, transport closed, stdin write failed). For
                // session/prompt — which carries an infinite timeout — that
                // marker means exactly one thing: the ACP child process died
                // (routinely a hermes gateway daemon restart) and the closed
                // transport would fail every later request the same way.
                // Regular JSON-RPC rejections (unknown session, etc.) do not
                // carry it and keep the old surface-and-continue behavior.
                if (isAcpIndeterminateError(error) && !this.shouldExit) {
                    // Rebuild the backend, re-establish the ACP session, and
                    // retry THIS batch exactly once; a failure here surfaces
                    // and falls through — the loop stays alive and the next
                    // message attempts a fresh respawn.
                    let revived = false
                    try {
                        await this.respawnBackend()
                        revived = true
                    } catch (respawnError) {
                        const reconnectMessage = respawnError instanceof Error ? respawnError.message : String(respawnError)
                        logger.warn('[hermes-acp] reconnect failed', { message: reconnectMessage })
                        failureMessage = `Hermes reconnect failed: ${reconnectMessage}`
                    }
                    if (revived) {
                        // The fresh process lost the dead turn's session
                        // state: re-apply the batch's edit mode before the
                        // retry (establishBackend already restored the
                        // session-stored mode; the dedupe makes this a no-op
                        // when they map to the same edit mode).
                        if (batch.mode.permissionMode !== undefined) {
                            await this.applyHermesEditMode(this.backend!, this.acpSessionId!, batch.mode.permissionMode)
                        }
                        try {
                            await this.backend!.prompt(this.acpSessionId!, prompt, (message) => this.handleAgentMessage(message))
                        } catch (retryError) {
                            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
                            logger.warn('[hermes-acp] prompt failed after reconnect', { message: retryMessage })
                            failureMessage = `Hermes prompt failed after reconnect: ${retryMessage}`
                        }
                    }
                } else {
                    failureMessage = `Hermes prompt failed: ${message}`
                }
            }
            if (failureMessage !== null) {
                this.session.sendSessionEvent({ type: 'message', message: failureMessage })
                this.messageBuffer.addMessage(failureMessage, 'status')
            }
            this.session.onThinkingChange(false)
            await this.permissionHandler?.cancelAll('Prompt finished')
            if (this.session.queue.size() === 0 && !this.shouldExit) {
                this.session.sendSessionEvent({ type: 'ready' })
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        await this.backend?.disconnect()
        this.backend = null
        if (this.happyServer) {
            this.happyServer.stop()
            this.happyServer = null
        }
    }

    /**
     * Create a Hermes backend and drive it to a live, fully configured ACP
     * session: initialize → resume-or-new session (replay-suppressed) → pin +
     * flush hermesSessionId → model discovery/override → catalog readiness →
     * permission handler → edit mode.
     *
     * Shared by the initial launch and by post-death respawns. The `respawn`
     * flag only changes model handling: an initial establishment captures the
     * server default and applies the spawn-time override, while a respawn
     * keeps the captured default and re-applies the LIVE user preference.
     */
    private async establishBackend(opts: { respawn: boolean }): Promise<void> {
        const backend = createHermesBackend()
        this.backend = backend
        this.acpSessionId = null
        // Native session_info_update titles are deliberately NOT mirrored:
        // Hermes seeds its gateway session title with the raw first user
        // message, and mirroring it into metadata.summary suppresses the
        // Hub's own title generation. The Hub owns Hermes session titles,
        // matching the other ACP flavors without a native rename tool.
        backend.onStderrError((error) => {
            logger.debug('[hermes-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        // A failing establishment rejects `ready` through markFailed below;
        // with no catalog query parked on it yet, that rejection would
        // otherwise surface as an unhandled promise rejection.
        ready.catch(() => {})
        this.modelsReadiness = { backend, promise: ready, resolve: markReady, reject: markFailed }

        let acpSessionId: string
        try {
            await backend.initialize()

            const resumeSessionId = this.session.sessionId
            if (resumeSessionId) {
                try {
                    // Hermes implements `session/resume` and — unlike DSH —
                    // REPLAYS the restored session history as session/update
                    // notifications. HAPI's hub remains the transcript source
                    // for the UI, so the replay is suppressed; without this
                    // every resume would duplicate the transcript.
                    if (!backend.supportsSessionResume()) {
                        throw new Error('Hermes ACP server does not advertise session/resume')
                    }
                    acpSessionId = await backend.suppressUpdatesDuring(() =>
                        backend.resumeSession({
                            sessionId: resumeSessionId,
                            cwd: this.session.path,
                            // Hermes mounts client MCP servers on resume too:
                            // same bridge list as session/new so a respawned
                            // child remounts the hapi tools.
                            mcpServers: this.acpMcpServers
                        })
                    )
                } catch (error) {
                    logger.warn('[hermes-acp] resume failed, starting a new session', error)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Hermes resume failed; starting a new session.'
                    })
                    acpSessionId = await backend.newSession({
                        cwd: this.session.path,
                        mcpServers: this.acpMcpServers
                    })
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    mcpServers: this.acpMcpServers
                })
            }
            this.acpSessionId = acpSessionId
            this.session.onSessionFound(acpSessionId)
            // Pin hermesSessionId before the main loop so a runner restart can
            // resume (tiann/hapi#913, ported from dsh: gate until the metadata
            // write reaches the hub — a SIGTERM before that strands the session
            // with no resume key). Re-pinning after a respawn is an idempotent
            // metadata merge.
            const flushed = await this.session.client.flushMetadata()
            if (!flushed) {
                logger.warn(`[hermes-acp] hermesSessionId metadata write did not ACK within the flush window (acpSessionId=${acpSessionId})`)
            }
        } catch (error) {
            markFailed(error)
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!opts.respawn) {
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
        } else if (this.currentBackendModel && modelOption && modelOption.currentValue !== this.currentBackendModel) {
            // The respawned child starts from whatever the daemon persisted;
            // re-apply the live user preference so the retried batch runs on
            // the model the session is showing.
            await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
        }
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        markReady(acpSessionId)

        // Auto-approval consults the LIVE session mode: a mid-turn switch to
        // yolo starts auto-approving request_permission immediately, while the
        // Hermes-side edit mode (session/set_mode) catches up at the next turn
        // boundary below.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined
        )
        const sessionPermissionMode = this.session.getPermissionMode() as PermissionMode | undefined
        this.applyDisplayMode(sessionPermissionMode)
        await this.applyHermesEditMode(backend, acpSessionId, sessionPermissionMode)
    }

    /**
     * Tear down a dead backend and re-establish the ACP session on a fresh
     * `hermes acp` child process.
     *
     * Once the ACP child dies (gateway daemon restart, crash) its transport
     * is closed permanently — every request on it rejects immediately — so
     * recovery requires a brand-new backend: initialize, resume the persisted
     * daemon session id (Hermes keeps gateway sessions alive across ACP
     * child restarts, replay-suppressed exactly like the initial resume),
     * re-apply the current model preference and edit mode, and re-arm the
     * catalog readiness. Posts exactly one 'connection lost; reconnecting'
     * status line per attempt.
     *
     * Throws when re-establishment fails; `this.backend` is then null so the
     * next message starts a fresh attempt instead of reusing the corpse.
     */
    private async respawnBackend(): Promise<void> {
        if (this.respawnInProgress) {
            throw new Error('Hermes reconnect already in progress')
        }
        this.respawnInProgress = true
        try {
            this.session.sendSessionEvent({ type: 'message', message: 'Hermes connection lost; reconnecting…' })
            this.messageBuffer.addMessage('Hermes connection lost; reconnecting…', 'status')
            const deadBackend = this.backend
            const deadPermissionHandler = this.permissionHandler
            // Detach everything bound to the dead backend BEFORE rebuilding so
            // concurrent aborts, catalog queries, and the retry below can only
            // ever observe the replacement.
            this.backend = null
            this.acpSessionId = null
            this.permissionHandler = null
            // The fresh process starts at the server-default edit mode; clear
            // the dedupe so establishBackend re-issues session/set_mode.
            this.lastAppliedEditMode = null
            try {
                await deadPermissionHandler?.cancelAll('Hermes connection lost')
            } catch (error) {
                logger.debug('[hermes-acp] permission cancelAll during reconnect failed', error)
            }
            try {
                await deadBackend?.disconnect()
            } catch (error) {
                logger.debug('[hermes-acp] disconnect of dead backend failed', error)
            }
            await this.establishBackend({ respawn: true })
        } catch (error) {
            // establishBackend may have parked a half-initialized backend in
            // this.backend; drop it so the next message rebuilds cleanly.
            const partial = this.backend
            this.backend = null
            this.acpSessionId = null
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[hermes-acp] disconnect of partial backend failed', disconnectError)
            }
            throw error
        } finally {
            this.respawnInProgress = false
        }
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
     * Push the HAPI permission mode onto Hermes's edit-approval axis via
     * `session/set_mode` (default / accept_edits / dont_ask). Only the edit
     * axis lives in Hermes; dangerous-command approvals always arrive as
     * request_permission and are decided by the HAPI permission bridge. No-op
     * when the mode is unchanged; failures degrade to a status note because
     * the bridge still honors the mode on the HAPI side.
     */
    private async applyHermesEditMode(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        permissionMode: PermissionMode | undefined
    ): Promise<void> {
        const editMode = HERMES_EDIT_MODE_BY_PERMISSION[permissionMode ?? 'default'] ?? 'default'
        if (editMode === this.lastAppliedEditMode) return
        try {
            await backend.setMode(acpSessionId, editMode, { syncThoughtLevel: false })
            this.lastAppliedEditMode = editMode
            logger.debug(`[hermes-acp] Applied edit mode via set_mode: ${editMode}`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[hermes-acp] set_mode failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Hermes edit mode switch failed: ${message}`
            })
        }
    }

    /**
     * Switch the Hermes model through `session/set_config_option` — Hermes
     * has no parameterized model picker; models surface as config options of
     * category `model`. Model ids are opaque `provider:model` strings sent
     * back verbatim; unknown ids fail loud with -32602. Returns the applied
     * model, or null when the switch failed (caller keeps the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[hermes-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the Hermes agent exposes no model config option.'
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
            logger.warn('[hermes-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch Hermes model: ${message}`
            })
            return null
        }
    }

    private async handleAbort(): Promise<void> {
        // Tear the wait down synchronously FIRST (ported from dsh): aborting
        // and replacing the controller unparks a waiting loop iteration via
        // its captured signal, and resetting the queue before the awaits drops
        // anything queued ahead of the stop — a message dequeued while the
        // cancel requests are still on the wire must not run after the user
        // already saw "Session aborted".
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        // Reads the CURRENT backend: after a respawn this cancels on the
        // replacement; mid-respawn it is null and the skip is correct (the
        // dead transport cannot accept a cancel anyway).
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.onThinkingChange(false)
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
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
