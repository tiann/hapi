export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface InitializeParams {
    clientInfo: {
        name: string;
        title?: string;
        version: string;
    };
}

export interface InitializeResponse {
    userAgent?: string;
    [key: string]: unknown;
}

export interface ThreadStartParams {
    model?: string;
    modelProvider?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    config?: Record<string, unknown>;
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: string;
    ephemeral?: boolean;
    experimentalRawEvents?: boolean;
}

export interface ThreadStartResponse {
    thread: {
        id: string;
    };
    [key: string]: unknown;
}

export type ResponseItem = Record<string, unknown>;

export interface ThreadResumeParams {
    threadId: string;
    history?: ResponseItem[];
    path?: string;
    model?: string;
    modelProvider?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    config?: Record<string, unknown>;
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: string;
}

export interface ThreadResumeResponse {
    thread: {
        id: string;
    };
    [key: string]: unknown;
}

export type UserInput =
    | {
        type: 'text';
        text: string;
        textElements?: Array<{
            byteRange: { start: number; end: number };
            placeholder?: string;
        }>;
    }
    | {
        type: 'image';
        url: string;
    }
    | {
        type: 'localImage';
        path: string;
    }
    | {
        type: 'skill';
        name: string;
        path: string;
    };

export type SandboxPolicy =
    | { type: 'dangerFullAccess' }
    | { type: 'readOnly' }
    | { type: 'externalSandbox'; networkAccess?: 'restricted' | 'enabled' }
    | {
        type: 'workspaceWrite';
        writableRoots?: string[];
        networkAccess?: boolean;
        excludeTmpdirEnvVar?: boolean;
        excludeSlashTmp?: boolean;
    };

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'auto';
export type ReasoningSummary = 'auto' | 'none' | 'brief' | 'detailed';

export type CollaborationMode = {
    mode: 'plan' | 'default';
    settings: {
        model: string;
        reasoning_effort: string | null;
        developer_instructions: string | null;
    };
};

export interface TurnStartParams {
    threadId: string;
    input: UserInput[];
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxPolicy?: SandboxPolicy;
    model?: string;
    effort?: ReasoningEffort;
    summary?: ReasoningSummary;
    personality?: string;
    outputSchema?: unknown;
    collaborationMode?: CollaborationMode;
}

export interface TurnStartResponse {
    turn: {
        id: string;
        status?: string;
    };
    [key: string]: unknown;
}

export interface TurnInterruptParams {
    threadId: string;
    turnId: string;
}

export interface TurnInterruptResponse {
    ok: boolean;
    [key: string]: unknown;
}
