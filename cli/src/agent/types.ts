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

export type AgentMessage =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool_call'; id: string; name: string; input: unknown; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
    | { type: 'tool_result'; id: string; output: unknown; status: 'completed' | 'failed' }
    | { type: 'plan'; items: PlanItem[] }
    | { type: 'turn_complete'; stopReason: string }
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

export interface AgentBackend {
    initialize(): Promise<void>;
    newSession(config: AgentSessionConfig): Promise<string>;
    prompt(sessionId: string, content: PromptContent[], onUpdate: (msg: AgentMessage) => void): Promise<void>;
    cancelPrompt(sessionId: string): Promise<void>;
    respondToPermission(sessionId: string, request: PermissionRequest, response: PermissionResponse): Promise<void>;
    onPermissionRequest(handler: (request: PermissionRequest) => void): void;
    disconnect(): Promise<void>;
}

export type AgentBackendFactory = () => AgentBackend;
