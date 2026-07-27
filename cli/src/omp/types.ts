/**
 * OMP (Oh My Pi) RPC protocol type definitions.
 *
 * OMP shares the same JSONL-over-stdio RPC protocol family as Pi
 * (both build on @oh-my-pi/pi-agent-core + @oh-my-pi/pi-ai), so the
 * AgentEvent / AssistantMessageEvent shapes are identical. OMP is a
 * superset of Pi's commands (follow_up, compact, branch, bash, handoff,
 * steering/interrupt mode switches, etc.) and pushes slash commands via
 * `available_commands_update` instead of requiring `get_commands`.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 * Based on OMP's dist/types/modes/rpc/rpc-types.d.ts and pi-agent-core types.
 */

// ============================================================================
// OMP Agent Events (stdout) — same shape as Pi (shared pi-agent-core)
// ============================================================================

export interface OmpTextDeltaEvent {
    type: 'text_delta';
    delta: string;
}

export interface OmpThinkingDeltaEvent {
    type: 'thinking_delta';
    delta: string;
}

export type OmpAssistantMessageEvent =
    | OmpTextDeltaEvent
    | OmpThinkingDeltaEvent
    | { type: 'start' }
    | { type: 'done'; reason: string }
    | { type: 'error'; reason: string; error: unknown }
    // Catch-all for text_start, text_end, thinking_start, thinking_end, toolcall_* etc.
    | { type: string; [key: string]: unknown };

export interface OmpUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
}

// Individual event types for proper type narrowing
export interface OmpAgentStartEvent { type: 'agent_start' }
export interface OmpAgentEndEvent { type: 'agent_end'; messages: unknown[] }
export interface OmpTurnStartEvent { type: 'turn_start' }
export interface OmpTurnEndEvent {
    type: 'turn_end';
    message?: { usage?: OmpUsage; stopReason?: string };
    toolResults?: unknown[];
}
export interface OmpMessageStartEvent { type: 'message_start'; message: unknown }
export interface OmpMessageUpdateEvent {
    type: 'message_update';
    assistantMessageEvent?: OmpAssistantMessageEvent;
    message?: unknown;
}
export interface OmpMessageEndEvent { type: 'message_end'; message: unknown }
export interface OmpToolExecutionStartEvent {
    type: 'tool_execution_start';
    toolCallId: string;
    toolName: string;
    args: unknown;
}
export interface OmpToolExecutionUpdateEvent {
    type: 'tool_execution_update';
    toolCallId: string;
    toolName: string;
    args: unknown;
    partialResult: unknown;
}
export interface OmpToolExecutionEndEvent {
    type: 'tool_execution_end';
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
}

// --- OMP-only events (superset of Pi). Carried as opaque payloads; the
// loop maps the load-bearing ones (goal_updated, auto_compaction_*) onto
// hapi's existing generic web events. Others pass through via catch-all. ---
export interface OmpGoalUpdatedEvent {
    type: 'goal_updated';
    goal: {
        id: string;
        objective: string;
        status: 'active' | 'paused' | 'budget-limited' | 'complete' | 'dropped';
        tokenBudget?: number;
        tokensUsed?: number;
        timeUsedSeconds?: number;
        createdAt?: number;
        updatedAt?: number;
    } | null;
    state?: { enabled?: boolean; mode?: string; reason?: string };
}
export interface OmpAutoCompactionStartEvent {
    type: 'auto_compaction_start';
    reason: 'threshold' | 'overflow' | 'idle' | 'incomplete';
    action: 'context-full' | 'handoff' | 'shake' | 'snapcompact';
}
export interface OmpAutoCompactionEndEvent {
    type: 'auto_compaction_end';
    action: 'context-full' | 'handoff' | 'shake' | 'snapcompact';
    result?: unknown;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
    skipped?: boolean;
}
export interface OmpThinkingLevelChangedEvent {
    type: 'thinking_level_changed';
    thinkingLevel?: string;
    configured?: string;
    resolved?: string;
}
export interface OmpAvailableCommandsUpdateEvent {
    type: 'available_commands_update';
    commands: Array<{
        name: string;
        aliases?: string[];
        description?: string;
        source: 'builtin' | 'extension' | 'skill' | 'prompt' | 'custom' | 'mcp_prompt' | 'file';
    }>;
}
export interface OmpReadyEvent { type: 'ready' }

