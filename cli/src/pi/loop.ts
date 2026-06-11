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
        // When a startup model was specified, always use it instead of Pi's default.
        // The provider will be resolved later when get_available_models returns.
        session.currentModel = session.initialModel ?? newModel ?? null;
        if (session.initialModel) {
            logger.debug(`[pi] Startup model preserved: ${session.initialModel} (provider from get_state=${session.currentProvider ?? 'unknown'})`);
        } else if (newModel) {
            logger.debug(`[pi] Initial model: ${newModel} (provider=${session.currentProvider ?? 'unknown'})`);
        }
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
                logger.debug(`[pi] Model changed to: ${modelId ?? session.currentModel}`);
            }
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

                // Apply startup model if set_model was not yet sent.
                // At this point initialModel is in currentModel (set by handleGetState),
                // but provider may still be unknown. Search cached models to resolve it.
                if (session.initialModel && transport) {
                    const match = models.find((m) => m.modelId === session.initialModel);
                    if (match) {
                        session.currentProvider = match.provider;
                        transport.send({ type: 'set_model', provider: match.provider, modelId: match.modelId });
                        logger.debug(`[pi] Startup model applied: ${match.provider}/${match.modelId}`);
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
        if (event.type === 'agent_start' || event.type === 'turn_start') {
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
