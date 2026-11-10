import type { AgentFlavor } from '@hapi/protocol';
import type { InlineMediaSource } from '@/modules/common/inlineMediaSource';

export type McpEnvVar = {
    name: string;
    value: string;
};

export type McpServerStdio = {
    name: string;
    command: string;
    args: string[];
    env: McpEnvVar[];
};

export type AgentSessionConfig = {
    cwd: string;
    mcpServers: McpServerStdio[];
};

export type PromptContent = {
    type: 'text';
    text: string;
};

export type PlanItem = {
    content: string;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
};

export type AgentRoundModelUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
};

export type AgentRoundSummary = {
    usage: AgentRoundModelUsage;
    modelUsage: Record<string, AgentRoundModelUsage>;
    totalCostUsd?: number;
    numTurns: number;
    durationMs: number;
    /** Assistant output + reasoning and provider-active time, excluding tools/compaction. */
    generationMs?: number;
    generationOutputTokens?: number;
};

export type AgentMessage =
    | { type: 'text'; text: string; id?: string; live?: boolean; streamSnapshot?: boolean }
    | { type: 'reasoning'; text: string; id?: string; live?: boolean }
    | {
        type: 'tool_call';
        id: string;
        name: string;
        input: unknown;
        status: 'pending' | 'in_progress' | 'completed' | 'failed';
        title?: string;
        kind?: string;
        progress?: unknown;
        // The agent's own tool name and args, when it sends them next to the
        // standard fields (agy does: `name`, `args`).
        nativeName?: string;
        nativeArgs?: unknown;
    }
    | { type: 'tool_result'; id: string; output: unknown; status: 'completed' | 'failed' }
    | {
        type: 'usage';
        inputTokens: number;
        outputTokens: number;
        totalTokens?: number;
        thoughtTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        contextTokens?: number;
        contextWindow?: number;
    }
    | { type: 'plan'; items: PlanItem[] }
    | { type: 'generated_image'; imageId: string; fileName: string; mimeType: string; source?: InlineMediaSource }
    | { type: 'turn_complete'; stopReason: string }
    | { type: 'round_summary'; summary: AgentRoundSummary }
    | { type: 'error'; message: string };

export type PermissionOption = {
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
};

export type PermissionRequest = {
    id: string;
    sessionId: string;
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
    options: PermissionOption[];
};

export type PermissionResponse =
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };

/** Agent-initiated `elicitation/create` in form mode (structured user input). */
export type FormElicitationRequest = {
    sessionId: string;
    /** Tool call that triggered the form, when the agent links one. */
    toolCallId?: string;
    message: string;
    /** JSON-Schema-like object schema; shape is owned by the agent. */
    requestedSchema: unknown;
};

export type FormElicitationContent = Record<string, string | number | boolean | string[]>;

/**
 * `decline` is the user refusing to answer; `cancel` covers every other
 * non-answer: dismissed, aborted, or unavailable. Agents may record the two
 * differently.
 */
export type FormElicitationResponse =
    | { action: 'accept'; content: FormElicitationContent }
    | { action: 'decline' }
    | { action: 'cancel' };

export type AgentSessionModelDescriptor = {
    modelId: string;
    name?: string;
    reasoningEfforts?: Array<{ value: string; name?: string; isDefault?: boolean }>;
};

export type AgentSessionModelsMetadata = {
    availableModels: AgentSessionModelDescriptor[];
    currentModelId: string | null;
};

export type AgentSessionConfigOptionDescriptor = {
    id: string;
    category?: string;
    currentValue?: string;
    options: Array<{ value: string; name?: string }>;
};

export interface AgentBackend {
    initialize(): Promise<void>;
    newSession(config: AgentSessionConfig): Promise<string>;
    setModel?(sessionId: string, modelId: string, opts?: { flavor?: AgentFlavor }): Promise<void>;
    setConfigOption?(sessionId: string, configId: string, value: string): Promise<void>;
    getSessionModelsMetadata?(sessionId: string): AgentSessionModelsMetadata | undefined;
    getThoughtLevelConfigOption?(sessionId: string): AgentSessionConfigOptionDescriptor | undefined;
    prompt(sessionId: string, content: PromptContent[], onUpdate: (msg: AgentMessage) => void): Promise<void>;
    cancelPrompt(sessionId: string): Promise<void>;
    respondToPermission(sessionId: string, request: PermissionRequest, response: PermissionResponse): Promise<void>;
    onPermissionRequest(handler: (request: PermissionRequest) => void): void;
    /**
     * Register the handler for agent form elicitations. The returned promise
     * stays pending until the user answers; backends settle it with `cancel`
     * on abort and disconnect.
     */
    onFormElicitation?(handler: (request: FormElicitationRequest) => Promise<FormElicitationResponse>): void;
    disconnect(): Promise<void>;
}

export type AgentBackendFactory = () => AgentBackend;
