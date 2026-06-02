export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface InitializeCapabilities {
    experimentalApi: boolean;
}

export interface InitializeParams {
    clientInfo: {
        name: string;
        title?: string;
        version: string;
    };
    capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
    userAgent?: string;
    [key: string]: unknown;
}

export interface ModelListParams {
    includeHidden?: boolean;
}

export interface ModelListItem {
    id: string;
    model?: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    supportedReasoningEfforts?: Array<{
        reasoningEffort?: string;
        description?: string;
    }>;
    defaultReasoningEffort?: string | null;
    isDefault?: boolean;
    [key: string]: unknown;
}

export interface ModelListResponse {
    data?: ModelListItem[];
    nextCursor?: string | null;
    [key: string]: unknown;
}

export interface CollaborationModeListItem {
    name?: string;
    mode?: 'plan' | 'default' | string | null;
    model?: string | null;
    reasoning_effort?: ReasoningEffort | null;
    [key: string]: unknown;
}

export interface CollaborationModeListResponse {
    data?: Array<CollaborationModeListItem | string>;
    modes?: Array<CollaborationModeListItem | string>;
    collaborationModes?: Array<CollaborationModeListItem | string>;
    items?: Array<CollaborationModeListItem | string>;
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
        turns?: ThreadTurn[];
    };
    model: string;
    [key: string]: unknown;
}

export type ResponseItem = Record<string, unknown>;

export type ThreadItem = {
    type?: string;
    id?: string;
    clientId?: string | null;
    client_id?: string | null;
    content?: unknown;
    [key: string]: unknown;
};

export type ThreadTurn = {
    id: string;
    items?: ThreadItem[];
    status?: string;
    startedAt?: number | null;
    started_at?: number | null;
    completedAt?: number | null;
    completed_at?: number | null;
    [key: string]: unknown;
};

export type Thread = {
    id: string;
    sessionId?: string;
    session_id?: string;
    forkedFromId?: string | null;
    forked_from_id?: string | null;
    preview?: string;
    turns?: ThreadTurn[];
    [key: string]: unknown;
};

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
    thread: Thread;
    model: string;
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

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningSummary = 'auto' | 'none' | 'brief' | 'detailed';

export type CollaborationMode = {
    mode: 'plan' | 'default';
    settings: {
        model: string;
        reasoning_effort?: ReasoningEffort | null;
        developer_instructions?: string | null;
    };
};

export interface TurnStartParams {
    threadId: string;
    clientUserMessageId?: string | null;
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

export interface ThreadReadParams {
    threadId: string;
    includeTurns?: boolean;
}

export interface ThreadReadResponse {
    thread: Thread;
    [key: string]: unknown;
}

export interface ThreadForkParams {
    threadId: string;
    model?: string | null;
    modelProvider?: string | null;
    serviceTier?: string | null;
    cwd?: string | null;
    approvalPolicy?: ApprovalPolicy | null;
    sandbox?: SandboxMode | null;
    config?: Record<string, unknown> | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    ephemeral?: boolean;
}

export interface ThreadForkResponse {
    thread: Thread;
    model?: string;
    modelProvider?: string;
    cwd?: string;
    [key: string]: unknown;
}

export interface ThreadRollbackParams {
    threadId: string;
    /**
     * Drops turns from Codex thread history only. This does not revert local files.
     */
    numTurns: number;
}

export interface ThreadRollbackResponse {
    thread: Thread;
    [key: string]: unknown;
}

export interface TurnSteerParams {
    threadId: string;
    clientUserMessageId?: string | null;
    input: UserInput[];
    expectedTurnId: string;
}

export interface TurnSteerResponse {
    turnId: string;
    [key: string]: unknown;
}

export interface ThreadInjectItemsParams {
    threadId: string;
    items: unknown[];
}

export interface ThreadInjectItemsResponse {
    [key: string]: unknown;
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

export interface ThreadCompactStartParams {
    threadId: string;
}

export interface ThreadCompactStartResponse {
    [key: string]: unknown;
}

export type ThreadGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

export interface ThreadGoal {
    threadId: string;
    objective: string;
    status: ThreadGoalStatus;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
}

export interface ThreadGoalSetParams {
    threadId: string;
    objective?: string | null;
    status?: ThreadGoalStatus | null;
    tokenBudget?: number | null;
}

export interface ThreadGoalSetResponse {
    goal: ThreadGoal;
    [key: string]: unknown;
}

export interface ThreadGoalGetParams {
    threadId: string;
}

export interface ThreadGoalGetResponse {
    goal: ThreadGoal | null;
    [key: string]: unknown;
}

export interface ThreadGoalClearParams {
    threadId: string;
}

export interface ThreadGoalClearResponse {
    cleared: boolean;
    [key: string]: unknown;
}

export interface ExperimentalFeatureEnablementSetParams {
    enablement: Record<string, boolean>;
}

export interface ExperimentalFeatureEnablementSetResponse {
    enablement: Record<string, boolean>;
    [key: string]: unknown;
}
