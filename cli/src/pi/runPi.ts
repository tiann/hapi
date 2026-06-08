import { logger } from '@/ui/logger';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PiTransport } from './PiTransport';
import { convertPiEvent } from './PiEventConverter';
import { PiMessageAccumulator } from './PiMessageAccumulator';
import type { PiResponseEvent, PiThinkingLevel, PiCommandSummary, PiSessionStats, PiCompactionResult, PiForkMessageEntry } from './types';
import type { SlashCommandsResponse } from '@hapi/protocol/apiTypes';
import type { PiPermissionMode } from '@hapi/protocol/modes';
import type { ListPiModelsResponse, PiModelSummary, PiCommandsResponse, PiSteerResponse, PiFollowUpResponse, PiQueueModeResponse, PiMessagesResponse, PiMessageEntry, PiCompactResponse, PiSetAutoCompactionResponse, PiForkResponse, PiForkMessagesResponse, PiCloneResponse, PiSwitchSessionResponse, PiSessionStatsResponse, PiExportHtmlResponse } from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export async function runPi(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PiPermissionMode;
    model?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

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
            model: opts.model
        });
    const { session } = bootstrap;

    setControlledByUser(session, startingMode);

    let currentModel: string | null = opts.model ?? null;
    // Pi's `set_model` RPC requires both provider and modelId. The provider
    // is not user-selectable in HAPI's model UI (the dropdown only carries
    // modelId), so we learn it from `get_state` after spawn and reuse it
    // for every subsequent set_model. Until we know the provider, sending
    // `set_model` is suppressed — the bootstrap-time model was already
    // honored by Pi at startup, so suppressing here only means
    // "same-model set_session_config" is a no-op, not a wrong-model emit.
    let currentProvider: string | null = null;
    let currentPermissionMode: PiPermissionMode = opts.permissionMode ?? 'default';
    let currentThinkingLevel: import('./types').PiThinkingLevel | null = null;

    const transportArgs = ['--mode', 'rpc'];
    if (opts.resumeSessionId) {
        transportArgs.push('--session-id', opts.resumeSessionId);
    }
    const transport = new PiTransport({ command: 'pi', args: transportArgs, cwd: workingDirectory });

    // Keep-alive: send session-alive every 2s so hub doesn't expire the session (30s timeout)
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(false, startingMode);
    }, 2000);

    // Flag: set when transport.kill() is called during normal lifecycle cleanup,
    // so transport.onClose can skip crash-marking (which would override the
    // lifecycle's exitCode/sessionEndReason with 'error' on every close).
    let killedByCleanup = false;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'pi',
        stopKeepAlive: () => { clearInterval(keepAliveInterval); },
        onAfterClose: () => {
            clearInterval(keepAliveInterval);
            killedByCleanup = true;
            transport.kill();
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    // Cleanup guard — prevents double-cleanup from error/close/finally racing
    let cleanupInitiated = false;
    const safeCleanup = async () => {
        if (cleanupInitiated) return;
        cleanupInitiated = true;
        await lifecycle.cleanupAndExit();
    };

    // Pending user-message localIds in FIFO order. Pi's RPC protocol does not
    // echo the localId back on agent_start, so we rely on Pi processing
    // prompts in submission order. Each agent_start pops the oldest entry
    // and emits `messages-consumed` so the web UI transitions the user's
    // bubble from "queued" to "sent" — see Pi's protocol reference in
    // .xyz-harness/2026-06-05-hapi-pi-agent-backend/e2e-test-plan.md.
    const pendingLocalIds: string[] = [];

    const assistantMessageAccumulator = new PiMessageAccumulator();

    // Promise-based RPC resolution for commands that need request-response
    // semantics (e.g. get_available_models). The transport is event-driven,
    // so we stash resolve/reject callbacks keyed by a unique id and wire them
    // up when the matching response arrives. Using command type as key would
    // race if the same command is sent concurrently (e.g. auto-discovery +
    // ListPiModels RPC both sending get_available_models).
    let rpcIdCounter = 0;
    const pendingRpcResolvers = new Map<number, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
    }>();

    function sendPiRpcAndWait(command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
        const id = ++rpcIdCounter;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRpcResolvers.delete(id);
                reject(new Error(`Pi RPC ${command.type} (id=${id}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            pendingRpcResolvers.set(id, {
                resolve: (data) => { clearTimeout(timer); pendingRpcResolvers.delete(id); resolve(data); },
                reject: (error) => { clearTimeout(timer); pendingRpcResolvers.delete(id); reject(error); },
            });

            transport.send({ ...command, id: String(id) } as unknown as import('./types').PiRpcCommand);
        });
    }

    function resolvePendingRpc(response: PiResponseEvent): void {
        const rawId = (response as unknown as Record<string, unknown>).id;
        if (typeof rawId === 'string') {
            const numericId = Number(rawId);
            if (!Number.isNaN(numericId)) {
                const resolver = pendingRpcResolvers.get(numericId);
                if (resolver) {
                    if (response.success) {
                        resolver.resolve(response.data);
                    } else {
                        resolver.reject(new Error(response.error ?? 'Unknown error'));
                    }
                }
            }
        }
    }

    // Parse Pi's get_available_models response into typed PiModelSummary[].
    // Shared between auto-discovery handler and ListPiModels RPC handler.
    function parsePiModels(data: unknown): PiModelSummary[] {
        const rawModels = (data as Record<string, unknown>)?.models;
        if (!Array.isArray(rawModels)) return [];
        return rawModels
            .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
            .map((m) => ({
                provider: typeof m.provider === 'string' ? m.provider : 'unknown',
                modelId: typeof m.id === 'string' ? m.id : '',
                ...(typeof m.name === 'string' ? { name: m.name } : {}),
                ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
            }))
            .filter((m) => m.modelId.length > 0);
    }

    // Cached model list from the last get_available_models response.
    // Populated automatically after get_state, and refreshed on demand
    // via ListPiModels RPC.
    let cachedPiModels: PiModelSummary[] = [];

    // Cached command/skill list from the last get_commands response.
    let cachedPiCommands: PiCommandSummary[] = [];

    // Track Pi's streaming state. When streaming, user messages are sent as
    // `steer` (mid-turn steering) instead of `prompt` (new turn).
    let piIsStreaming = false;

    // Steering and follow-up queue modes. Persisted so RPC handlers
    // can read current state and web UI can reflect it.
    let currentSteeringMode: 'all' | 'one-at-a-time' = 'all';
    let currentFollowUpMode: 'all' | 'one-at-a-time' = 'all';

    function parsePiCommands(data: unknown): PiCommandSummary[] {
        const rawCommands = (data as Record<string, unknown>)?.commands;
        if (!Array.isArray(rawCommands)) return [];
        return rawCommands
            .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
            .map((c) => ({
                name: typeof c.name === 'string' ? c.name : '',
                ...(typeof c.description === 'string' ? { description: c.description } : {}),
                source: (['extension', 'prompt', 'skill'].includes(c.source as string) ? c.source : 'skill') as PiCommandSummary['source'],
            }))
            .filter((c) => c.name.length > 0);
    }

    // Extract text content from a Pi AgentMessage object.
    // Pi's get_messages returns rich AgentMessage objects with various content
    // block types. We flatten to plain text for the HAPI web UI.
    function extractTextFromPiMessage(m: Record<string, unknown>): string {
        const content = m.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
                .map((b) => {
                    if (b.type === 'text' && typeof b.text === 'string') return b.text;
                    if (b.type === 'tool_result' && typeof b.content === 'string') return b.content;
                    if (b.type === 'tool_use' && typeof b.name === 'string') return `[tool: ${b.name}]`;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        return '';
    }

// --- Transport event handlers ---

    transport.onError((error) => {
        logger.debug(`[pi] Transport error: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onClose((code, signal) => {
        // When lifecycle cleanup kills the transport, skip crash-marking to
        // preserve the correct exitCode/sessionEndReason (e.g. 'terminated'
        // instead of 'error'). Only mark as crash when Pi exits on its own.
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

    transport.onEvent((event) => {
        if (event.type === 'response') {
            handleResponse(event as unknown as PiResponseEvent, currentModel, (update) => {
                currentModel = update.model ?? currentModel;
                currentPermissionMode = update.permissionMode ?? currentPermissionMode;
            });
            return;
        }

        // Accumulate Pi text/thinking deltas into a single snapshot per
        // assistant message and flush on `message_end`. Without this,
        // each delta becomes a separate hub message → the web's reducer
        // (which dedupes reasoning by streamId but only WITHIN one
        // message's content array) would render the last delta as
        // the whole reasoning ("...") and stack every text delta as a
        // new agent-text block, producing a character-by-character
        // column. Matches codex's `ReasoningProcessor` pattern.
        const accumulated = assistantMessageAccumulator.handleEvent(event);
        if (accumulated.length > 0) {
            for (const msg of accumulated) {
                const converted = convertAgentMessage(msg);
                if (converted) session.sendAgentMessage(converted);
            }
        }

        // message_start/message_update/message_end are fully handled by
        // the accumulator. Skip the converter for them to avoid
        // duplicate emission.
        if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
            // fall through to keep-alive handling below
        } else {
            const messages = convertPiEvent(event);
            for (const msg of messages) {
                // Route through the shared CLI → hub wire-format converter so
                // the rest of the system (hub / web) sees a codex-shaped
                // message rather than an internal `AgentMessage` shape.
                const converted = convertAgentMessage(msg);
                if (converted) {
                    session.sendAgentMessage(converted);
                }
            }
        }

        // Update keep-alive with thinking state for agent_start/turn_start/turn_end
        if (event.type === 'agent_start' || event.type === 'turn_start') {
            session.keepAlive(true, startingMode);
            piIsStreaming = true;
            // agent_start fires once per accepted prompt. Consume the
            // oldest pending localId so the user's bubble transitions
            // out of the floating queued bar. turn_start is intentionally
            // skipped — it can fire multiple times per agent run (e.g.
            // after tool calls) and does not correspond to a new prompt.
            if (event.type === 'agent_start' && pendingLocalIds.length > 0) {
                const oldestLocalId = pendingLocalIds.shift()!;
                session.emitMessagesConsumed([oldestLocalId]);
            }
        } else if (event.type === 'turn_end') {
            session.keepAlive(false, startingMode);
            piIsStreaming = false;
        } else if (event.type === 'agent_end') {
            piIsStreaming = false;
        }
    });

    // Handle get_state response: extract model, provider, session ID,
    // thinking level, and queue modes from Pi's initial state.
    function handleGetState(
        data: Record<string, unknown> | undefined,
        model: string | null,
        onUpdate: (update: { model?: string | null; permissionMode?: PiPermissionMode }) => void
    ): void {
        // Model + provider
        if (data?.model && typeof data.model === 'object') {
            const modelObj = data.model as Record<string, unknown>;
            const newModel = (modelObj.modelId as string) ?? model;
            const provider = modelObj.provider;
            if (typeof provider === 'string' && provider.length > 0) {
                currentProvider = provider;
            }
            onUpdate({ model: newModel });
            logger.debug(`[pi] Initial model: ${newModel} (provider=${currentProvider ?? 'unknown'})`);
        }
        // Persist piSessionId for session resume
        const piSessionId = typeof data?.sessionId === 'string' ? data.sessionId as string : undefined;
        if (piSessionId) {
            session.updateMetadata((meta) => ({ ...meta, piSessionId }));
            logger.debug(`[pi] Session ID persisted to metadata: ${piSessionId}`);
        }
        // Thinking level
        const thinkingLevel = typeof data?.thinkingLevel === 'string' ? data.thinkingLevel as PiThinkingLevel : undefined;
        if (thinkingLevel) {
            currentThinkingLevel = thinkingLevel;
            logger.debug(`[pi] Initial thinking level: ${thinkingLevel}`);
        }
        // Queue modes
        if (data?.steeringMode === 'all' || data?.steeringMode === 'one-at-a-time') {
            currentSteeringMode = data.steeringMode;
        }
        if (data?.followUpMode === 'all' || data?.followUpMode === 'one-at-a-time') {
            currentFollowUpMode = data.followUpMode;
        }
    }

    function handleResponse(
        response: PiResponseEvent,
        model: string | null,
        onUpdate: (update: { model?: string | null; permissionMode?: PiPermissionMode }) => void
    ): void {
        const { command, success } = response;

        if (!success) {
            const error = response.error ?? 'Unknown Pi error';
            logger.debug(`[pi] RPC error for ${command}: ${error}`);
            // Resolve/reject any pending promise so it doesn't leak.
            resolvePendingRpc(response);
            session.sendSessionEvent({ type: 'message', message: error });
            // If Pi rejected a prompt, Pi will not emit agent_start, so the
            // matching localId would be stuck in the FIFO and poison the next
            // legitimate prompt. Consume it here so the user sees their
            // message transition out of the queued bar (the error is shown
            // as a session event above).  Only `prompt` carries a localId;
            // other commands are not user messages.
            if (command === 'prompt' && pendingLocalIds.length > 0) {
                const oldestLocalId = pendingLocalIds.shift()!;
                session.emitMessagesConsumed([oldestLocalId], { clearQueuedThinkingGrace: true });
            }
            return;
        }

        switch (command) {
            case 'get_state': {
                const data = response.data as Record<string, unknown> | undefined;
                handleGetState(data, model, onUpdate);
                break;
            }
            case 'set_model': {
                const data = response.data as Record<string, unknown> | undefined;
                if (data?.modelId) {
                    onUpdate({ model: data.modelId as string });
                }
                if (data && typeof data.provider === 'string' && data.provider.length > 0) {
                    currentProvider = data.provider;
                }
                logger.debug(`[pi] Model changed to: ${(data?.modelId as string) ?? model}`);
                break;
            }
            case 'get_available_models': {
                const models = parsePiModels(response.data);
                if (models.length > 0) {
                    cachedPiModels = models;
                    logger.debug(`[pi] Available models: ${cachedPiModels.map((m) => m.modelId).join(', ')}`);
                    session.updateMetadata((meta) => ({
                        ...meta,
                        piAvailableModels: cachedPiModels,
                    }));
                }
                resolvePendingRpc(response);
                break;
            }
            case 'get_commands': {
                const commands = parsePiCommands(response.data);
                if (commands.length > 0) {
                    cachedPiCommands = commands;
                    logger.debug(`[pi] Available commands: ${commands.map((c) => c.name).join(', ')}`);
                }
                resolvePendingRpc(response);
                break;
            }
            case 'new_session':
                logger.debug('[pi] Pi session initialized');
                break;
            case 'abort':
                logger.debug('[pi] Abort confirmed');
                break;
            case 'prompt':
                logger.debug('[pi] Prompt accepted');
                break;
            case 'steer':
                logger.debug('[pi] Steer accepted');
                break;
            case 'follow_up':
                logger.debug('[pi] Follow-up accepted');
                break;
            case 'set_steering_mode':
                logger.debug('[pi] Steering mode set');
                resolvePendingRpc(response);
                break;
            case 'set_follow_up_mode':
                logger.debug('[pi] Follow-up mode set');
                resolvePendingRpc(response);
                break;
            case 'get_messages':
                logger.debug('[pi] Messages retrieved');
                resolvePendingRpc(response);
                break;
            // P3 responses
            case 'compact':
                logger.debug('[pi] Compact completed');
                resolvePendingRpc(response);
                break;
            case 'set_auto_compaction':
                logger.debug('[pi] Auto compaction toggled');
                resolvePendingRpc(response);
                break;
            case 'fork':
                logger.debug('[pi] Fork completed');
                resolvePendingRpc(response);
                break;
            case 'get_fork_messages':
                logger.debug('[pi] Fork messages retrieved');
                resolvePendingRpc(response);
                break;
            case 'clone':
                logger.debug('[pi] Clone completed');
                resolvePendingRpc(response);
                break;
            case 'switch_session':
                logger.debug('[pi] Session switched');
                resolvePendingRpc(response);
                break;
            case 'get_session_stats':
                logger.debug('[pi] Session stats retrieved');
                resolvePendingRpc(response);
                break;
            case 'export_html':
                logger.debug('[pi] HTML export completed');
                resolvePendingRpc(response);
                break;
            default:
                logger.debug(`[pi] Response for ${command}`);
        }
    }

    // --- Session config RPC ---

    registerSessionConfigRpc<PiPermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'pi',
        modelMode: 'nullable',
        effortMode: 'nullable',
        onApply: (config) => {
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode;
            }
            if (config.model !== undefined) {
                currentModel = config.model;
            }
            if (config.effort !== undefined) {
                currentThinkingLevel = config.effort as PiThinkingLevel | null;
            }
        },
        onAfterApply: () => {
            // Only forward set_model once we know the provider from
            // get_state. Until then, the bootstrap-time model already
            // applied, so suppressing here is a no-op for "same model
            // config" rather than a wrong-model emit.
            if (currentModel && currentProvider) {
                transport.send({ type: 'set_model', provider: currentProvider, modelId: currentModel });
            } else if (currentModel && !currentProvider) {
                logger.debug('[pi] set_model suppressed: provider unknown until get_state');
            }
            // Forward thinking level changes to Pi
            if (currentThinkingLevel) {
                transport.send({ type: 'set_thinking_level', level: currentThinkingLevel });
            }
            session.keepAlive(false, startingMode);
        }
    });

    // --- Pi model discovery RPC ---
    // Hub routes ListPiModels to fetch the available model list.
    // Returns cached models if available (populated by auto-discovery),
    // otherwise sends get_available_models to Pi and waits for response.
    session.rpcHandlerManager.registerHandler<Record<string, never>, ListPiModelsResponse>(
        RPC_METHODS.ListPiModels,
        async () => {
            // Return cached models if available
            if (cachedPiModels.length > 0) {
                return {
                    success: true,
                    availableModels: cachedPiModels,
                    currentModelId: currentModel,
                };
            }

            try {
                const data = await sendPiRpcAndWait({ type: 'get_available_models' });
                const models = parsePiModels(data);
                if (models.length > 0) {
                    cachedPiModels = models;
                }
                return {
                    success: true,
                    availableModels: models,
                    currentModelId: currentModel,
                };
            } catch (error) {
                logger.debug('[pi] ListPiModels RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to list Pi models',
                };
            }
        }
    );

    // --- Pi rename session RPC ---
    // Hub calls this after renaming a Pi session via REST so Pi's internal
    // session state stays in sync with HAPI's DB.
    session.rpcHandlerManager.registerHandler<{ name: string }, { success: boolean }>(
        RPC_METHODS.RenamePiSession,
        async (params) => {
            if (!params || typeof params.name !== 'string' || params.name.trim().length === 0) {
                return { success: false };
            }
            transport.send({ type: 'set_session_name', name: params.name.trim() });
            logger.debug(`[pi] Session name forwarded to Pi: ${params.name}`);
            return { success: true };
        }
    );

    // --- Pi commands (skills) RPC ---
    // Hub routes ListPiCommands to discover Pi's available skills/commands.
    // Uses cached commands from auto-discovery after get_state, or queries on demand.
    session.rpcHandlerManager.registerHandler<Record<string, never>, PiCommandsResponse>(
        RPC_METHODS.ListPiCommands,
        async () => {
            if (cachedPiCommands.length > 0) {
                return { success: true, commands: cachedPiCommands };
            }

            try {
                const data = await sendPiRpcAndWait({ type: 'get_commands' });
                const commands = parsePiCommands(data);
                if (commands.length > 0) {
                    cachedPiCommands = commands;
                }
                return { success: true, commands };
            } catch (error) {
                logger.debug('[pi] ListPiCommands RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to list Pi commands',
                };
            }
        }
    );

    // --- Slash commands (Pi skills/commands) ---
    // Maps Pi's get_commands output to the HAPI SlashCommand format so the
    // existing web autocomplete pipeline works without modification.
    session.rpcHandlerManager.registerHandler<{ agent?: string }, SlashCommandsResponse>(
        RPC_METHODS.ListSlashCommands,
        async () => {
            let commands = cachedPiCommands;
            if (commands.length === 0) {
                try {
                    const data = await sendPiRpcAndWait({ type: 'get_commands' });
                    commands = parsePiCommands(data);
                    if (commands.length > 0) {
                        cachedPiCommands = commands;
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

    // --- Pi steer RPC ---
    // Web sends a steering message mid-stream. Delegates to the same
    // onUserMessage path which already checks piIsStreaming.
    session.rpcHandlerManager.registerHandler<{ message: string }, PiSteerResponse>(
        RPC_METHODS.PiSteer,
        async (params) => {
            if (!params || typeof params.message !== 'string' || params.message.trim().length === 0) {
                return { success: false, error: 'Empty message' };
            }
            transport.send({ type: 'steer', message: params.message.trim() });
            return { success: true };
        }
    );

    // --- Pi follow-up RPC ---
    // Queue a message for after the current turn.
    session.rpcHandlerManager.registerHandler<{ message: string }, PiFollowUpResponse>(
        RPC_METHODS.PiFollowUp,
        async (params) => {
            if (!params || typeof params.message !== 'string' || params.message.trim().length === 0) {
                return { success: false, error: 'Empty message' };
            }
            transport.send({ type: 'follow_up', message: params.message.trim() });
            return { success: true };
        }
    );

    // --- Pi queue mode RPCs ---
    session.rpcHandlerManager.registerHandler<{ mode: 'all' | 'one-at-a-time' }, PiQueueModeResponse>(
        RPC_METHODS.PiSetSteeringMode,
        async (params) => {
            const mode = params?.mode;
            if (mode !== 'all' && mode !== 'one-at-a-time') {
                return { success: false, error: 'Invalid mode' };
            }
            transport.send({ type: 'set_steering_mode', mode });
            currentSteeringMode = mode;
            return { success: true };
        }
    );

    session.rpcHandlerManager.registerHandler<{ mode: 'all' | 'one-at-a-time' }, PiQueueModeResponse>(
        RPC_METHODS.PiSetFollowUpMode,
        async (params) => {
            const mode = params?.mode;
            if (mode !== 'all' && mode !== 'one-at-a-time') {
                return { success: false, error: 'Invalid mode' };
            }
            transport.send({ type: 'set_follow_up_mode', mode });
            currentFollowUpMode = mode;
            return { success: true };
        }
    );

    // --- Pi get_messages RPC ---
    // Retrieves Pi's internal message history. Pi returns AgentMessage[]
    // objects; we convert them to a simplified format for web rendering.
    session.rpcHandlerManager.registerHandler<Record<string, never>, PiMessagesResponse>(
        RPC_METHODS.PiGetMessages,
        async () => {
            try {
                const data = await sendPiRpcAndWait({ type: 'get_messages' });
                const rawMessages = (data as Record<string, unknown>)?.messages;
                if (!Array.isArray(rawMessages)) {
                    return { success: true, messages: [] };
                }
                const messages: PiMessageEntry[] = rawMessages
                    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
                    .map((m) => ({
                        entryId: typeof m.entryId === 'string' ? m.entryId : '',
                        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
                        text: extractTextFromPiMessage(m),
                    }))
                    .filter((m) => m.entryId.length > 0);
                return { success: true, messages };
            } catch (error) {
                logger.debug('[pi] PiGetMessages RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to get Pi messages',
                };
            }
        }
    );

    // === P3 RPC Handlers ===

    // --- Pi compact RPC ---
    // Triggers manual context compaction. Pi returns a CompactionResult with
    // the summary and first kept entry ID.
    session.rpcHandlerManager.registerHandler<{ customInstructions?: string }, PiCompactResponse>(
        RPC_METHODS.PiCompact,
        async (params) => {
            try {
                const command: import('./types').PiRpcCommand = { type: 'compact' };
                if (params?.customInstructions) {
                    (command as Record<string, unknown>).customInstructions = params.customInstructions;
                }
                const data = await sendPiRpcAndWait(command, 60_000);
                const result = data as Record<string, unknown> | null;
                if (!result) {
                    return { success: true };
                }
                return {
                    success: true,
                    result: {
                        summary: typeof result.summary === 'string' ? result.summary : '',
                        firstKeptEntryId: typeof result.firstKeptEntryId === 'string' ? result.firstKeptEntryId : '',
                        tokensBefore: typeof result.tokensBefore === 'number' ? result.tokensBefore : 0,
                    },
                };
            } catch (error) {
                logger.debug('[pi] PiCompact RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to compact Pi session',
                };
            }
        }
    );

    // --- Pi set_auto_compaction RPC ---
    session.rpcHandlerManager.registerHandler<{ enabled: boolean }, PiSetAutoCompactionResponse>(
        RPC_METHODS.PiSetAutoCompaction,
        async (params) => {
            if (params === undefined || params === null || typeof params.enabled !== 'boolean') {
                return { success: false, error: 'enabled (boolean) is required' };
            }
            try {
                await sendPiRpcAndWait({ type: 'set_auto_compaction', enabled: params.enabled });
                return { success: true };
            } catch (error) {
                logger.debug('[pi] PiSetAutoCompaction RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to set auto compaction',
                };
            }
        }
    );

    // --- Pi fork RPC ---
    // Forks the session at the given entry ID. Returns the fork summary text.
    session.rpcHandlerManager.registerHandler<{ entryId: string }, PiForkResponse>(
        RPC_METHODS.PiFork,
        async (params) => {
            if (!params?.entryId || typeof params.entryId !== 'string') {
                return { success: false, error: 'entryId is required' };
            }
            try {
                const data = await sendPiRpcAndWait({ type: 'fork', entryId: params.entryId });
                const result = data as Record<string, unknown> | null;
                return {
                    success: true,
                    text: result && typeof result.text === 'string' ? result.text : undefined,
                };
            } catch (error) {
                logger.debug('[pi] PiFork RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to fork Pi session',
                };
            }
        }
    );

    // --- Pi get_fork_messages RPC ---
    // Retrieves messages from the current fork context.
    session.rpcHandlerManager.registerHandler<Record<string, never>, PiForkMessagesResponse>(
        RPC_METHODS.PiGetForkMessages,
        async () => {
            try {
                const data = await sendPiRpcAndWait({ type: 'get_fork_messages' });
                const rawMessages = (data as Record<string, unknown>)?.messages;
                if (!Array.isArray(rawMessages)) {
                    return { success: true, messages: [] };
                }
                const messages: PiForkMessageEntry[] = rawMessages
                    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
                    .map((m) => ({
                        entryId: typeof m.entryId === 'string' ? m.entryId : '',
                        text: typeof m.text === 'string' ? m.text : '',
                    }))
                    .filter((m) => m.entryId.length > 0);
                return { success: true, messages };
            } catch (error) {
                logger.debug('[pi] PiGetForkMessages RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to get fork messages',
                };
            }
        }
    );

    // --- Pi clone RPC ---
    // Clones the current Pi session.
    session.rpcHandlerManager.registerHandler<Record<string, never>, PiCloneResponse>(
        RPC_METHODS.PiClone,
        async () => {
            try {
                await sendPiRpcAndWait({ type: 'clone' });
                return { success: true };
            } catch (error) {
                logger.debug('[pi] PiClone RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to clone Pi session',
                };
            }
        }
    );

    // --- Pi switch_session RPC ---
    // Switches Pi to a different session by path.
    session.rpcHandlerManager.registerHandler<{ sessionPath: string }, PiSwitchSessionResponse>(
        RPC_METHODS.PiSwitchSession,
        async (params) => {
            if (!params?.sessionPath || typeof params.sessionPath !== 'string') {
                return { success: false, error: 'sessionPath is required' };
            }
            try {
                await sendPiRpcAndWait({ type: 'switch_session', sessionPath: params.sessionPath });
                return { success: true };
            } catch (error) {
                logger.debug('[pi] PiSwitchSession RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to switch Pi session',
                };
            }
        }
    );

    // --- Pi get_session_stats RPC ---
    // Returns token counts, message counts, cost.
    session.rpcHandlerManager.registerHandler<Record<string, never>, PiSessionStatsResponse>(
        RPC_METHODS.PiGetSessionStats,
        async () => {
            try {
                const data = await sendPiRpcAndWait({ type: 'get_session_stats' });
                const raw = data as Record<string, unknown> | null;
                if (!raw) {
                    return { success: false, error: 'Empty response from Pi' };
                }
                const tokens = raw.tokens as Record<string, unknown> | undefined;
                return {
                    success: true,
                    stats: {
                        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
                        userMessages: typeof raw.userMessages === 'number' ? raw.userMessages : 0,
                        assistantMessages: typeof raw.assistantMessages === 'number' ? raw.assistantMessages : 0,
                        toolCalls: typeof raw.toolCalls === 'number' ? raw.toolCalls : 0,
                        totalMessages: typeof raw.totalMessages === 'number' ? raw.totalMessages : 0,
                        tokens: {
                            input: typeof tokens?.input === 'number' ? tokens.input : 0,
                            output: typeof tokens?.output === 'number' ? tokens.output : 0,
                            cacheRead: typeof tokens?.cacheRead === 'number' ? tokens.cacheRead : 0,
                            cacheWrite: typeof tokens?.cacheWrite === 'number' ? tokens.cacheWrite : 0,
                            total: typeof tokens?.total === 'number' ? tokens.total : 0,
                        },
                        cost: typeof raw.cost === 'number' ? raw.cost : 0,
                    },
                };
            } catch (error) {
                logger.debug('[pi] PiGetSessionStats RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to get Pi session stats',
                };
            }
        }
    );

    // --- Pi export_html RPC ---
    // Exports the session as an HTML file. Returns the output path.
    session.rpcHandlerManager.registerHandler<{ outputPath?: string }, PiExportHtmlResponse>(
        RPC_METHODS.PiExportHtml,
        async (params) => {
            try {
                const command: import('./types').PiRpcCommand = { type: 'export_html' };
                if (params?.outputPath) {
                    (command as Record<string, unknown>).outputPath = params.outputPath;
                }
                const data = await sendPiRpcAndWait(command, 30_000);
                const result = data as Record<string, unknown> | null;
                return {
                    success: true,
                    path: result && typeof result.path === 'string' ? result.path : undefined,
                };
            } catch (error) {
                logger.debug('[pi] PiExportHtml RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to export Pi session HTML',
                };
            }
        }
    );

    // --- User message handler ---
    // When Pi is streaming, user messages are sent as `steer` for mid-turn
    // steering. Otherwise, they are sent as regular `prompt`.
    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        if (localId) pendingLocalIds.push(localId);
        if (piIsStreaming) {
            transport.send({ type: 'steer', message: formattedText });
        } else {
            transport.send({ type: 'prompt', message: formattedText });
        }
    });

    // --- Cancel handler ---

    // Abort: hub routes RPC_METHODS.Abort from Telegram bot / web UI.
    // Terminates the current Pi turn and begins lifecycle cleanup.
    session.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        transport.send({ type: 'abort' });
        void lifecycle.cleanupAndExit();
        return { success: true };
    });

    // Switch: hub routes RPC_METHODS.Switch for local/remote mode toggle.
    // Pi doesn't have an interactive terminal to hand off to, so treat
    // switch-to-local as a graceful termination (same pattern as
    // RemoteLauncherBase's no-op handler).
    session.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async () => {
        lifecycle.setArchiveReason('Session switched');
        lifecycle.setSessionEndReason('terminated');
        void lifecycle.cleanupAndExit();
    });

    try {
        transport.start();

        transport.send({ type: 'new_session' });
        transport.send({ type: 'get_state' });
        // Auto-discover available models after init. Result is pushed to
        // session metadata and cached for the ListPiModels RPC handler.
        // Fire-and-forget — the response handler updates cachedPiModels.
        transport.send({ type: 'get_available_models' });
        // Auto-discover available commands/skills after init.
        // Fire-and-forget — the response handler updates cachedPiCommands.
        transport.send({ type: 'get_commands' });

        // Block until cleanup is triggered by error/close handler
        await new Promise<void>((resolve) => {
            const origCleanup = lifecycle.cleanupAndExit.bind(lifecycle);
            lifecycle.cleanupAndExit = async (codeOverride?: number) => {
                resolve();
                await origCleanup(codeOverride);
            };
        });
    } catch (error) {
        lifecycle.markCrash(error);
        lifecycle.setSessionEndReason('error');
        logger.debug('[pi] Loop error:', error);
    } finally {
        await safeCleanup();
    }
}