export interface OmpSubagentLifecycleEvent {
    type: 'subagent_lifecycle';
    payload: {
        id: string;
        agent: string;
        agentSource?: string;
        description?: string;
        status: 'started' | 'completed' | 'failed' | 'aborted';
        sessionFile?: string;
        parentToolCallId?: string;
        index: number;
        detached?: boolean;
    };
}

export interface OmpSubagentProgressEvent {
    type: 'subagent_progress';
    payload: {
        index: number;
        agent: string;
        agentSource?: string;
        task: string;
        parentToolCallId?: string;
        assignment?: string;
        sessionFile?: string;
        detached?: boolean;
        progress: {
            id: string;
            status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
            description?: string;
            lastIntent?: string;
            currentTool?: string;
            currentToolArgs?: string;
            toolCount: number;
            requests: number;
            tokens: number;
            durationMs: number;
            resolvedModel?: string;
            retryState?: {
                attempt: number;
                maxAttempts: number;
                delayMs: number;
                errorMessage?: string;
            };
            retryFailure?: {
                attempt: number;
                errorMessage?: string;
            };
        };
    };
}

export type OmpAgentEvent =
    | OmpAgentStartEvent
    | OmpAgentEndEvent
    | OmpTurnStartEvent
    | OmpTurnEndEvent
    | OmpMessageStartEvent
    | OmpMessageUpdateEvent
    | OmpMessageEndEvent
    | OmpToolExecutionStartEvent
    | OmpToolExecutionUpdateEvent
    | OmpToolExecutionEndEvent
    | OmpGoalUpdatedEvent
    | OmpAutoCompactionStartEvent
    | OmpAutoCompactionEndEvent
    | OmpThinkingLevelChangedEvent
    | OmpAvailableCommandsUpdateEvent
    | OmpReadyEvent
    | OmpSubagentLifecycleEvent
    | OmpSubagentProgressEvent
    | { type: string }; // fallback for unknown events (todo_reminder, notice, auto_retry_*, ttsr_triggered, ...)

// ============================================================================
// OMP RPC Commands (stdin) — superset of Pi
// ============================================================================

import type { PiThinkingLevel } from '@hapi/protocol'
import type { OmpCommandSummary } from '@hapi/protocol/apiTypes'
export type { PiThinkingLevel, OmpCommandSummary }

export type OmpRpcCommand =
    // Core messaging (same as Pi + follow_up)
    | { type: 'prompt'; message: string }
    | { type: 'steer'; message: string }
    | { type: 'follow_up'; message: string }
    | { type: 'abort' }
    | { type: 'abort_and_prompt'; message: string }
    // Session lifecycle
    | { type: 'new_session'; parentSession?: string }
    | { type: 'get_state' }
    | { type: 'switch_session'; sessionPath: string }
    | { type: 'branch'; entryId: string }
    | { type: 'get_branch_messages' }
    | { type: 'handoff'; customInstructions?: string }
    // Model + thinking
    | { type: 'set_model'; provider: string; modelId: string }
    | { type: 'cycle_model' }
    | { type: 'get_available_models' }
    | { type: 'set_thinking_level'; level: PiThinkingLevel }
    | { type: 'cycle_thinking_level' }
    // Steering / interrupt / follow-up modes
    | { type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'set_interrupt_mode'; mode: 'immediate' | 'wait' }
    // Compaction
    | { type: 'compact'; customInstructions?: string }
    | { type: 'set_auto_compaction'; enabled: boolean }
    // Auto-retry
    | { type: 'set_auto_retry'; enabled: boolean }
    | { type: 'abort_retry' }
    // Bash
    | { type: 'bash'; command: string }
    | { type: 'abort_bash' }
    // Introspection
    | { type: 'get_session_stats' }
    | { type: 'get_messages' }
    | { type: 'get_last_assistant_text' }
    | { type: 'get_available_commands' }
    | { type: 'set_subagent_subscription'; level: 'off' | 'progress' | 'events' };

// ============================================================================
// OMP RPC Responses (stdout) — same shape as Pi (id-correlated)
// ============================================================================

export interface OmpResponseEvent {
    type: 'response';
    command: string;
    success: boolean;
    error?: string;
    data?: unknown;
    // RPC correlation id (sent by OmpRpcResolver as string)
    id?: string;
}
