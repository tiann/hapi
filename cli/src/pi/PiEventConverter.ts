import type { AgentMessage } from '@/agent/types';

/**
 * Converts Pi AgentEvent to HAPI AgentMessage array.
 *
 * Pi events come from `pi --mode rpc` stdout as JSONL.
 * Not all Pi events map to HAPI AgentMessages — response/ack events
 * are handled directly by the runner, not by this converter.
 */
export function convertPiEvent(event: Record<string, unknown>): AgentMessage[] {
    const type = event.type as string;

    switch (type) {
        case 'message_update': {
            const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (!ame) return [];
            const subType = ame.type as string;
            if (subType === 'text_delta') {
                return [{ type: 'text', text: String(ame.delta ?? '') }];
            }
            if (subType === 'thinking_delta') {
                return [{ type: 'reasoning', text: String(ame.delta ?? ''), live: true }];
            }
            // start, end, done, error, text_start/end, thinking_start/end, toolcall_* — not converted
            return [];
        }

        case 'tool_execution_start': {
            return [{
                type: 'tool_call',
                id: String(event.toolCallId ?? ''),
                name: String(event.toolName ?? ''),
                input: event.args,
                status: 'in_progress'
            }];
        }

        case 'tool_execution_end': {
            return [{
                type: 'tool_result',
                id: String(event.toolCallId ?? ''),
                output: event.result,
                status: (event.isError === true) ? 'failed' : 'completed'
            }];
        }

        case 'turn_end': {
            const messages: AgentMessage[] = [];
            const piMessage = event.message as Record<string, unknown> | undefined;
            const usage = piMessage?.usage as Record<string, unknown> | undefined;

            if (usage) {
                messages.push({
                    type: 'usage',
                    inputTokens: Number(usage.input ?? 0),
                    outputTokens: Number(usage.output ?? 0),
                    totalTokens: usage.totalTokens != null ? Number(usage.totalTokens) : undefined,
                    cacheReadTokens: usage.cacheRead != null ? Number(usage.cacheRead) : undefined
                });
            }

            messages.push({
                type: 'turn_complete',
                stopReason: String(piMessage?.stopReason ?? 'stop')
            });

            return messages;
        }

        // Lifecycle and response events — not converted to AgentMessage
        case 'agent_start':
        case 'agent_end':
        case 'response':
        case 'turn_start':
        case 'message_start':
        case 'message_end':
        case 'tool_execution_update':
            return [];

        default:
            return [];
    }
}
