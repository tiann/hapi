import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/types';
import type {
    OmpAgentEvent,
    OmpToolExecutionStartEvent,
    OmpToolExecutionEndEvent,
    OmpTurnEndEvent
} from './types';

/**
 * Converts OMP AgentEvent to HAPI AgentMessage array.
 *
 * OMP events come from `omp --mode rpc` stdout as JSONL.
 * Not all OMP events map to HAPI AgentMessages — response/ack events
 * are handled directly by the runner, not by this converter.
 *
 * Same event shape as Pi (shared pi-agent-core AgentEvent).
 */
export function convertOmpEvent(event: OmpAgentEvent): AgentMessage[] {
    try {
        switch (event.type) {
            case 'tool_execution_start': {
                const e = event as OmpToolExecutionStartEvent;
                return [{
                    type: 'tool_call',
                    id: e.toolCallId,
                    name: e.toolName,
                    input: e.args,
                    status: 'in_progress'
                }];
            }

            case 'tool_execution_end': {
                const e = event as OmpToolExecutionEndEvent;
                return [{
                    type: 'tool_result',
                    id: e.toolCallId,
                    output: e.result,
                    status: e.isError ? 'failed' : 'completed'
                }];
            }

            case 'turn_end': {
                const e = event as OmpTurnEndEvent;
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
            // message_start/update/end are handled by OmpMessageAccumulator
            // in loop.ts before this converter is called — they never reach here,
            // but are listed for exhaustive matching.
            // goal_updated / auto_compaction_* / thinking_level_changed /
            // available_commands_update / subagent_* are handled in loop.ts
            // (mapped onto hapi's generic web events), not here.
            case 'agent_start':
            case 'agent_end':
            case 'turn_start':
            case 'message_start':
            case 'message_update':
            case 'message_end':
            case 'tool_execution_update':
            case 'extension_ui_request':
            case 'host_tool_call':
            case 'host_tool_cancel':
            case 'host_uri_request':
            case 'host_uri_cancel':
            case 'available_commands_update':
            case 'goal_updated':
            case 'auto_compaction_start':
            case 'auto_compaction_end':
            case 'thinking_level_changed':
            case 'ready':
            case 'subagent_lifecycle':
            case 'subagent_progress':
            case 'subagent_event':
            case 'keep_alive':
            case 'response':
                return [];

            default:
                logger.debug(`[omp] Unknown event type: ${event.type}`);
                return [];
        }
    } catch (err) {
        logger.debug(`[omp] convertOmpEvent failed for type=${event.type}: ${err}`);
        return [];
    }
}
