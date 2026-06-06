import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/types';
import type {
    PiAgentEvent,
    PiMessageUpdateEvent,
    PiToolExecutionStartEvent,
    PiToolExecutionEndEvent,
    PiTurnEndEvent
} from './types';

/**
 * Converts Pi AgentEvent to HAPI AgentMessage array.
 *
 * Pi events come from `pi --mode rpc` stdout as JSONL.
 * Not all Pi events map to HAPI AgentMessages — response/ack events
 * are handled directly by the runner, not by this converter.
 */
export function convertPiEvent(event: PiAgentEvent): AgentMessage[] {
    try {
        switch (event.type) {
            case 'message_update': {
                const e = event as PiMessageUpdateEvent;
                const ame = e.assistantMessageEvent;
                if (!ame) return [];
                // Web expects { type: 'message', message: '...' } for text and { type: 'reasoning', message: '...' } for thinking.
                // ID is required for streaming/dedup in the web UI.
                const streamId = (ame as { contentIndex?: number }).contentIndex?.toString() ?? 'pi-stream';
                // Only send deltas to avoid duplicate text. text_start/thinking_start/text_end/thinking_end
                // carry the full partial state and would cause the web UI to render the same text multiple times.
                if (ame.type === 'text_delta') {
                    const delta = (ame as { delta?: string }).delta;
                    if (!delta) return [];
                    return [{ type: 'message', message: delta, id: streamId }];
                }
                if (ame.type === 'thinking_delta') {
                    const delta = (ame as { delta?: string }).delta;
                    if (!delta) return [];
                    return [{ type: 'reasoning', message: delta, id: streamId }];
                }
                return [];
            }

            case 'tool_execution_start': {
                const e = event as PiToolExecutionStartEvent;
                return [{
                    type: 'tool_call',
                    id: e.toolCallId,
                    name: e.toolName,
                    input: e.args,
                    status: 'in_progress'
                }];
            }

            case 'tool_execution_end': {
                const e = event as PiToolExecutionEndEvent;
                return [{
                    type: 'tool_result',
                    id: e.toolCallId,
                    output: e.result,
                    status: e.isError ? 'failed' : 'completed'
                }];
            }

            case 'turn_end': {
                const e = event as PiTurnEndEvent;
                const messages: AgentMessage[] = [];
                const usage = e.message?.usage;

                if (usage) {
                    messages.push({
                        type: 'usage',
                        inputTokens: usage.input ?? 0,
                        outputTokens: usage.output ?? 0,
                        totalTokens: usage.totalTokens,
                        cacheReadTokens: usage.cacheRead
                    });
                }

                messages.push({
                    type: 'turn_complete',
                    stopReason: e.message?.stopReason ?? 'stop'
                });

                return messages;
            }

            // Lifecycle and other events — not converted to AgentMessage
            case 'agent_start':
            case 'agent_end':
            case 'turn_start':
            case 'message_start':
            case 'message_end':
            case 'tool_execution_update':
            case 'extension_ui_request':
            case 'response':
                return [];

            default:
                logger.debug(`[pi] Unknown event type: ${event.type}`);
                return [];
        }
    } catch (err) {
        logger.debug(`[pi] convertPiEvent failed for type=${event.type}: ${err}`);
        return [];
    }
}
