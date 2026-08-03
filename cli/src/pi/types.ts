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

export interface PiContextUsage {
    tokens: number;
    contextWindow?: number;
}

// Individual event types for proper type narrowing
export interface PiAgentStartEvent { type: 'agent_start' }
export interface PiAgentEndEvent { type: 'agent_end'; messages: unknown[]; willRetry?: boolean }
export interface PiAgentSettledEvent { type: 'agent_settled' }
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

export type PiExtensionUiRequest =
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'select';
        title: string;
        options: string[];
        timeout?: number;
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'confirm';
        title: string;
        message: string;
        timeout?: number;
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'input';
        title: string;
        placeholder?: string;
        timeout?: number;
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'editor';
        title: string;
        prefill?: string;
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'notify';
        message: string;
        notifyType?: 'info' | 'warning' | 'error';
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'setStatus';
        statusKey: string;
        statusText?: string;
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'setWidget';
        widgetKey: string;
        widgetLines?: string[];
        widgetPlacement?: 'aboveEditor' | 'belowEditor';
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'setTitle';
        title: string;
    }
    | {
        type: 'extension_ui_request';
        id: string;
        method: 'set_editor_text';
        text: string;
    };

export type PiExtensionUiResponse =
    | { type: 'extension_ui_response'; id: string; value: string }
    | { type: 'extension_ui_response'; id: string; confirmed: boolean }
    | { type: 'extension_ui_response'; id: string; cancelled: true };

export type PiImageContent = {
    type: 'image';
    data: string;
    mimeType: string;
};
export interface PiToolExecutionEndEvent {
    type: 'tool_execution_end';
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
}
export interface PiEntryAppendedEvent {
    type: 'entry_appended';
    entry: unknown;
}

export type PiAgentEvent =
    | PiAgentStartEvent
    | PiAgentEndEvent
    | PiAgentSettledEvent
    | PiTurnStartEvent
    | PiTurnEndEvent
    | PiMessageStartEvent
    | PiMessageUpdateEvent
    | PiMessageEndEvent
    | PiToolExecutionStartEvent
    | PiToolExecutionUpdateEvent
    | PiToolExecutionEndEvent
    | PiExtensionUiRequest
    | PiEntryAppendedEvent
    | { type: string }; // fallback for unknown events

// ============================================================================
// Pi RPC Commands (stdin)
// ============================================================================

import type { PiThinkingLevel } from '@hapi/protocol'
import type { PiCommandSummary } from '@hapi/protocol/apiTypes'
export type { PiThinkingLevel, PiCommandSummary }

export type PiRpcCommand =
    | { id?: string; type: 'prompt'; message: string; images?: PiImageContent[]; streamingBehavior?: 'steer' | 'followUp' }
    | { id?: string; type: 'steer'; message: string; images?: PiImageContent[] }
    | { id?: string; type: 'follow_up'; message: string; images?: PiImageContent[] }
    | { id?: string; type: 'abort' }
    | PiExtensionUiResponse
    | { type: 'new_session' }
    | { type: 'get_state' }
    | { type: 'set_model'; provider: string; modelId: string }
    | { type: 'get_available_models' }
    | { type: 'set_thinking_level'; level: PiThinkingLevel }
    | { type: 'get_commands' }
    | { id?: string; type: 'get_session_stats' }
    | { id?: string; type: 'switch_session'; sessionPath: string }
    | { id?: string; type: 'fork'; entryId: string }
    | { id?: string; type: 'clone' }
    | { id?: string; type: 'get_fork_messages' }
    | { id?: string; type: 'get_entries'; since?: string };

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
