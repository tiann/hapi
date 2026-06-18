import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/types';
import type {
    PiAgentEvent,
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

            // Lifecycle and other events — not converted to AgentMessage.
            // message_start/update/end are handled by PiMessageAccumulator
            // in loop.ts before this converter is called — they never reach here,
            // but are listed for exhaustive matching.
            case 'agent_start':
            case 'agent_end':
            case 'turn_start':
            case 'message_start':
            case 'message_update':
            case 'message_end':
            case 'tool_execution_update':
            case 'extension_ui_request':
            case 'keep_alive':
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
