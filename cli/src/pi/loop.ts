import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PiTransport } from './piTransport';
import { convertPiEvent } from './piEventConverter';
import { PiMessageAccumulator } from './piMessageAccumulator';
import type { PiResponseEvent, PiCommandSummary, PiRpcCommand, PiThinkingLevel } from './types';
import type { PiSession } from './session';
import type { PiModelSummary } from '@hapi/protocol/apiTypes';

// --- Response parsers (exported for RPC handler reuse) ---

function parseThinkingLevelMap(raw: unknown): Record<string, string | null> | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const map: Record<string, string | null> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof val === 'string') {
            map[key] = val;
        } else if (val === null) {
            map[key] = null;
        }
    }
    return Object.keys(map).length > 0 ? map : undefined;
}

export function parsePiModels(data: unknown): PiModelSummary[] {
    const rawModels = (data as Record<string, unknown>)?.models;
    if (!Array.isArray(rawModels)) return [];
    return rawModels
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
        .map((m) => ({
            provider: typeof m.provider === 'string' ? m.provider : 'unknown',
            modelId: typeof m.id === 'string' ? m.id : '',
            ...(typeof m.name === 'string' ? { name: m.name } : {}),
            ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
            ...(typeof m.reasoning === 'boolean' ? { reasoning: m.reasoning } : {}),
            ...(m.thinkingLevelMap ? { thinkingLevelMap: parseThinkingLevelMap(m.thinkingLevelMap) } : {}),
        }))
        .filter((m) => m.modelId.length > 0);
}

export function parsePiCommands(data: unknown): PiCommandSummary[] {
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

// --- Pending RPC resolver ---
// Encapsulated in a class to avoid module-level singleton state.
// Each Pi session creates its own instance, preventing cross-session leaks.
class PiRpcResolver {
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

    resolveResponse(response: PiResponseEvent): void {
        const rawId = (response as unknown as Record<string, unknown>).id;
        if (typeof rawId === 'string') {
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

// Session-scoped resolver instance, created by wireTransportEvents
let currentResolver: PiRpcResolver | null = null;

export function sendPiRpcAndWait(transport: PiTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    if (!currentResolver) throw new Error('Pi RPC resolver not initialized');
    return currentResolver.sendAndWait(transport, command, timeoutMs);
}

function resolvePendingRpc(response: PiResponseEvent): void {
    currentResolver?.resolveResponse(response);
}

// --- Response handler ---

function handleGetState(
    data: Record<string, unknown> | undefined,
    session: PiSession,
): void {
    if (data?.model && typeof data.model === 'object') {
        const modelObj = data.model as Record<string, unknown>;
        // Pi returns model.id (not modelId). Fallback to modelId for forward compat.
        const newModel = (modelObj.id as string) ?? (modelObj.modelId as string) ?? session.currentModel;
        const provider = modelObj.provider;
        if (typeof provider === 'string' && provider.length > 0) {
            session.currentProvider = provider;
        }
        session.currentModel = newModel;
        logger.debug(`[pi] Initial model: ${newModel} (provider=${session.currentProvider ?? 'unknown'})`);
    }

    const piSessionId = typeof data?.sessionId === 'string' ? data.sessionId as string : undefined;
    if (piSessionId) {
        session.updateMetadata((meta) => ({ ...meta, piSessionId }));
        logger.debug(`[pi] Session ID persisted to metadata: ${piSessionId}`);
    }

    const thinkingLevel = typeof data?.thinkingLevel === 'string' ? data.thinkingLevel as PiThinkingLevel : undefined;
    if (thinkingLevel) {
        session.currentThinkingLevel = thinkingLevel;
        logger.debug(`[pi] Initial thinking level: ${thinkingLevel}`);
    }

    if (data?.steeringMode === 'all' || data?.steeringMode === 'one-at-a-time') {
        session.currentSteeringMode = data.steeringMode;
    }
}

function handleResponse(
    response: PiResponseEvent,
    session: PiSession,
    pendingLocalIds: string[],
): void {
    const { command, success } = response;

    if (!success) {
        const error = response.error ?? 'Unknown Pi error';
        logger.debug(`[pi] RPC error for ${command}: ${error}`);
        resolvePendingRpc(response);
        session.sendSessionEvent({ type: 'message', message: error });
        if (command === 'prompt' && pendingLocalIds.length > 0) {
            const oldestLocalId = pendingLocalIds.shift()!;
            session.emitMessagesConsumed([oldestLocalId], { clearQueuedThinkingGrace: true });
        }
        return;
    }

    switch (command) {
        case 'get_state': {
            const data = response.data as Record<string, unknown> | undefined;
            handleGetState(data, session);
            break;
        }
        case 'set_model': {
            const data = response.data as Record<string, unknown> | undefined;
            // Pi returns model.id (not modelId). Fallback to modelId for forward compat.
            const modelId = (data?.id as string) ?? (data?.modelId as string);
            if (modelId) {
                session.currentModel = modelId;
            }
            if (data && typeof data.provider === 'string' && data.provider.length > 0) {
                session.currentProvider = data.provider;
            }
            logger.debug(`[pi] Model changed to: ${modelId ?? session.currentModel}`);
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
            }
            resolvePendingRpc(response);
            break;
        }
        case 'get_commands': {
            const commands = parsePiCommands(response.data);
            if (commands.length > 0) {
                session.cachedPiCommands = commands;
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
        default:
            logger.debug(`[pi] Response for ${command}`);
            resolvePendingRpc(response);
            break;
    }
}

// --- Wire transport events to session ---

export function wireTransportEvents(
    transport: PiTransport,
    session: PiSession,
    pendingLocalIds: string[],
): void {
    currentResolver = new PiRpcResolver();
    const assistantMessageAccumulator = new PiMessageAccumulator();

    transport.onEvent((event) => {
        // Debug: log all event types to diagnose missing Pi output
        if (event.type !== 'keep_alive') {
            logger.debug(`[pi][event] ${event.type}`);
        }
        if (event.type === 'response') {
            handleResponse(event as unknown as PiResponseEvent, session, pendingLocalIds);
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
            if (event.type === 'agent_start' && pendingLocalIds.length > 0) {
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
