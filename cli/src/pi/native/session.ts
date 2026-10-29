import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage } from '@/api/types';
import { convertAgentMessage } from '@/agent/messageConverter';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { isAuthorizedUploadFile, isPathWithinUploadDir } from '@/modules/common/handlers/uploads';
import { PiMessageAccumulator } from '../piMessageAccumulator';
import { convertPiEvent, convertPiTurnUsage } from '../piEventConverter';
import { parsePiCommands, parsePiModels, parsePiContextUsage, SetSessionConfigPayloadSchema } from '../schemas';
import { preparePiUserMessage } from '../runPi';
import { parseLeadingSlashName } from '../specialCommands';
import type { PiAgentEvent, PiTurnEndEvent } from '../types';
import type { PiCommandSummary, PiModelSummary } from '@hapi/protocol/apiTypes';

type NativeRequest = (command: Record<string, unknown>, sessionId: string) => Promise<unknown>;

export type PiNativeState = {
    sessionId: string;
    sessionFile?: string;
    sessionName?: string;
    model?: { id: string; provider: string };
    thinkingLevel?: string;
    isStreaming?: boolean;
    streamGeneration?: number;
    sessionGeneration?: number;
    branch?: unknown[];
};

type SteerResult = { steered: boolean; error?: string };
type PendingInput = {
    message: UserMessage;
    localId?: string;
    steerGeneration?: number;
    cancelled?: boolean;
    steerWaiter?: { promise: Promise<SteerResult>; resolve: (result: SteerResult) => void };
};

/** One immutable HAPI/native binding. A native session switch creates another. */
export class PiNativeSessionBridge {
    private active = true;
    private ready = false;
    private streaming = false;
    private streamGeneration = 0;
    private lifecycleRevision = 0;
    private sessionGeneration = 0;
    private connectionRevision = 0;
    private dispatching = false;
    private startupProbe: ReturnType<typeof setTimeout> | undefined;
    private readonly queue: PendingInput[] = [];
    private readonly accumulator = new PiMessageAccumulator();
    private models: PiModelSummary[] = [];
    private commands: PiCommandSummary[] = [];
    private model: string | undefined;
    private provider: string | undefined;
    private effort: string | undefined;
    private readonly syncTitle: (title: unknown) => void;
    private readonly keepAliveTimer: ReturnType<typeof setInterval>;

    constructor(
        readonly client: ApiSessionClient,
        readonly nativeSessionId: string,
        private readonly request: NativeRequest,
    ) {
        this.syncTitle = createNativeSessionTitleMetadataSync(client);
        client.updateMetadata(metadata => ({
            ...metadata,
            piSessionId: nativeSessionId,
            startingMode: 'local',
            slashCommands: [],
            capabilities: { terminal: true, concurrentClients: true },
        }));
        client.updateAgentState(state => ({ ...state, controlledByUser: true, startingMode: 'local' }));
        client.onUserMessage((message, localId) => {
            const entry: PendingInput = { message, localId };
            if (message.meta?.deliveryMode === 'steer') entry.steerGeneration = this.streaming ? this.streamGeneration : -1;
            this.queue.push(entry);
            void this.pump();
        });
        client.onCancelQueuedMessage(localId => {
            const entry = this.queue.find(item => item.localId === localId);
            if (!entry) return false;
            entry.cancelled = true;
            entry.steerWaiter?.resolve({ steered: false, error: 'Message cancelled' });
            return true;
        });
        this.registerHandlers();
        this.keepAliveTimer = setInterval(() => this.keepAlive(), 2_000);
        this.keepAliveTimer.unref?.();
    }

    async initialize(state: PiNativeState, replayHistory: boolean): Promise<void> {
        const revision = ++this.connectionRevision;
        this.sessionGeneration = state.sessionGeneration ?? this.sessionGeneration;
        this.applyState(state);
        let models: unknown;
        let commands: unknown;
        try {
            await this.rpc({ type: 'bind_hapi_session', hapiSessionId: this.client.sessionId });
            if (revision !== this.connectionRevision) return;
            [models, commands] = await Promise.all([
                this.rpc({ type: 'get_available_models' }), this.rpc({ type: 'get_commands' }),
            ]);
        } catch (error) {
            if (!this.active || revision !== this.connectionRevision) return;
            throw error;
        }
        if (!this.active || revision !== this.connectionRevision) return;
        this.models = parsePiModels(models);
        this.commands = parsePiCommands(commands);
        this.client.updateMetadata(metadata => ({ ...metadata, piAvailableModels: this.models }));
        if (replayHistory) this.replayBranch(state.branch ?? []);
        this.client.emitSessionReady();
        this.ready = true;
        this.keepAlive();
        void this.pump();
    }

