/**
 * Pi RPC protocol type definitions.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 * Based on Pi coding-agent's rpc-types.ts and agent/types.ts.
 */

// ============================================================================
// Pi Agent Events (stdout) — discriminated union on `type`
// ============================================================================

export interface PiTextDeltaEvent {
    type: 'text_delta';
    delta: string;
}

export interface PiThinkingDeltaEvent {
    type: 'thinking_delta';
    delta: string;
}

export type PiAssistantMessageEvent =
    | PiTextDeltaEvent
    | PiThinkingDeltaEvent
    | { type: 'start' }
    | { type: 'done'; reason: string }
    | { type: 'error'; reason: string; error: unknown }
    // Catch-all for text_start, text_end, thinking_start, thinking_end, toolcall_* etc.
    | { type: string; [key: string]: unknown };

export interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
}

// Individual event types for proper type narrowing
export interface PiAgentStartEvent { type: 'agent_start' }
export interface PiAgentEndEvent { type: 'agent_end'; messages: unknown[] }
export interface PiTurnStartEvent { type: 'turn_start' }
export interface PiTurnEndEvent {
    type: 'turn_end';
    message?: { usage?: PiUsage; stopReason?: string };
    toolResults?: unknown[];
}
export interface PiMessageStartEvent { type: 'message_start'; message: unknown }
export interface PiMessageUpdateEvent {
    type: 'message_update';
    assistantMessageEvent?: PiAssistantMessageEvent;
    message?: unknown;
}
export interface PiMessageEndEvent { type: 'message_end'; message: unknown }
export interface PiToolExecutionStartEvent {
    type: 'tool_execution_start';
    toolCallId: string;
    toolName: string;
    args: unknown;
}
export interface PiToolExecutionUpdateEvent {
    type: 'tool_execution_update';
    toolCallId: string;
    toolName: string;
    args: unknown;
    partialResult: unknown;
}
export interface PiToolExecutionEndEvent {
    type: 'tool_execution_end';
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
}

export type PiAgentEvent =
    | PiAgentStartEvent
    | PiAgentEndEvent
    | PiTurnStartEvent
    | PiTurnEndEvent
    | PiMessageStartEvent
    | PiMessageUpdateEvent
    | PiMessageEndEvent
    | PiToolExecutionStartEvent
    | PiToolExecutionUpdateEvent
    | PiToolExecutionEndEvent
    | { type: string }; // fallback for unknown events

// ============================================================================
// Pi RPC Commands (stdin)
// ============================================================================

import type { PiThinkingLevel } from '@hapi/protocol'
export type { PiThinkingLevel }
export { PI_THINKING_LEVELS, PI_THINKING_LEVEL_LABELS } from '@hapi/protocol'

// Image content for native Pi image passing
export interface PiImageContent {
    type: 'image'
    source: {
        type: 'base64'
        media_type: string
        data: string
    }
}

export type PiStreamingBehavior = 'steer' | 'followUp'

export type PiCommandSummary = {
    name: string
    description?: string
    source: 'extension' | 'prompt' | 'skill'
}

export type PiCommandsResponse = {
    success: boolean
    commands?: PiCommandSummary[]
    error?: string
}

export type PiRpcCommand =
    | { type: 'prompt'; message: string; images?: PiImageContent[]; streamingBehavior?: PiStreamingBehavior }
    | { type: 'steer'; message: string; images?: PiImageContent[] }
    | { type: 'follow_up'; message: string; images?: PiImageContent[] }
    | { type: 'abort' }
    | { type: 'new_session' }
    | { type: 'get_state' }
    | { type: 'set_model'; provider: string; modelId: string }
    | { type: 'get_available_models' }
    | { type: 'set_session_name'; name: string }
    | { type: 'set_thinking_level'; level: PiThinkingLevel }
    | { type: 'cycle_thinking_level' }
    | { type: 'get_commands' }
    | { type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'get_messages' }
    | { type: 'compact'; customInstructions?: string }
    | { type: 'set_auto_compaction'; enabled: boolean }
    | { type: 'fork'; entryId: string }
    | { type: 'get_fork_messages' }
    | { type: 'clone' }
    | { type: 'switch_session'; sessionPath: string }
    | { type: 'get_session_stats' }
    | { type: 'export_html'; outputPath?: string };

// ============================================================================
// Pi RPC Responses (stdout)
// ============================================================================

export interface PiResponseEvent {
    type: 'response';
    command: string;
    success: boolean;
    error?: string;
    data?: unknown;
}

// P3: Session stats returned by get_session_stats
export interface PiSessionStats {
    sessionId: string
    userMessages: number
    assistantMessages: number
    toolCalls: number
    totalMessages: number
    tokens: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        total: number
    }
    cost: number
}

// P3: Compaction result returned by compact
export interface PiCompactionResult {
    summary: string
    firstKeptEntryId: string
    tokensBefore: number
}

// P3: Fork message entry returned by get_fork_messages
export interface PiForkMessageEntry {
    entryId: string
    text: string
}
