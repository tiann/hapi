export type ApprovalPolicyPreset = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export type ApprovalPolicy =
    | ApprovalPolicyPreset
    | {
        granular: {
            sandbox_approval: boolean;
            rules: boolean;
            skill_approval?: boolean;
            request_permissions?: boolean;
            mcp_elicitations: boolean;
        };
    };
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
    serviceTiers?: Array<{
        id?: string;
        name?: string;
        description?: string;
    }>;
    defaultServiceTier?: string | null;
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
    /**
     * Service tier override (e.g. 'fast'). `null` selects the standard tier
     * explicitly; omit to inherit the account/thread default.
     */
    serviceTier?: string | null;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    config?: Record<string, unknown>;
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: string;
    /** Client-supplied analytics classification persisted with the thread. */
    threadSource?: string;
    ephemeral?: boolean;
    experimentalRawEvents?: boolean;
}

export interface ThreadStartResponse {
    thread: {
        id: string;
    };
    model: string;
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
        turns?: Array<{ items?: ResponseItem[] }>;
    };
    model: string;
    [key: string]: unknown;
}

export interface ThreadForkParams extends Omit<ThreadResumeParams, 'history' | 'path'> {
}

export interface ThreadForkResponse {
    thread: {
        id: string;
        turns?: Array<{ items?: ResponseItem[] }>;
    };
    model?: string;
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

// The app server reports supported effort identifiers per model. Keep this
// open so newly introduced server values can flow through without a CLI update.
export type ReasoningEffort = string;
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
    input: UserInput[];
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxPolicy?: SandboxPolicy;
    model?: string;
    /**
     * Service tier override for this turn and subsequent turns (e.g. 'fast').
     * `null` selects the standard tier explicitly; omit to leave it unchanged.
     */
    serviceTier?: string | null;
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

export interface ThreadRollbackParams {
    threadId: string;
    numTurns: number;
}

export interface ThreadRollbackResponse {
    thread: {
        id: string;
        [key: string]: unknown;
    };
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