    applyState(state: PiNativeState): void {
        if (state.sessionId !== this.nativeSessionId) throw new Error('Pi native session identity changed');
        if (state.sessionGeneration !== undefined && state.sessionGeneration !== this.sessionGeneration) {
            throw new Error('Pi native branch generation changed');
        }
        this.model = state.model?.id;
        this.provider = state.model?.provider;
        this.effort = state.thinkingLevel;
        this.streaming = state.isStreaming ?? this.streaming;
        this.streamGeneration = state.streamGeneration ?? this.streamGeneration;
        this.syncTitle(state.sessionName);
        this.client.updateMetadata(metadata => ({
            ...metadata,
            ...(this.model && this.provider ? { piSelectedModel: { modelId: this.model, provider: this.provider } } : {}),
        }));
        this.keepAlive();
    }

    handleEvent(event: Record<string, unknown>): void {
        if (!this.active) return;
        if (event.type === 'input') {
            // Web inputs already have durable hub rows. Echo only actual terminal
            // input, never infer its source by matching text against web input.
            if (event.source === 'interactive' && typeof event.text === 'string') {
                this.client.sendUserMessage(event.text, { sentFrom: 'cli' }, randomUUID());
            }
            return;
        }
        if (['state', 'model_select', 'thinking_level_select'].includes(String(event.type)) && event.state) {
            this.applyState(event.state as PiNativeState);
            return;
        }
        if (event.type === 'session_info_changed') this.syncTitle(event.name);
        if (event.type === 'agent_start') {
            this.lifecycleRevision++;
            this.streaming = true;
            this.streamGeneration = typeof event.streamGeneration === 'number' ? event.streamGeneration : this.streamGeneration + 1;
            this.keepAlive();
        }
        // The TUI source owns user input. User message_start/end must not echo
        // the same web message again, or flush an assistant stream mid-message.
        const role = (event.message as { role?: string } | undefined)?.role;
        if (role !== 'user') {
            this.publish(this.accumulator.handleEvent(event as PiAgentEvent));
            if (!['message_start', 'message_update', 'message_end'].includes(String(event.type))) {
                this.publish(convertPiEvent(event as PiAgentEvent));
            }
        }
        if (event.type === 'turn_end') {
            void this.rpc({ type: 'get_session_stats' }).then(stats => {
                const usage = convertPiTurnUsage(event as unknown as PiTurnEndEvent, parsePiContextUsage(stats));
                if (this.active && usage) this.publish([usage]);
            }).catch(() => {});
        }
        // agent_end can be followed by retries, compaction or native queued input.
        // Pi 1.4's agent_settled is the authoritative idle boundary.
        if (event.type === 'agent_settled') {
            this.lifecycleRevision++;
            this.streaming = false;
            this.keepAlive();
            void this.pump();
        }
    }

    deactivate(): void {
        if (!this.active) return;
        this.active = false;
        clearInterval(this.keepAliveTimer);
        clearTimeout(this.startupProbe);
        this.publish(this.accumulator.flush());
        // The previous HAPI row must never deliver queued input to a new native
        // conversation. Leave pending rows durable; there is no automatic replay.
        this.suspend();
        this.queue.length = 0;
    }

    suspend(): void {
        this.connectionRevision++;
        this.ready = false;
        clearTimeout(this.startupProbe);
        for (const entry of this.queue) {
            if (entry.steerGeneration === undefined) continue;
            entry.cancelled = true;
            entry.steerWaiter?.resolve({ steered: false, error: 'Pi session changed' });
        }
    }

