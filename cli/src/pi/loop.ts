import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PiTransport } from './piTransport';
import { convertPiEvent } from './piEventConverter';
import { PiMessageAccumulator } from './piMessageAccumulator';
import { parsePiModels, parsePiCommands, PiResponseEventSchema, PiStateDataSchema, PiSetModelDataSchema } from './schemas';
import type { PiResponseEvent, PiRpcCommand, PiThinkingLevel } from './types';
import type { PiSession } from './session';

// --- Response parsers: re-exported from schemas.ts ---
export { parsePiModels, parsePiCommands } from './schemas';

// --- Pending RPC resolver ---
// Instance-scoped: created once by wireTransportEvents, stored on PiSession.
export class PiRpcResolver {
    private idCounter = 0;
    private readonly pending = new Map<number, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
    }>();

    sendAndWait(transport: PiTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
        const id = ++this.idCounter;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Pi RPC ${command.type} (id=${id}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (data) => { clearTimeout(timer); this.pending.delete(id); resolve(data); },
                reject: (error) => { clearTimeout(timer); this.pending.delete(id); reject(error); },
            });

            transport.send({ ...command, id: String(id) } as unknown as PiRpcCommand);
        });
    }

    resolveResponse(raw: unknown): void {
        const parsed = PiResponseEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const response = parsed.data;
        const rawId = response.id;
        if (rawId !== undefined) {
            const numericId = Number(rawId);
            if (!Number.isNaN(numericId)) {
                const resolver = this.pending.get(numericId);
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
}

export function sendPiRpcAndWait(session: PiSession, transport: PiTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    if (!session.rpcResolver) throw new Error('Pi RPC resolver not initialized');
    return session.rpcResolver.sendAndWait(transport, command, timeoutMs);
}

function resolvePendingRpc(resolver: PiRpcResolver, response: PiResponseEvent): void {
    resolver.resolveResponse(response);
}

// Mirror the web picker's provider-qualified selection into metadata so the hub
// and web can disambiguate duplicate modelId values across providers. The web
// /sessions/:id/model path already writes piSelectedModel via persistPiSelectedModel;
// these runtime paths (get_state, startup set_model, successful set_model response)
// previously only keepAlive'd the bare modelId, so a Pi session on Pi's default model
// or started with --model could render/filter against the wrong provider.
function persistSelectedPiModel(session: PiSession): void {
    const modelId = session.currentModel;
    const provider = session.currentProvider;
    if (!modelId || !provider) return;
    session.updateMetadata((meta) => ({
        ...meta,
        piSelectedModel: { provider, modelId },
    }));
}

// --- Response handler ---

function handleGetState(
    rawData: unknown,
    session: PiSession,
): void {
    const parsed = PiStateDataSchema.safeParse(rawData);
    if (!parsed.success) return;
    const data = parsed.data;

    if (data.model) {
        // Pi returns model.id (not modelId). Fallback to modelId for forward compat.
        const newModel = data.model.id ?? data.model.modelId ?? session.currentModel;
        if (data.model.provider && data.model.provider.length > 0) {
            session.currentProvider = data.model.provider;
        }
        // Do NOT overwrite currentModel with the unconfirmed startup model here.
        // The requested startup model is applied (and committed) only after
        // get_available_models confirms it exists and Pi accepts set_model;
        // reporting Pi's actual current model until then keeps the hub in sync
        // if the requested model is unavailable or rejected.
        session.currentModel = newModel ?? session.currentModel;
        if (session.initialModel) {
            logger.debug(`[pi] Startup model requested: ${session.initialModel} (will apply once available models arrive); Pi default model: ${newModel ?? 'unknown'}`);
        } else if (newModel) {
            logger.debug(`[pi] Initial model: ${newModel} (provider=${session.currentProvider ?? 'unknown'})`);
        }
        // Pi reported its actual model+provider; persist the provider-qualified
        // selection so the web can disambiguate (a startup --model overrides this
        // once get_available_models confirms and applies it below).
        persistSelectedPiModel(session);
    }

    if (data.sessionId) {
        session.updateMetadata((meta) => ({ ...meta, piSessionId: data.sessionId }));
        logger.debug(`[pi] Session ID persisted to metadata: ${data.sessionId}`);
    }

    if (data.thinkingLevel) {
        session.currentThinkingLevel = data.thinkingLevel as PiThinkingLevel;
        logger.debug(`[pi] Initial thinking level: ${data.thinkingLevel}`);
    }

    if (data.steeringMode) {
        session.currentSteeringMode = data.steeringMode;
    }
}

function handleResponse(
    response: PiResponseEvent,
    session: PiSession,
    pendingLocalIds: string[],
    transport?: PiTransport,
): void {
    const { command, success } = response;
    const resolver = session.rpcResolver!;

    if (!success) {
        const error = response.error ?? 'Unknown Pi error';
        logger.debug(`[pi] RPC error for ${command}: ${error}`);
        resolvePendingRpc(resolver, response);
        session.sendSessionEvent({ type: 'message', message: error });
        if (command === 'prompt' && pendingLocalIds.length > 0) {
            const oldestLocalId = pendingLocalIds.shift()!;
            session.emitMessagesConsumed([oldestLocalId], { clearQueuedThinkingGrace: true });
        }
        return;
    }

    switch (command) {
        case 'get_state': {
            handleGetState(response.data, session);
            break;
        }
        case 'set_model': {
            const parsed = PiSetModelDataSchema.safeParse(response.data);
            if (parsed.success) {
                const data = parsed.data;
                const modelId = data.id ?? data.modelId;
                if (modelId) {
                    session.currentModel = modelId;
                }
                if (data.provider && data.provider.length > 0) {
                    session.currentProvider = data.provider;
                }
                persistSelectedPiModel(session);
                logger.debug(`[pi] Model changed to: ${modelId ?? session.currentModel}`);
            }
            // set_model is awaited by SetSessionConfig (Fix #9); without this
            // the awaited RPC would time out and /sessions/:id/model return 409.
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'set_thinking_level': {
            // Awaited by SetSessionConfig (Fix #9 symmetry with set_model).
            // currentThinkingLevel is maintained by the SetSessionConfig
            // handler, so this branch only resolves the pending RPC — without
            // it the awaited call times out and /sessions/:id/effort returns 409.
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'get_available_models': {
            const models = parsePiModels(response.data);
            if (models.length > 0) {
                session.cachedPiModels = models;
                logger.debug(`[pi] Available models: ${models.map((m) => m.modelId).join(', ')}`);
                session.updateMetadata((meta) => ({
                    ...meta,
                    piAvailableModels: models,
                }));

                // Apply the requested startup model only after confirming it exists
                // in Pi's available models and Pi accepts set_model. Commit
                // currentModel/currentProvider only on success so the hub does not
                // persist a model Pi rejected or never had. Fire-and-forget the
                // await so resolving the get_available_models RPC itself is not
                // blocked (it may be awaited by ListPiModels).
                if (session.initialModel && transport) {
                    const match = models.find((m) => m.modelId === session.initialModel);
                    if (match) {
                        void (async () => {
                            try {
                                await sendPiRpcAndWait(session, transport, {
                                    type: 'set_model',
                                    provider: match.provider,
                                    modelId: match.modelId,
                                });
                                session.currentModel = match.modelId;
                                session.currentProvider = match.provider;
                                persistSelectedPiModel(session);
                                logger.debug(`[pi] Startup model applied: ${match.provider}/${match.modelId}`);
                            } catch (error) {
                                logger.debug(`[pi] Startup model set_model rejected, keeping Pi default: ${error instanceof Error ? error.message : String(error)}`);
                            }
                        })();
                    } else {
                        logger.debug(`[pi] Startup model not found in available models: ${session.initialModel}`);
                    }
                }
            }
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'get_commands': {
            const commands = parsePiCommands(response.data);
            if (commands.length > 0) {
                session.cachedPiCommands = commands;
                logger.debug(`[pi] Available commands: ${commands.map((c) => c.name).join(', ')}`);
            }
            resolvePendingRpc(resolver, response);
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
        default:
            logger.debug(`[pi] Response for ${command}`);
            resolvePendingRpc(resolver, response);
            break;
    }
}

// --- Wire transport events to session ---

export function wireTransportEvents(
    transport: PiTransport,
    session: PiSession,
    pendingLocalIds: string[],
): void {
    session.rpcResolver = new PiRpcResolver();
    const assistantMessageAccumulator = new PiMessageAccumulator();

    transport.onEvent((event) => {
        // Debug: log all event types to diagnose missing Pi output
        if (event.type !== 'keep_alive') {
            logger.debug(`[pi][event] ${event.type}`);
        }
        if (event.type === 'response') {
            handleResponse(event as unknown as PiResponseEvent, session, pendingLocalIds, transport);
            return;
        }

        // Accumulate text/thinking deltas into snapshots, flush on message_end
        const accumulated = assistantMessageAccumulator.handleEvent(event);
        if (accumulated.length > 0) {
            for (const msg of accumulated) {
                const converted = convertAgentMessage(msg);
                if (converted) session.sendAgentMessage(converted);
            }
        }

        // message_start/update/end handled by accumulator — skip converter
        if (event.type !== 'message_start' && event.type !== 'message_update' && event.type !== 'message_end') {
            const messages = convertPiEvent(event);
            for (const msg of messages) {
                const converted = convertAgentMessage(msg);
                if (converted) session.sendAgentMessage(converted);
            }
        }

        // Keep-alive + streaming state tracking
        //
        // Pi emits agent_start and turn_start back-to-back for each prompt.
        // Only turn_start marks "my prompt was accepted and a turn began", so
        // the pending localId is drained there. Draining on both would pop the
        // FIFO twice per prompt — once with the real id, then once with
        // undefined — and ship a garbage localId to the hub.
        if (event.type === 'agent_start') {
            session.updateThinkingState(true);
        } else if (event.type === 'turn_start') {
            session.updateThinkingState(true);
            if (pendingLocalIds.length > 0) {
                const oldestLocalId = pendingLocalIds.shift()!;
                session.emitMessagesConsumed([oldestLocalId]);
            }
        } else if (event.type === 'turn_end') {
            session.updateThinkingState(false);
        } else if (event.type === 'agent_end') {
            session.piIsStreaming = false;
        }
    });
}
