import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import { OmpTransport } from './ompTransport';
import { convertOmpEvent } from './ompEventConverter';
import { OmpMessageAccumulator } from './ompMessageAccumulator';
import {
    parseOmpModels,
    parseOmpCommands,
    OmpResponseEventSchema,
    OmpStateDataSchema,
    OmpSetModelDataSchema,
    OmpThinkingLevelSchema,
    OmpSubagentLifecycleEventSchema,
    OmpSubagentProgressEventSchema,
} from './schemas';
import type { ParsedOmpSubagentProgressEvent } from './schemas';
import type { OmpResponseEvent, OmpRpcCommand, OmpAgentEvent, OmpGoalUpdatedEvent, OmpAutoCompactionStartEvent, OmpAutoCompactionEndEvent, OmpThinkingLevelChangedEvent } from './types';
import type { OmpSession } from './session';

// --- Response parsers: re-exported from schemas.ts ---
export { parseOmpModels, parseOmpCommands } from './schemas';

// --- Pending RPC resolver ---
// Instance-scoped: created once by wireTransportEvents, stored on OmpSession.
export class OmpRpcResolver {
    private idCounter = 0;
    private readonly pending = new Map<number, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
    }>();

    sendAndWait(transport: OmpTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
        const id = ++this.idCounter;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`OMP RPC ${command.type} (id=${id}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (data) => { clearTimeout(timer); this.pending.delete(id); resolve(data); },
                reject: (error) => { clearTimeout(timer); this.pending.delete(id); reject(error); },
            });

            transport.send({ ...command, id: String(id) } as unknown as OmpRpcCommand);
        });
    }

    resolveResponse(raw: unknown): void {
        const parsed = OmpResponseEventSchema.safeParse(raw);
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

export function sendOmpRpcAndWait(session: OmpSession, transport: OmpTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    if (!session.rpcResolver) throw new Error('OMP RPC resolver not initialized');
    return session.rpcResolver.sendAndWait(transport, command, timeoutMs);
}

function resolvePendingRpc(resolver: OmpRpcResolver, response: OmpResponseEvent): void {
    resolver.resolveResponse(response);
}

// Mirror the web picker's provider-qualified selection into metadata so the hub
// and web can disambiguate duplicate modelId values across providers.
function persistSelectedOmpModel(session: OmpSession): void {
    const modelId = session.currentModel;
    const provider = session.currentProvider;
    if (!modelId || !provider) return;
    session.updateMetadata((meta) => ({
        ...meta,
        ompSelectedModel: { provider, modelId },
    }));
}

// --- OMP goal → hapi thread-goal-updated ---
//
// web `normalizeAgent` dispatches on `body.type === 'thread_goal_updated'` and
// `normalizeThreadGoal` requires { threadId, objective, status } where status ∈
// {active, paused, budgetLimited, complete}. OMP's goal uses { id, status ∈
// {active, paused, budget-limited, complete, dropped} }. Map:
//   id → threadId; 'budget-limited' → 'budgetLimited'; 'dropped' → cleared.
function emitGoalEvent(event: OmpGoalUpdatedEvent, session: OmpSession): void {
    const goal = event.goal;
    if (!goal) {
        // goal: null means cleared.
        session.sendAgentEvent({ type: 'thread_goal_cleared' });
        return;
    }
    if (goal.status === 'dropped') {
        session.sendAgentEvent({ type: 'thread_goal_cleared' });
        return;
    }
    const status = goal.status === 'budget-limited' ? 'budgetLimited' : goal.status;
    session.sendAgentEvent({
        type: 'thread_goal_updated',
        threadId: goal.id,
        goal: {
            threadId: goal.id,
            objective: goal.objective,
            status,
            tokenBudget: goal.tokenBudget,
            tokensUsed: goal.tokensUsed ?? 0,
            timeUsedSeconds: goal.timeUsedSeconds ?? 0,
            createdAt: goal.createdAt ?? 0,
            updatedAt: goal.updatedAt ?? 0,
        },
    });
}

// --- Response handler ---

function handleGetState(
    rawData: unknown,
    session: OmpSession,
): void {
    const parsed = OmpStateDataSchema.safeParse(rawData);
    if (!parsed.success) return;
    const data = parsed.data;

    if (data.model) {
        // OMP returns model.id (not modelId). Fallback to modelId for forward compat.
        const newModel = data.model.id ?? data.model.modelId ?? session.currentModel;
        if (data.model.provider && data.model.provider.length > 0) {
            session.currentProvider = data.model.provider;
        }
        // Do NOT overwrite currentModel with the unconfirmed startup model here.
        // The requested startup model is applied (and committed) only after
        // get_available_models confirms it exists and OMP accepts set_model.
        session.currentModel = newModel ?? session.currentModel;
        if (session.initialModel) {
            logger.debug(`[omp] Startup model requested: ${session.initialModel} (will apply once available models arrive); OMP default model: ${newModel ?? 'unknown'}`);
        } else if (newModel) {
            logger.debug(`[omp] Initial model: ${newModel} (provider=${session.currentProvider ?? 'unknown'})`);
        }
        persistSelectedOmpModel(session);
    }

    if (data.sessionId) {
        session.updateMetadata((meta) => ({ ...meta, ompSessionId: data.sessionId }));
        logger.debug(`[omp] Session ID persisted to metadata: ${data.sessionId}`);
    }
    if (data.sessionFile) {
        session.updateMetadata((meta) => ({ ...meta, ompSessionFile: data.sessionFile }));
    }

    if (data.thinkingLevel) {
        // Validate against the thinking-level enum so a future OMP level or an
        // unexpected value doesn't propagate to the hub via keepAlive.
        const levelResult = OmpThinkingLevelSchema.safeParse(
            typeof data.thinkingLevel === 'string' ? data.thinkingLevel.trim().toLowerCase() : data.thinkingLevel,
        );
        if (levelResult.success) {
            session.currentThinkingLevel = levelResult.data;
            logger.debug(`[omp] Initial thinking level: ${levelResult.data}`);
        }
    }

    if (data.steeringMode) session.currentSteeringMode = data.steeringMode;
    if (data.followUpMode) session.currentFollowUpMode = data.followUpMode;
    if (data.interruptMode) session.currentInterruptMode = data.interruptMode;
}

function handleResponse(
    response: OmpResponseEvent,
    session: OmpSession,
    pendingLocalIds: string[],
    transport?: OmpTransport,
): void {
    const { command, success } = response;
    const resolver = session.rpcResolver!;

    if (!success) {
        const error = response.error ?? 'Unknown OMP error';
        logger.debug(`[omp] RPC error for ${command}: ${error}`);
        resolvePendingRpc(resolver, response);
        // Subagent progress is an optional capability. Older OMP versions reject
        // the subscription command; settle the awaiting RPC without surfacing a
        // session error to the user, then let runOmp fall back gracefully.
        if (command === 'set_subagent_subscription') return;
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
            const parsed = OmpSetModelDataSchema.safeParse(response.data);
            if (parsed.success) {
                const data = parsed.data;
                const modelId = data.id ?? data.modelId;
                if (modelId) {
                    session.currentModel = modelId;
                }
                if (data.provider && data.provider.length > 0) {
                    session.currentProvider = data.provider;
                }
                persistSelectedOmpModel(session);
                logger.debug(`[omp] Model changed to: ${modelId ?? session.currentModel}`);
            }
            // set_model is awaited by SetSessionConfig; resolve so the awaited
            // RPC does not time out (/sessions/:id/model would return 409).
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'set_thinking_level': {
            // Awaited by SetSessionConfig (symmetry with set_model).
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'get_available_models': {
            const models = parseOmpModels(response.data);
            if (models.length > 0) {
                session.cachedOmpModels = models;
                logger.debug(`[omp] Available models: ${models.map((m) => m.modelId).join(', ')}`);
                session.updateMetadata((meta) => ({
                    ...meta,
                    ompAvailableModels: models,
                }));

                // Apply the requested startup model only after confirming it exists
                // in OMP's available models and OMP accepts set_model. Fire-and-forget
                // so resolving the get_available_models RPC itself is not blocked.
                if (session.initialModel && transport && !session.initialModelApplied) {
                    session.initialModelApplied = true;
                    // Prefer the provider OMP is actually using (currentProvider,
                    // set by get_state on resume) so a modelId that exists under
                    // multiple providers resumes the correct one instead of the
                    // first match. Falls back to modelId-only when no provider
                    // is known yet (fresh session, get_state not returned).
                    const providerHint = session.currentProvider;
                    const match = providerHint
                        ? models.find((m) => m.provider === providerHint && m.modelId === session.initialModel)
                        : models.find((m) => m.modelId === session.initialModel);
                    if (match) {
                        void (async () => {
                            try {
                                await sendOmpRpcAndWait(session, transport, {
                                    type: 'set_model',
                                    provider: match.provider,
                                    modelId: match.modelId,
                                });
                                // handleResponse's 'set_model' branch already
                                // committed currentModel/currentProvider from
                                // OMP's confirmed (possibly normalized) response.
                                // Don't overwrite with the request modelId here —
                                // only persist the provider-qualified selection.
                                persistSelectedOmpModel(session);
                                logger.debug(`[omp] Startup model applied: ${match.provider}/${match.modelId}`);
                            } catch (error) {
                                logger.debug(`[omp] Startup model set_model rejected, keeping OMP default: ${error instanceof Error ? error.message : String(error)}`);
                            }
                        })();
                    } else {
                        logger.debug(`[omp] Startup model not found in available models: ${session.initialModel}`);
                    }
                }
            }
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'get_available_commands': {
            const commands = parseOmpCommands(response.data);
            if (commands.length > 0) {
                session.cachedOmpCommands = commands;
                logger.debug(`[omp] Available commands: ${commands.map((c) => c.name).join(', ')}`);
            }
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'new_session':
            logger.debug('[omp] OMP session initialized');
            break;
        case 'abort':
            logger.debug('[omp] Abort confirmed');
            break;
        case 'prompt':
            logger.debug('[omp] Prompt accepted');
            break;
        default:
            logger.debug(`[omp] Response for ${command}`);
            resolvePendingRpc(resolver, response);
            break;
    }
}

// --- Wire transport events to session ---

export function wireTransportEvents(
    transport: OmpTransport,
    session: OmpSession,
    pendingLocalIds: string[],
): () => void {
    session.rpcResolver = new OmpRpcResolver();
    const assistantMessageAccumulator = new OmpMessageAccumulator();
    const activeSubagentCards = new Map<string, Record<string, unknown>>();
    const terminalSubagentIds = new Set<string>();
    let disposed = false;

    const sendSubagentToolCall = (id: string, input: Record<string, unknown>): void => {
        activeSubagentCards.set(id, input);
        session.sendAgentMessage({
            type: 'tool-call',
            name: 'Agent',
            callId: `omp-subagent:${id}`,
            input,
        });
    };

    const progressActivity = (event: ParsedOmpSubagentProgressEvent): string => {
        const progress = event.payload.progress;
        if (progress.retryState) {
            const { attempt, maxAttempts, errorMessage } = progress.retryState;
            return `Retrying ${attempt}/${maxAttempts}${errorMessage ? `: ${errorMessage}` : ''}`;
        }
        if (progress.retryFailure) {
            return `Retry failed${progress.retryFailure.errorMessage ? `: ${progress.retryFailure.errorMessage}` : ''}`;
        }
        if (progress.lastIntent) return progress.lastIntent;
        if (progress.currentTool) {
            return progress.currentToolArgs
                ? `${progress.currentTool}: ${progress.currentToolArgs}`
                : `Running ${progress.currentTool}`;
        }
        switch (progress.status) {
            case 'pending': return 'Pending';
            case 'running': return 'Running';
            case 'completed': return 'Completed';
            case 'failed': return 'Failed';
            case 'aborted': return 'Aborted';
        }
    };

    const progressRetry = (event: ParsedOmpSubagentProgressEvent): Record<string, unknown> | undefined => {
        const { retryState, retryFailure } = event.payload.progress;
        if (retryState) {
            return {
                attempt: retryState.attempt,
                maxAttempts: retryState.maxAttempts,
                delayMs: retryState.delayMs,
                errorMessage: retryState.errorMessage,
            };
        }
        if (retryFailure) {
            return {
                attempt: retryFailure.attempt,
                errorMessage: retryFailure.errorMessage,
            };
        }
        return undefined;
    };

    const finishSubagentCard = (
        id: string,
        status: 'completed' | 'failed' | 'aborted',
        description?: string,
    ): void => {
        terminalSubagentIds.add(id);
        const existing = activeSubagentCards.get(id);
        if (!existing) return;

        const activity = { completed: 'Completed', failed: 'Failed', aborted: 'Aborted' }[status];
        const finalInput: Record<string, unknown> = {
            ...existing,
            ...(description ? { description } : {}),
            status,
            activity,
        };
        session.sendAgentMessage({
            type: 'tool-call',
            name: 'Agent',
            callId: `omp-subagent:${id}`,
            input: finalInput,
        });
        session.sendAgentMessage({
            type: 'tool-call-result',
            callId: `omp-subagent:${id}`,
            output: {
                status,
                description: finalInput.description,
                agent: finalInput.subagent_type,
                model: finalInput.model,
                requests: finalInput.requests,
                tokens: finalInput.tokens,
                durationMs: finalInput.duration_ms,
            },
            is_error: status !== 'completed',
        });
        activeSubagentCards.delete(id);
    };

    transport.onEvent((event: OmpAgentEvent) => {
        if (disposed) return;
        if (event.type !== 'keep_alive') {
            logger.debug(`[omp][event] ${event.type}`);
        }

        // RPC responses are id-correlated by the resolver. Validate the shape
        // first — OmpAgentEventSchema only checks `{ type: string }`, so a
        // malformed response (missing command/success) must not reach
        // handleResponse (would show "Unknown OMP error" and leave the pending
        // RPC hanging until timeout).
        if (event.type === 'response') {
            const parsed = OmpResponseEventSchema.safeParse(event);
            if (!parsed.success) {
                logger.debug(`[omp] Malformed response event, skipping: ${parsed.error.message.slice(0, 200)}`);
                return;
            }
            handleResponse(parsed.data, session, pendingLocalIds, transport);
            return;
        }

        // OMP pushes slash commands via available_commands_update (no need to
        // poll get_available_commands). Cache them for the ListSlashCommands RPC.
        if (event.type === 'available_commands_update') {
            const commands = parseOmpCommands(event);
            if (commands.length > 0) {
                session.cachedOmpCommands = commands;
                logger.debug(`[omp] Commands pushed: ${commands.map((c) => c.name).join(', ')}`);
            }
            return;
        }

        // OMP-only events mapped onto hapi's generic web events.
        if (event.type === 'goal_updated') {
            emitGoalEvent(event as OmpGoalUpdatedEvent, session);
            return;
        }
        if (event.type === 'auto_compaction_start') {
            // hapi web recognizes a `compact` agent event (presentation.ts).
            const e = event as OmpAutoCompactionStartEvent;
            session.sendAgentEvent({ type: 'compact', trigger: e.reason });
            return;
        }
        if (event.type === 'auto_compaction_end') {
            const e = event as OmpAutoCompactionEndEvent;
            if (e.aborted || e.errorMessage) {
                session.sendAgentEvent({ type: 'compact', trigger: 'aborted' });
            }
            return;
        }
        if (event.type === 'thinking_level_changed') {
            const e = event as OmpThinkingLevelChangedEvent;
            if (e.thinkingLevel) {
                const levelResult = OmpThinkingLevelSchema.safeParse(
                    typeof e.thinkingLevel === 'string' ? e.thinkingLevel.trim().toLowerCase() : e.thinkingLevel,
                );
                if (levelResult.success) {
                    session.currentThinkingLevel = levelResult.data;
                    session.pushKeepAlive();
                }
            }
            return;
        }
        if (event.type === 'subagent_lifecycle') {
            const parsed = OmpSubagentLifecycleEventSchema.safeParse(event);
            if (!parsed.success) {
                logger.debug(`[omp] Malformed subagent_lifecycle event, skipping: ${parsed.error.message.slice(0, 200)}`);
                return;
            }
            const { payload } = parsed.data;
            if (payload.status === 'started') {
                terminalSubagentIds.delete(payload.id);
                sendSubagentToolCall(payload.id, {
                    agent_id: payload.id,
                    subagent_type: payload.agent,
                    agent_source: payload.agentSource,
                    description: payload.description ?? `${payload.agent} agent`,
                    status: 'running',
                    activity: 'Starting',
                    index: payload.index,
                    detached: payload.detached,
                });
            } else {
                finishSubagentCard(payload.id, payload.status, payload.description);
            }
            return;
        }

        if (event.type === 'subagent_progress') {
            const parsed = OmpSubagentProgressEventSchema.safeParse(event);
            if (!parsed.success) {
                logger.debug(`[omp] Malformed subagent_progress event, skipping: ${parsed.error.message.slice(0, 200)}`);
                return;
            }
            const { payload } = parsed.data;
            const progress = payload.progress;
            if (terminalSubagentIds.has(progress.id)) return;
            const previous = activeSubagentCards.get(progress.id);
            sendSubagentToolCall(progress.id, {
                ...previous,
                agent_id: progress.id,
                subagent_type: payload.agent,
                agent_source: payload.agentSource,
                description: progress.description ?? previous?.description ?? payload.task ?? `${payload.agent} agent`,
                prompt: payload.assignment ?? payload.task ?? previous?.prompt,
                status: progress.status,
                activity: progressActivity(parsed.data),
                model: progress.resolvedModel,
                current_tool: progress.currentTool,
                current_tool_args: progress.currentToolArgs,
                retry: progressRetry(parsed.data),
                tool_count: progress.toolCount,
                requests: progress.requests,
                tokens: progress.tokens,
                duration_ms: progress.durationMs,
                index: payload.index,
                detached: payload.detached,
            });
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
            const messages = convertOmpEvent(event);
            for (const msg of messages) {
                const converted = convertAgentMessage(msg);
                if (converted) session.sendAgentMessage(converted);
            }
        }

        // Keep-alive + streaming state tracking
        //
        // OMP emits agent_start and turn_start back-to-back for each prompt.
        // Only turn_start marks "my prompt was accepted and a turn began", so
        // the pending localId is drained there.
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
            session.updateThinkingState(false);
        }
    });

    return () => {
        if (disposed) return;
        disposed = true;
        for (const [id, input] of activeSubagentCards) {
            session.sendAgentMessage({
                type: 'tool-call',
                name: 'Agent',
                callId: `omp-subagent:${id}`,
                input: { ...input, status: 'aborted', activity: 'Session ended' },
            });
            session.sendAgentMessage({
                type: 'tool-call-result',
                callId: `omp-subagent:${id}`,
                output: { status: 'aborted', reason: 'OMP session ended before the subagent completed' },
                is_error: true,
            });
        }
        activeSubagentCards.clear();
        terminalSubagentIds.clear();
    };
}