    private async rpc(command: Record<string, unknown>): Promise<unknown> {
        if (!this.active) throw new Error('Pi native session is no longer active');
        const revision = this.connectionRevision;
        const result = await this.request({ ...command, sessionGeneration: this.sessionGeneration }, this.nativeSessionId);
        if (!this.active || revision !== this.connectionRevision) throw new Error('Pi native session changed during request');
        return result;
    }

    private keepAlive(): void {
        if (!this.active) return;
        this.client.keepAlive(this.streaming, 'local', { model: this.model, effort: this.effort });
    }

    private publish(messages: Parameters<typeof convertAgentMessage>[0][]): void {
        for (const message of messages) {
            const converted = convertAgentMessage(message, this.model);
            if (converted) this.client.sendAgentMessage(converted);
        }
    }

    private replayBranch(entries: unknown[]): void {
        for (const raw of entries) {
            const entry = raw as { id?: string; type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
            if (entry.type !== 'message' || !entry.id || !entry.message) continue;
            const message = entry.message;
            const content = message.content;
            const blocks = Array.isArray(content) ? content as Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }> : [];
            if (message.role === 'user') {
                const text = typeof content === 'string' ? content : blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
                this.client.sendUserMessage(text, { sentFrom: 'cli' }, `pi-native-${entry.id}`);
            } else if (message.role === 'assistant') {
                for (const [index, block] of blocks.entries()) {
                    if (block.type === 'text' && block.text) this.publish([{ type: 'text', text: block.text, id: `pi-native-${entry.id}-${index}` }]);
                    if (block.type === 'toolCall' && block.id && block.name) this.publish([{ type: 'tool_call', id: block.id, name: block.name, input: block.arguments, status: 'completed' }]);
                }
            } else if (message.role === 'toolResult' && message.toolCallId) {
                this.publish([{ type: 'tool_result', id: message.toolCallId, output: content, status: message.isError ? 'failed' : 'completed' }]);
            }
        }
    }

