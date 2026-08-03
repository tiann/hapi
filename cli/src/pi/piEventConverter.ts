import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/types';
import {
    PiToolExecutionEndEventSchema,
    PiToolExecutionStartEventSchema,
    PiToolExecutionUpdateEventSchema,
} from './schemas';
import type { PiAgentEvent, PiContextUsage, PiTurnEndEvent, PiUsage } from './types';

function hasMeaningfulUsage(usage: PiUsage | undefined): usage is PiUsage {
    return usage !== undefined && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0;
}

/** Builds a turn usage update after Pi's session-stats request settles. */
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
        cacheCreationTokens: usage.cacheWrite,
        contextTokens: contextUsage?.tokens ?? usage.totalTokens,
        contextWindow: contextUsage?.contextWindow,
    };
}

/** Converts validated Pi lifecycle events to HAPI chat messages. */
export function convertPiEvent(event: PiAgentEvent): AgentMessage[] {
    switch (event.type) {
        case 'tool_execution_start': {
            const parsed = PiToolExecutionStartEventSchema.safeParse(event);
            if (!parsed.success) return [];
            return [{
                type: 'tool_call',
                id: parsed.data.toolCallId,
                name: parsed.data.toolName,
                input: parsed.data.args,
                status: 'in_progress',
            }];
        }
        case 'tool_execution_update': {
            const parsed = PiToolExecutionUpdateEventSchema.safeParse(event);
            if (!parsed.success) return [];
            return [{
                type: 'tool_call',
                id: parsed.data.toolCallId,
                name: parsed.data.toolName,
                input: parsed.data.args,
                status: 'in_progress',
                progress: parsed.data.partialResult,
            }];
        }
        case 'tool_execution_end': {
            const parsed = PiToolExecutionEndEventSchema.safeParse(event);
            if (!parsed.success) return [];
            return [{
                type: 'tool_result',
                id: parsed.data.toolCallId,
                output: parsed.data.result,
                status: parsed.data.isError ? 'failed' : 'completed',
            }];
        }
        case 'turn_end': {
            const turn = event as PiTurnEndEvent;
            return [{ type: 'turn_complete', stopReason: turn.message?.stopReason ?? 'stop' }];
        }
        case 'agent_start':
        case 'agent_end':
        case 'agent_settled':
        case 'turn_start':
        case 'message_start':
        case 'message_update':
        case 'message_end':
        case 'extension_ui_request':
        case 'keep_alive':
        case 'response':
            return [];
        default:
            logger.debug(`[pi] Unknown event type: ${event.type}`);
            return [];
    }
}
