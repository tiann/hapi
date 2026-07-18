import type { AgentMessage } from '@/agent/types';
import { AcpMessageHandler } from '@/agent/backends/acp/AcpMessageHandler';
import { asString, isObject } from '@hapi/protocol';

export type GrokInterpreterEvent =
    | { type: 'agent'; message: AgentMessage }
    | { type: 'config'; model: string | null; effort: string | null }
    | { type: 'mode'; mode: string }
    | { type: 'interaction'; status: 'pending' | 'resolved'; toolCallId: string; kind?: string }
    | { type: 'status'; status: string; data: Record<string, unknown> }
    | { type: 'unknown'; method: string; params: unknown };

const UPDATE_METHODS = new Set(['session/update', '_x.ai/session/update', '_x.ai/session_notification']);
const ACP_UPDATE_TYPES = new Set([
    'agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk',
    'tool_call', 'tool_call_update', 'plan'
]);

export class GrokUpdateInterpreter {
    private readonly messageHandler: AcpMessageHandler;

    constructor(
        private readonly emit: (event: GrokInterpreterEvent) => void,
        options: { emitUserMessages?: boolean } = {}
    ) {
        this.messageHandler = new AcpMessageHandler(
            (message) => this.emit({ type: 'agent', message }),
            { emitReasoning: true, emitUserMessages: options.emitUserMessages ?? true }
        );
    }

    handle(method: string, params: unknown): void {
        if (!UPDATE_METHODS.has(method)) {
            this.emit({ type: 'unknown', method, params });
            return;
        }
        if (!isObject(params) || !isObject(params.update)) return;
        const update = params.update;
        const updateType = asString(update.sessionUpdate);
        if (!updateType) return;

        if (updateType === 'model_changed') {
            this.emit({
                type: 'config',
                model: asString(update.model_id ?? update.modelId),
                effort: asString(update.reasoning_effort ?? update.reasoningEffort)
            });
            return;
        }
        if (updateType === 'current_mode_update') {
            const mode = asString(update.currentModeId);
            if (mode) this.emit({ type: 'mode', mode });
            return;
        }
        if (updateType === 'pending_interaction' || updateType === 'interaction_resolved') {
            const toolCallId = asString(update.tool_call_id ?? update.toolCallId);
            if (toolCallId) {
                this.emit({
                    type: 'interaction',
                    status: updateType === 'pending_interaction' ? 'pending' : 'resolved',
                    toolCallId,
                    ...(asString(update.kind) ? { kind: asString(update.kind)! } : {})
                });
            }
            return;
        }
        if (updateType === 'turn_completed') {
            this.messageHandler.flush();
            this.emit({
                type: 'agent',
                message: { type: 'turn_complete', stopReason: asString(update.stop_reason ?? update.stopReason) ?? 'end_turn' }
            });
            return;
        }
        if (updateType === 'retry_state' || updateType === 'session_recap' || updateType === 'session_summary_generated') {
            this.emit({ type: 'status', status: updateType, data: update });
            return;
        }

        if (ACP_UPDATE_TYPES.has(updateType)) {
            this.messageHandler.handleUpdate(update);
            return;
        }
        this.emit({ type: 'unknown', method: `${method}:${updateType}`, params: update });
    }

    flush(): void {
        this.messageHandler.flush();
    }
}
