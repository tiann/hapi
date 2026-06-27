import { logger } from '@/ui/logger';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, createModeChangeHandler, setControlledByUser } from '@/agent/runnerLifecycle';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { OmpTransport, resolveOmpCommand, defaultOmpArgs } from './ompTransport';
import { OmpSession } from './session';
import { parseOmpModels, parseOmpCommands, sendOmpRpcAndWait, wireTransportEvents } from './loop';
import { OmpThinkingLevelSchema, SetSessionConfigPayloadSchema } from './schemas';
import type { PiThinkingLevel } from './types';
import type { SlashCommandsResponse } from '@hapi/protocol/apiTypes';
import type { ListOmpModelsResponse } from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export async function runOmp(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    // OMP only runs as `omp --mode rpc` with piped stdio — there is no local
    // terminal/TUI input path (unlike Claude/Codex). Defaulting a terminal
    // launch to 'local' would mark the session local-controlled while the user
    // cannot drive it from the terminal, leaving it stuck until a web switch.
    // Default to 'remote' so the session is immediately drivable from the web.
    const startingMode: 'local' | 'remote' = opts.startingMode ?? 'remote';

    logger.debug(`[omp] Starting with options: startedBy=${startedBy}, startingMode=${startingMode}`);

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'omp',
            startedBy,
            workingDirectory,
        })
        : await bootstrapSession({
            flavor: 'omp',
            startedBy,
            workingDirectory,
            // Do not seed the hub session model from opts.model: it is unconfirmed
            // until get_available_models/set_model accept it. OmpSession carries
            // opts.model as initialModel and applies it once confirmed.
            model: undefined
        });
    const { session: apiSession } = bootstrap;

    setControlledByUser(apiSession, startingMode);

    const ompSession = new OmpSession({
        api: bootstrap.api,
        client: apiSession,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        startedBy,
        startingMode,
        model: opts.model,
    });

    // OMP resume: OMP has no `--session-id` rpc flag (unlike Pi). `--continue`
    // restores the most-recent session in the cwd-derived dir, which is wrong
    // when a directory holds more than one OMP session. Instead, start a fresh
    // rpc session and switch_session to the exact ompSessionFile (the hub
    // resolves resumeSessionId to ompSessionFile). OMP's switch_session is
    // idempotent on the same file, so a no-op switch on the already-current
    // session is harmless.
    const transportArgs = defaultOmpArgs();
    const transport = new OmpTransport({
        command: resolveOmpCommand(),
        args: transportArgs,
        cwd: workingDirectory,
    });

    ompSession.startKeepAlive();

    let killedByCleanup = false;
    const lifecycle = createRunnerLifecycle({
        session: apiSession,
        logTag: 'omp',
        stopKeepAlive: () => ompSession.stopKeepAlive(),
        onAfterClose: () => {
            ompSession.stopKeepAlive();
            killedByCleanup = true;
            transport.kill();
        }
    });

    lifecycle.registerProcessHandlers();
    // #923 fix: pass the lifecycle object (not the bare cleanupAndExit callback)
    // so the KillSession RPC stamps 'User terminated' before cleanup.
    registerKillSessionHandler(apiSession.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(apiSession.rpcHandlerManager, lifecycle);

    let cleanupInitiated = false;
    const safeCleanup = async () => {
        if (cleanupInitiated) return;
        cleanupInitiated = true;
        await lifecycle.cleanupAndExit();
    };

    // Pending user-message localIds in FIFO order
    const pendingLocalIds: string[] = [];

    // --- Transport error/close handlers ---
    transport.onError((error) => {
        logger.debug(`[omp] Transport error: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onClose((code, signal) => {
        if (killedByCleanup) {
            logger.debug(`[omp] OMP process closed during lifecycle cleanup (code=${code}, signal=${signal})`);
            void safeCleanup();
            return;
        }
        const reason = signal
            ? `OMP process killed by signal ${signal}`
            : `OMP process exited with code ${code ?? 'null'}`;
        logger.debug(`[omp] ${reason}`);
        lifecycle.markCrash(new Error(reason));
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(reason.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    // --- Wire transport events to session ---
    // Capture the requested startup effort WITHOUT mutating currentThinkingLevel.
    // It is applied (and committed) only after OMP confirms set_thinking_level;
    // seeding it here would leak an unconfirmed/rejected value via the first
    // keepAlive. get_state's thinkingLevel is authoritative until then.
    let startupThinkingLevel: PiThinkingLevel | null = null;
    if (opts.effort) {
        const result = OmpThinkingLevelSchema.safeParse(opts.effort.trim().toLowerCase());
        if (result.success) {
            startupThinkingLevel = result.data;
        } else {
            logger.debug(`[omp] Ignoring invalid effort value on resume: ${opts.effort}`);
        }
    }

    wireTransportEvents(transport, ompSession, pendingLocalIds);

    // --- Session config RPC ---
    // OMP manually registers SetSessionConfig (same rationale as Pi): OMP's wire
    // protocol requires separate provider + modelId fields, while
    // registerSessionConfigRpc only handles model as a simple string.
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (rawPayload: unknown) => {
        const parsed = SetSessionConfigPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
            throw new Error('Invalid session config payload');
        }
        const config = parsed.data;
        logger.debug(`[omp] SetSessionConfig received: ${JSON.stringify(config)}`);

        // OMP rpc mode fixes --approval-mode=yolo at spawn; the only permission
        // mode offered is 'yolo'. Validate any incoming permissionMode so the
        // hub's applySessionConfig sees it applied (otherwise it rejects with
        // "Session did not apply permissionMode" when the web posts /permission-mode).
        if (config.permissionMode !== undefined && config.permissionMode !== 'yolo') {
            throw new Error(`Unsupported permission mode for OMP: ${String(config.permissionMode)}`);
        }
        const appliedPermissionMode = config.permissionMode === 'yolo' ? 'yolo' as const : undefined;

        let requestedModel: { modelId: string | null; provider: string | null } | undefined;
        if (config.model !== undefined) {
            const modelValue = config.model;
            if (modelValue === null) {
                requestedModel = { modelId: null, provider: null };
            } else if (typeof modelValue === 'string') {
                const trimmed = modelValue.trim();
                if (!trimmed) throw new Error('Invalid model');
                const cached = ompSession.cachedOmpModels.find(m => m.modelId === trimmed);
                requestedModel = { modelId: trimmed, provider: cached?.provider ?? null };
            } else {
                // { provider, modelId } form — validate non-empty modelId for
                // parity with the string branch (which throws on empty).
                const trimmedId = modelValue.modelId.trim();
                if (!trimmedId) throw new Error('Invalid model');
                requestedModel = { modelId: trimmedId, provider: modelValue.provider };
            }
        }
        let requestedThinkingLevel: PiThinkingLevel | null | undefined;
        if (config.effort !== undefined) {
            if (config.effort === null) {
                requestedThinkingLevel = null;
            } else {
                const result = OmpThinkingLevelSchema.safeParse(
                    typeof config.effort === 'string' ? config.effort.trim().toLowerCase() : config.effort,
                );
                if (!result.success) throw new Error('Invalid effort');
                requestedThinkingLevel = result.data;
            }
        }

        // Forward to OMP and await confirmation before committing, so the hub
        // does not persist a model/effort OMP rejected.
        if (requestedModel) {
            if (requestedModel.modelId && requestedModel.provider) {
                await sendOmpRpcAndWait(ompSession, transport, {
                    type: 'set_model',
                    provider: requestedModel.provider,
                    modelId: requestedModel.modelId,
                });
                ompSession.currentModel = requestedModel.modelId;
                ompSession.currentProvider = requestedModel.provider;
            } else if (requestedModel.modelId && !requestedModel.provider) {
                logger.debug('[omp] set_model suppressed: provider unknown until get_state');
                throw new Error('Model cannot be applied yet: provider is not yet known');
            } else if (requestedModel.modelId === null) {
                // OMP's RPC protocol has no "unset model" command, so this only
                // clears the hapi-side tracking — OMP keeps using its current model.
                // This path is not reachable from the web OMP picker today; the
                // known state divergence (web shows null while OMP keeps its model)
                // is accepted until OMP adds an unset command.
                ompSession.currentModel = null;
                ompSession.currentProvider = null;
            }
        }
        if (requestedThinkingLevel !== undefined) {
            const level = requestedThinkingLevel ?? 'off';
            await sendOmpRpcAndWait(ompSession, transport, { type: 'set_thinking_level', level });
            ompSession.currentThinkingLevel = requestedThinkingLevel;
            // User-driven change wins over any pending startup-level apply.
            ompSession.initialThinkingLevelApplied = true;
        }
        ompSession.pushKeepAlive();

        const appliedModel = ompSession.currentModel && ompSession.currentProvider
            ? { provider: ompSession.currentProvider, modelId: ompSession.currentModel }
            : ompSession.currentModel;

        return {
            applied: {
                ...(appliedPermissionMode ? { permissionMode: appliedPermissionMode } : {}),
                model: appliedModel,
                effort: ompSession.currentThinkingLevel,
            },
        };
    });

    // --- OMP model discovery RPC ---
    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, ListOmpModelsResponse>(
        RPC_METHODS.ListOmpModels,
        async () => {
            if (ompSession.cachedOmpModels.length > 0) {
                return {
                    success: true,
                    availableModels: ompSession.cachedOmpModels,
                    currentModelId: ompSession.currentModel,
                };
            }
            try {
                const data = await sendOmpRpcAndWait(ompSession, transport, { type: 'get_available_models' });
                const models = parseOmpModels(data);
                if (models.length > 0) {
                    ompSession.cachedOmpModels = models;
                    ompSession.updateMetadata(meta => ({ ...meta, ompAvailableModels: models }));
                }
                return { success: true, availableModels: models, currentModelId: ompSession.currentModel };
            } catch (error) {
                logger.debug('[omp] ListOmpModels RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to list OMP models',
                };
            }
        }
    );

    // --- Slash commands (OMP pushes via available_commands_update; fall back
    // to get_available_commands if nothing pushed yet) ---
    apiSession.rpcHandlerManager.registerHandler<{ agent?: string }, SlashCommandsResponse>(
        RPC_METHODS.ListSlashCommands,
        async () => {
            let commands = ompSession.cachedOmpCommands;
            if (commands.length === 0) {
                try {
                    const data = await sendOmpRpcAndWait(ompSession, transport, { type: 'get_available_commands' });
                    commands = parseOmpCommands(data);
                    if (commands.length > 0) {
                        ompSession.cachedOmpCommands = commands;
                    }
                } catch {
                    // Fall through to return empty
                }
            }
            return {
                success: true,
                commands: commands.map((cmd) => ({
                    name: cmd.name,
                    description: cmd.description,
                    // Map OMP sources onto hapi's web slash-command sources:
                    // builtin/extension/skill/mcp_prompt/file → plugin; prompt → user.
                    source: cmd.source === 'prompt' ? 'user' as const : 'plugin' as const,
                })),
            };
        }
    );

    // --- User message handler ---
    apiSession.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        if (ompSession.ompIsStreaming) {
            // Steer does not start a new turn, so the localId would never be
            // drained by turn_start. Mark it consumed immediately.
            transport.send({ type: 'steer', message: formattedText });
            if (localId) ompSession.emitMessagesConsumed([localId]);
        } else {
            if (localId) pendingLocalIds.push(localId);
            transport.send({ type: 'prompt', message: formattedText });
        }
    });

    // --- Abort handler ---
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        transport.send({ type: 'abort' });
        ompSession.ompIsStreaming = false;
        ompSession.updateThinkingState(false);
        if (pendingLocalIds.length > 0) {
            ompSession.emitMessagesConsumed([pendingLocalIds.shift()!]);
        }
        return { success: true };
    });

    // --- Switch handler (local ↔ remote control ownership) ---
    const handleModeChange = createModeChangeHandler(apiSession);
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async (payload: { to?: 'local' | 'remote' } = {}) => {
        const mode = payload.to ?? 'remote';
        ompSession.setMode(mode);
        handleModeChange(mode);
        return { success: true };
    });

    // --- OMP superset RPC handlers (hapi → OMP, single-direction) ---
    // These surface OMP-only commands to the hub/web. Each forwards the command
    // to OMP via sendOmpRpcAndWait (awaits confirmation) and commits confirmed
    // state onto OmpSession so keepAlive reports it.

    apiSession.rpcHandlerManager.registerHandler<{ customInstructions?: string }, { success: boolean }>(
        RPC_METHODS.OmpCompact,
        async (payload = {}) => {
            try {
                await sendOmpRpcAndWait(ompSession, transport, {
                    type: 'compact',
                    ...(payload.customInstructions ? { customInstructions: payload.customInstructions } : {}),
                });
                return { success: true };
            } catch (error) {
                logger.debug(`[omp] compact failed: ${error instanceof Error ? error.message : String(error)}`);
                return { success: false };
            }
        }
    );

    apiSession.rpcHandlerManager.registerHandler<{ mode: 'all' | 'one-at-a-time' }, { success: boolean }>(
        RPC_METHODS.OmpSetSteeringMode,
        async (payload) => {
            const mode = payload?.mode;
            if (mode !== 'all' && mode !== 'one-at-a-time') {
                throw new Error('Invalid steering mode (expected all or one-at-a-time)');
            }
            await sendOmpRpcAndWait(ompSession, transport, { type: 'set_steering_mode', mode });
            ompSession.currentSteeringMode = mode;
            return { success: true };
        }
    );

    apiSession.rpcHandlerManager.registerHandler<{ mode: 'immediate' | 'wait' }, { success: boolean }>(
        RPC_METHODS.OmpSetInterruptMode,
        async (payload) => {
            const mode = payload?.mode;
            if (mode !== 'immediate' && mode !== 'wait') {
                throw new Error('Invalid interrupt mode (expected immediate or wait)');
            }
            await sendOmpRpcAndWait(ompSession, transport, { type: 'set_interrupt_mode', mode });
            ompSession.currentInterruptMode = mode;
            return { success: true };
        }
    );

    apiSession.rpcHandlerManager.registerHandler<{ mode: 'all' | 'one-at-a-time' }, { success: boolean }>(
        RPC_METHODS.OmpSetFollowUpMode,
        async (payload) => {
            const mode = payload?.mode;
            if (mode !== 'all' && mode !== 'one-at-a-time') {
                throw new Error('Invalid follow-up mode (expected all or one-at-a-time)');
            }
            await sendOmpRpcAndWait(ompSession, transport, { type: 'set_follow_up_mode', mode });
            ompSession.currentFollowUpMode = mode;
            return { success: true };
        }
    );

    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, { success: boolean; model?: unknown }>(
        RPC_METHODS.OmpCycleModel,
        async () => {
            try {
                const data = await sendOmpRpcAndWait(ompSession, transport, { type: 'cycle_model' });
                // OMP cycle_model response: { model: { provider, id }, thinkingLevel, isScoped } | null.
                // Guard the external response shape before committing to session state.
                const result = (data && typeof data === 'object' ? data : null) as { model?: { provider?: unknown; id?: unknown } } | null;
                const model = result?.model;
                if (model && typeof model === 'object' && typeof model.id === 'string') {
                    ompSession.currentModel = model.id;
                    if (typeof model.provider === 'string' && model.provider.length > 0) {
                        ompSession.currentProvider = model.provider;
                    }
                    ompSession.pushKeepAlive();
                }
                return { success: true, model: result?.model };
            } catch (error) {
                logger.debug(`[omp] cycle_model failed: ${error instanceof Error ? error.message : String(error)}`);
                return { success: false };
            }
        }
    );

    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, { success: boolean; level?: string | null }>(
        RPC_METHODS.OmpCycleThinkingLevel,
        async () => {
            try {
                const data = await sendOmpRpcAndWait(ompSession, transport, { type: 'cycle_thinking_level' });
                // OMP cycle_thinking_level response: { level: Effort } | null.
                // Validate level against the thinking-level enum before committing.
                const result = (data && typeof data === 'object' ? data : null) as { level?: unknown } | null;
                const levelResult = result?.level !== undefined && result.level !== null
                    ? OmpThinkingLevelSchema.safeParse(typeof result.level === 'string' ? result.level.trim().toLowerCase() : result.level)
                    : { success: false } as const;
                if (levelResult.success) {
                    ompSession.currentThinkingLevel = levelResult.data;
                    ompSession.pushKeepAlive();
                }
                return { success: true, level: levelResult.success ? levelResult.data : null };
            } catch (error) {
                logger.debug(`[omp] cycle_thinking_level failed: ${error instanceof Error ? error.message : String(error)}`);
                return { success: false };
            }
        }
    );

    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, { success: boolean; stats?: unknown }>(
        RPC_METHODS.OmpGetSessionStats,
        async () => {
            try {
                const stats = await sendOmpRpcAndWait(ompSession, transport, { type: 'get_session_stats' });
                return { success: true, stats };
            } catch (error) {
                logger.debug(`[omp] get_session_stats failed: ${error instanceof Error ? error.message : String(error)}`);
                return { success: false };
            }
        }
    );

    // --- Run ---
    let crashed = false;
    try {
        transport.start();
        // OMP pushes `{"type":"ready"}` before accepting commands; wait for it
        // so the initial handshake isn't dropped. ready() rejects on 10s
        // timeout or process exit before ready.
        await transport.ready();

        // On a fresh launch, create a new OMP session. On resume, switch_session
        // to the exact ompSessionFile (resolved by the hub from ompSessionFile
        // metadata) instead of relying on `--continue`'s most-recent heuristic,
        // which attaches the wrong conversation when a cwd has multiple sessions.
        if (opts.resumeSessionId) {
            try {
                const result = await sendOmpRpcAndWait(ompSession, transport, {
                    type: 'switch_session',
                    sessionPath: opts.resumeSessionId,
                }) as { cancelled?: boolean } | null;
                if (result?.cancelled) {
                    logger.debug(`[omp] switch_session cancelled by extension for ${opts.resumeSessionId}`);
                }
            } catch (error) {
                logger.debug(`[omp] switch_session failed, falling back to fresh session: ${error instanceof Error ? error.message : String(error)}`);
                transport.send({ type: 'new_session' });
            }
        } else {
            transport.send({ type: 'new_session' });
        }
        transport.send({ type: 'get_state' });
        transport.send({ type: 'get_available_models' });

        // Apply the requested startup effort only after OMP confirms
        // set_thinking_level. Detached so the run loop is not blocked; sent
        // after get_state so the authoritative baseline lands first.
        if (startupThinkingLevel) {
            void (async () => {
                try {
                    await sendOmpRpcAndWait(ompSession, transport, {
                        type: 'set_thinking_level',
                        level: startupThinkingLevel,
                    });
                    // If the user changed effort via SetSessionConfig during the
                    // await, keep their choice instead of clobbering it.
                    if (ompSession.initialThinkingLevelApplied) {
                        logger.debug('[omp] Startup effort skipped: user already changed effort');
                        return;
                    }
                    ompSession.currentThinkingLevel = startupThinkingLevel;
                    ompSession.initialThinkingLevelApplied = true;
                    ompSession.pushKeepAlive();
                    logger.debug(`[omp] Startup effort applied: ${startupThinkingLevel}`);
                } catch (error) {
                    logger.debug(`[omp] Startup effort rejected, keeping OMP default: ${error instanceof Error ? error.message : String(error)}`);
                }
            })();
        }

        // Block until cleanup is triggered by error/close handler
        await new Promise<void>((resolve) => {
            const origCleanup = lifecycle.cleanupAndExit.bind(lifecycle);
            lifecycle.cleanupAndExit = async (codeOverride?: number) => {
                resolve();
                await origCleanup(codeOverride);
            };
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        lifecycle.setSessionEndReason('error');
        logger.debug('[omp] Loop error:', error);
    } finally {
        if (!crashed && !lifecycle.hasExplicitSessionEndReason()) {
            lifecycle.setSessionEndReason('completed');
        }
        await safeCleanup();
    }
}
