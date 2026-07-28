import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/types';
import type {
    PiAgentEvent,
    PiToolExecutionStartEvent,
    PiToolExecutionEndEvent,
    PiTurnEndEvent,
    PiContextUsage,
    PiUsage
} from './types';

function hasMeaningfulUsage(usage: PiUsage | undefined): usage is PiUsage {
    return usage !== undefined
        && Number.isFinite(usage.totalTokens)
        && usage.totalTokens > 0;
}

/**
 * Builds the turn usage update after Pi's session stats request settles.
 *
 * undefined stats fall back to the turn's totalTokens for older Pi versions.
 * null means Pi explicitly reported an unknown context size, so the previous
 * valid HAPI usage state is preserved by not publishing an update.
 */
export function convertPiTurnUsage(
    event: PiTurnEndEvent,
    contextUsage: PiContextUsage | null | undefined,
): AgentMessage | null {
    const usage = event.message?.usage;
    if (!hasMeaningfulUsage(usage) || contextUsage === null) return null;

    return {
        type: 'usage',
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheRead,
        contextTokens: contextUsage?.tokens ?? usage.totalTokens,
        contextWindow: contextUsage?.contextWindow,
    };
}

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
                return [{
                    type: 'turn_complete',
                    stopReason: e.message?.stopReason ?? 'stop'
                }];
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