    private registerHandlers(): void {
        const handlers = this.client.rpcHandlerManager;
        handlers.registerHandler(RPC_METHODS.Abort, async () => {
            await this.rpc({ type: 'abort' });
            return { success: true };
        });
        const noHandoff = () => { throw new Error('Pi terminal and HAPI share this session; control handoff is not available'); };
        handlers.registerHandler(RPC_METHODS.Switch, noHandoff);
        handlers.registerHandler(RPC_METHODS.HandoffLocal, noHandoff);
        handlers.registerHandler(RPC_METHODS.ListPiModels, async () => {
            this.models = parsePiModels(await this.rpc({ type: 'get_available_models' }));
            return { success: true, models: this.models };
        });
        handlers.registerHandler(RPC_METHODS.ListSlashCommands, async () => {
            this.commands = parsePiCommands(await this.rpc({ type: 'get_commands' }));
            return { success: true, commands: [] };
        });
        handlers.registerHandler(RPC_METHODS.ListSkills, async () => ({ success: true, skills: [] }));
        handlers.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
            const config = SetSessionConfigPayloadSchema.parse(payload);
            if (config.model !== undefined) {
                const matches = this.models.filter(model => model.modelId === config.model);
                const selected = typeof config.model === 'object' && config.model !== null
                    ? config.model
                    : matches.length === 1 ? matches[0] : undefined;
                if (!selected) throw new Error('Select a provider-qualified Pi model');
                await this.rpc({ type: 'set_model', provider: selected.provider, modelId: selected.modelId });
            }
            if (config.effort !== undefined) await this.rpc({ type: 'set_thinking_level', level: config.effort ?? 'off' });
            this.applyState(await this.rpc({ type: 'get_state' }) as PiNativeState);
            return { applied: { model: this.model && this.provider ? { modelId: this.model, provider: this.provider } : this.model, effort: this.effort } };
        });
        handlers.registerHandler(RPC_METHODS.SteerQueuedMessage, async (payload: { localId?: string }) => {
            const entry = this.queue.find(item => item.localId === payload?.localId && !item.cancelled);
            if (!entry || !this.streaming) return { steered: false, error: 'Message is not queued in an active Pi turn' };
            if (entry.steerWaiter) return entry.steerWaiter.promise;
            let resolve!: (result: SteerResult) => void;
            const promise = new Promise<SteerResult>(done => { resolve = done; });
            entry.steerWaiter = { promise, resolve };
            entry.steerGeneration = this.streamGeneration;
            void this.pump();
            // Promotion is only a reservation. Report native acceptance after
            // the command reaches Pi, rather than claiming success on enqueue.
            return promise;
        });
    }

    private async pump(): Promise<void> {
        if (this.dispatching || !this.active || !this.ready) return;
        this.dispatching = true;
        try {
            while (this.active) {
                const index = this.queue.findIndex(item => item.cancelled || !this.streaming || item.steerGeneration !== undefined);
                if (index < 0) break;
                const entry = this.queue[index];
                if (entry.cancelled) { this.queue.splice(index, 1); continue; }
                try {
                    const prepared = await preparePiUserMessage(entry.message.content.text, entry.message.content.attachments, this.commands, {
                        authorizeImagePath: path => isPathWithinUploadDir(path, this.client.sessionId),
                        authorizeOpenedImage: (path, identity) => isAuthorizedUploadFile(path, this.client.sessionId, identity),
                    });
                    if (!this.active || !this.ready) break;
                    if (entry.cancelled) { this.queue.splice(index, 1); continue; }
                    if (prepared.imageReadErrors.length) throw new Error(prepared.imageReadErrors.join('\n'));
                    const name = parseLeadingSlashName(prepared.message);
                    if (name) throw new Error(`Use /${name} in the Pi terminal; slash commands are not available through the native bridge`);
                    if (entry.steerGeneration !== undefined && (!this.streaming || entry.steerGeneration !== this.streamGeneration)) {
                        throw new Error('The Pi turn targeted by this steering message has ended');
                    }
                    if (entry.steerGeneration === undefined && this.streaming) break;
                    // Capture dispatch before awaiting: cancellation must never
                    // report success once the command may have reached Pi.
                    this.queue.splice(index, 1);
                    const steered = entry.steerGeneration !== undefined;
                    this.streaming = true;
                    await this.rpc({ type: steered ? 'steer' : 'prompt', message: prepared.message, images: prepared.images,
                        ...(steered ? { expectedStreamGeneration: entry.steerGeneration } : {}),
                    });
                    if (entry.localId) this.client.emitMessagesConsumed([entry.localId], { clearQueuedThinkingGrace: true, ...(steered ? { steered: true } : {}) });
                    entry.steerWaiter?.resolve({ steered: true });
                    // A successful submission can precede agent_start. Keep the
                    // next web prompt queued until Pi reports its true boundary.
                    this.keepAlive();
                    // Public Pi extensions submit input without a disposition
                    // callback. An input hook can handle it without starting a
                    // model turn. Reconcile state once; never resubmit the input.
                    const revision = this.lifecycleRevision;
                    clearTimeout(this.startupProbe);
                    this.startupProbe = setTimeout(() => {
                        void this.rpc({ type: 'get_state' }).then(raw => {
                            if (revision !== this.lifecycleRevision) return;
                            this.applyState(raw as PiNativeState);
                            void this.pump();
                        }).catch(() => {});
                    }, 1_000);
                    this.startupProbe.unref?.();
                } catch (error) {
                    entry.steerWaiter?.resolve({ steered: false, error: error instanceof Error ? error.message : String(error) });
                    const remaining = this.queue.indexOf(entry);
                    if (remaining >= 0) this.queue.splice(remaining, 1);
                    if (this.active) this.client.sendSessionEvent({ type: 'message', message: `Pi input was not confirmed: ${error instanceof Error ? error.message : String(error)}. Inspect the terminal before retrying.` });
                    // Retire this delivery after reporting uncertainty. Leaving
                    // it queued would let a later wrapper automatically replay
                    // a command that might already have reached the native Pi.
                    if (entry.localId) this.client.emitMessagesConsumed([entry.localId], { clearQueuedThinkingGrace: true });
                    const revision = this.lifecycleRevision;
                    try {
                        const state = await this.rpc({ type: 'get_state' }) as PiNativeState;
                        if (revision === this.lifecycleRevision) this.applyState(state);
                    } catch { this.ready = false; }
                }
            }
        } finally {
            this.dispatching = false;
        }
    }
}
