import { logger } from '@/ui/logger';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, createModeChangeHandler, setControlledByUser } from '@/agent/runnerLifecycle';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PiTransport } from './piTransport';
import { PiSession } from './session';
import { parsePiModels, parsePiCommands, sendPiRpcAndWait, wireTransportEvents } from './loop';
import { PiThinkingLevelSchema, SetSessionConfigPayloadSchema } from './schemas';
import type { PiThinkingLevel } from './types';
import type { SlashCommandsResponse } from '@hapi/protocol/apiTypes';
import type { ListPiModelsResponse } from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export async function runPi(opts: {
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
    // Pi only runs as `pi --mode rpc` with piped stdio — there is no local
    // terminal/TUI input path (unlike Claude/Codex). Defaulting a terminal
    // launch to 'local' would mark the session local-controlled while the user
    // cannot drive it from the terminal, leaving it stuck until a web switch.
    // Default to 'remote' so the session is immediately drivable from the web;
    // an explicit opts.startingMode (e.g. runner) still takes precedence.
    const startingMode: 'local' | 'remote' = opts.startingMode ?? 'remote';

    logger.debug(`[pi] Starting with options: startedBy=${startedBy}, startingMode=${startingMode}`);

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'pi',
            startedBy,
            workingDirectory,
        })
        : await bootstrapSession({
            flavor: 'pi',
            startedBy,
            workingDirectory,
            // Do not seed the hub session model from opts.model: it is unconfirmed
            // until get_available_models/set_model accept it. The hub's
            // handleSessionAlive persists every non-undefined keepAlive model, so
            // passing it here would store/show a model Pi may reject. PiSession
            // carries opts.model as initialModel and applies it once confirmed.
            model: undefined
        });
    const { session: apiSession } = bootstrap;

    setControlledByUser(apiSession, startingMode);

    const piSession = new PiSession({
        api: bootstrap.api,
        client: apiSession,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        startedBy,
        startingMode,
        model: opts.model,
    });

    const transportArgs = ['--mode', 'rpc'];
    if (opts.resumeSessionId) {
        transportArgs.push('--session-id', opts.resumeSessionId);
    }
    const transport = new PiTransport({ command: 'pi', args: transportArgs, cwd: workingDirectory });

    piSession.startKeepAlive();

    let killedByCleanup = false;
    const lifecycle = createRunnerLifecycle({
        session: apiSession,
        logTag: 'pi',
        stopKeepAlive: () => piSession.stopKeepAlive(),
        onAfterClose: () => {
            piSession.stopKeepAlive();
            killedByCleanup = true;
            transport.kill();
        }
    });

    lifecycle.registerProcessHandlers();
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
        logger.debug(`[pi] Transport error: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onClose((code, signal) => {
        if (killedByCleanup) {
            logger.debug(`[pi] Pi process closed during lifecycle cleanup (code=${code}, signal=${signal})`);
            void safeCleanup();
            return;
        }
        const reason = signal
            ? `Pi process killed by signal ${signal}`
            : `Pi process exited with code ${code ?? 'null'}`;
        logger.debug(`[pi] ${reason}`);
        lifecycle.markCrash(new Error(reason));
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(reason.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    // --- Wire transport events to session ---
    // Capture the requested startup effort WITHOUT mutating currentThinkingLevel.
    // It is applied (and committed) only after Pi confirms set_thinking_level,
    // mirroring the startup-model contract; seeding it here would leak an
    // unconfirmed/rejected value via the first keepAlive (pushKeepAlive persists
    // effort) before the RPC runs. get_state's thinkingLevel is the authoritative
    // source until set_thinking_level succeeds.
    let startupThinkingLevel: PiThinkingLevel | null = null;
    if (opts.effort) {
        const result = PiThinkingLevelSchema.safeParse(opts.effort.trim().toLowerCase());
        if (result.success) {
            startupThinkingLevel = result.data;
        } else {
            logger.debug(`[pi] Ignoring invalid effort value on resume: ${opts.effort}`);
        }
    }

    wireTransportEvents(transport, piSession, pendingLocalIds);

    // --- Session config RPC ---
    //
    // Pi manually registers SetSessionConfig instead of using
    // registerSessionConfigRpc() because Pi's wire protocol requires
    // separate provider + modelId fields (transport.send({ type:
    // 'set_model', provider, modelId })), while registerSessionConfigRpc
    // only handles model as a simple string. The hub sends model as
    // { provider, modelId } for Pi sessions.

    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (rawPayload: unknown) => {
        const parsed = SetSessionConfigPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
            throw new Error('Invalid session config payload');
        }
        const config = parsed.data;
        logger.debug(`[pi] SetSessionConfig received: ${JSON.stringify(config)}`);

        // Resolve requested values WITHOUT mutating PiSession yet. Commit them
        // only after Pi confirms via sendPiRpcAndWait, otherwise a rejected
        // set_model/set_thinking_level would leave PiSession holding unconfirmed
        // values that the 2s keepalive reports back to the hub, persisting a
        // model/effort Pi never accepted.
        let requestedModel: { modelId: string | null; provider: string | null } | undefined;
        if (config.model !== undefined) {
            const modelValue = config.model;
            logger.debug(`[pi] SetSessionConfig model: ${JSON.stringify(modelValue)}`);

            if (modelValue === null) {
                requestedModel = { modelId: null, provider: null };
            } else if (typeof modelValue === 'string') {
                const trimmed = modelValue.trim();
                if (!trimmed) throw new Error('Invalid model');
                // Fallback: search cached models for provider
                const cached = piSession.cachedPiModels.find(m => m.modelId === trimmed);
                requestedModel = { modelId: trimmed, provider: cached?.provider ?? null };
            } else {
                // { provider, modelId } form
                requestedModel = { modelId: modelValue.modelId, provider: modelValue.provider };
            }
            logger.debug(`[pi] SetSessionConfig resolved: model=${requestedModel.modelId}, provider=${requestedModel.provider}`);
        }
        let requestedThinkingLevel: PiThinkingLevel | null | undefined;
        if (config.effort !== undefined) {
            if (config.effort === null) {
                requestedThinkingLevel = null;
            } else {
                const result = PiThinkingLevelSchema.safeParse(
                    typeof config.effort === 'string' ? config.effort.trim().toLowerCase() : config.effort,
                );
                if (!result.success) throw new Error('Invalid effort');
                requestedThinkingLevel = result.data;
            }
        }

        // Forward changes to Pi process — wait for Pi to confirm before
        // committing to PiSession or reporting applied, so the hub does not
        // persist a model/effort that Pi rejected (e.g. invalid provider/model
        // or thinking level) or that the RPC timed out on.
        if (requestedModel) {
            if (requestedModel.modelId && requestedModel.provider) {
                await sendPiRpcAndWait(piSession, transport, {
                    type: 'set_model',
                    provider: requestedModel.provider,
                    modelId: requestedModel.modelId,
                });
                piSession.currentModel = requestedModel.modelId;
                piSession.currentProvider = requestedModel.provider;
            } else if (requestedModel.modelId && !requestedModel.provider) {
                // Provider is unknown until get_state/get_available_models resolve.
                // Committing now would persist piSelectedModel while Pi never received
                // set_model — contradicting the "await Pi confirmation" contract above.
                // Throw so the hub returns 409 and the web client can retry once the
                // provider is known.
                logger.debug('[pi] set_model suppressed: provider unknown until get_state');
                throw new Error('Model cannot be applied yet: provider is not yet known');
            } else if (requestedModel.modelId === null) {
                // Clearing the model needs no Pi RPC (nothing to confirm), so commit
                // immediately. This path is not reachable from the web Pi picker today.
                piSession.currentModel = null;
                piSession.currentProvider = null;
            }
        }
        if (requestedThinkingLevel !== undefined) {
            const level = requestedThinkingLevel ?? 'off';
            await sendPiRpcAndWait(piSession, transport, { type: 'set_thinking_level', level });
            piSession.currentThinkingLevel = requestedThinkingLevel;
        }
        piSession.pushKeepAlive();

        // Return provider-qualified model so the hub persists piSelectedModel.
        // A bare modelId string would make applySessionConfig clear the
        // provider metadata (object check fails), defeating Fix #3.
        const appliedModel = piSession.currentModel && piSession.currentProvider
            ? { provider: piSession.currentProvider, modelId: piSession.currentModel }
            : piSession.currentModel;

        return {
            applied: {
                model: appliedModel,
                effort: piSession.currentThinkingLevel,
            },
        };
    });

    // --- Pi model discovery RPC ---
    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, ListPiModelsResponse>(
        RPC_METHODS.ListPiModels,
        async () => {
            if (piSession.cachedPiModels.length > 0) {
                return {
                    success: true,
                    availableModels: piSession.cachedPiModels,
                    currentModelId: piSession.currentModel,
                };
            }
            try {
                const data = await sendPiRpcAndWait(piSession, transport, { type: 'get_available_models' });
                const models = parsePiModels(data);
                if (models.length > 0) {
                    piSession.cachedPiModels = models;
                    piSession.updateMetadata(meta => ({ ...meta, piAvailableModels: models }));
                }
                return { success: true, availableModels: models, currentModelId: piSession.currentModel };
            } catch (error) {
                logger.debug('[pi] ListPiModels RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to list Pi models',
                };
            }
        }
    );

    // --- Slash commands (Pi skills/commands) ---
    apiSession.rpcHandlerManager.registerHandler<{ agent?: string }, SlashCommandsResponse>(
        RPC_METHODS.ListSlashCommands,
        async () => {
            let commands = piSession.cachedPiCommands;
            if (commands.length === 0) {
                try {
                    const data = await sendPiRpcAndWait(piSession, transport, { type: 'get_commands' });
                    commands = parsePiCommands(data);
                    if (commands.length > 0) {
                        piSession.cachedPiCommands = commands;
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
                    source: cmd.source === 'skill' ? 'plugin' as const
                        : cmd.source === 'prompt' ? 'user' as const
                        : 'plugin' as const,
                })),
            };
        }
    );

    // --- User message handler ---
    apiSession.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        if (piSession.piIsStreaming) {
            // Steer does not start a new turn, so the localId would never be
            // drained by turn_start. Mark it consumed immediately so it does
            // not poison the FIFO for the next real prompt.
            transport.send({ type: 'steer', message: formattedText });
            if (localId) piSession.emitMessagesConsumed([localId]);
        } else {
            if (localId) pendingLocalIds.push(localId);
            transport.send({ type: 'prompt', message: formattedText });
        }
    });

    // --- Abort handler ---
    // Only cancel the current turn, keep session alive for next prompt.
    // Pi's `abort` command cancels the active turn but the process stays in RPC mode.
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        transport.send({ type: 'abort' });
        piSession.piIsStreaming = false;
        piSession.updateThinkingState(false);
        if (pendingLocalIds.length > 0) {
            piSession.emitMessagesConsumed([pendingLocalIds.shift()!]);
        }
        return { success: true };
    });

    // --- Switch handler ---
    // Unlike Claude/Codex (which use BaseLocalLauncher's restart loop), Pi runs
    // as a single long-lived subprocess. Switching mode should change control
    // ownership without killing the process or archiving the session.
    const handleModeChange = createModeChangeHandler(apiSession);
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async (payload: { to?: 'local' | 'remote' } = {}) => {
        const mode = payload.to ?? 'remote';
        piSession.setMode(mode);
        handleModeChange(mode);
        return { success: true };
    });

    // --- Run ---
    let crashed = false;
    try {
        transport.start();
        transport.send({ type: 'new_session' });
        transport.send({ type: 'get_state' });
        transport.send({ type: 'get_available_models' });
        transport.send({ type: 'get_commands' });

        // Apply the requested startup effort only after Pi confirms
        // set_thinking_level. Commit currentThinkingLevel on success and push a
        // keepAlive so the hub sees the accepted value; on rejection keep Pi's
        // default (already reported by get_state). Detached so the run loop is
        // not blocked; sent after get_state so the authoritative baseline lands
        // first and a late get_state response does not clobber the confirmed
        // value (get_state runs on the wire before this await resolves).
        if (startupThinkingLevel) {
            void (async () => {
                try {
                    await sendPiRpcAndWait(piSession, transport, {
                        type: 'set_thinking_level',
                        level: startupThinkingLevel,
                    });
                    piSession.currentThinkingLevel = startupThinkingLevel;
                    piSession.pushKeepAlive();
                    logger.debug(`[pi] Startup effort applied: ${startupThinkingLevel}`);
                } catch (error) {
                    logger.debug(`[pi] Startup effort rejected, keeping Pi default: ${error instanceof Error ? error.message : String(error)}`);
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
        logger.debug('[pi] Loop error:', error);
    } finally {
        if (!crashed && !lifecycle.hasExplicitSessionEndReason()) {
            lifecycle.setSessionEndReason('completed');
        }
        await safeCleanup();
    }
}
