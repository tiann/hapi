import type { AgentState } from "@/api/types";
import type { PermissionMode } from "@hapi/protocol/types";
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

type RpcHandlerManagerLike = {
    registerHandler<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: (params: TRequest) => Promise<TResponse> | TResponse
    ): void;
};

export type AutoApprovalDecision = 'approved' | 'approved_for_session';

export type AutoApprovalRuleSet = {
    alwaysToolNameHints?: string[];
    alwaysToolIdHints?: string[];
    writeToolNameHints?: string[];
};

const AUTO_APPROVE_TOOL_NAME_HINTS = [
    'change_title',
    'happy__change_title',
    'hapi_change_title',  // OpenCode MCP tool pattern
    'geminireasoning',
    'codexreasoning',
    'think',
    'save_memory'
];
const AUTO_APPROVE_EXACT_TOOL_NAMES = new Set([
    'skill_lookup',
    'hapi_skill_lookup',
    'happy__skill_lookup',
    'mcp__hapi__skill_lookup',
    // Discovery shortlist only (id/active/flavor/name) - same as ping-peer --list.
    'list_peers',
    'hapi_list_peers',
    'happy__list_peers',
    'mcp__hapi__list_peers',
    // ACP permission requests often surface MCP tool title, not the snake_case name.
    'list peer sessions'
]);
// ping_peer / inspect_peer intentionally omitted from always-approve: they can
// resume+inject into another session or read peer histories, so permission
// modes must still gate them. Treat both as write-like in read-only so ACP
// titles such as "Ping Peer Session" / "Inspect Peer Session" also require
// approval. list_peers is discovery-only and is auto-approved above.
const AUTO_APPROVE_TOOL_ID_HINTS = ['change_title', 'save_memory'];
const SENSITIVE_TOOL_NAME_HINTS = [
    'ping_peer',
    'ping peer',
    'inspect_peer',
    'inspect peer',
];
const AUTO_APPROVE_WRITE_TOOL_HINTS = [
    'write',
    'edit',
    'create',
    'delete',
    'patch',
    'fs-edit',
    ...SENSITIVE_TOOL_NAME_HINTS
];

export function resolveToolAutoApprovalDecision(
    mode: PermissionMode | undefined,
    toolName: string,
    toolCallId: string,
    ruleOverrides?: AutoApprovalRuleSet
): AutoApprovalDecision | null {
    const rules = {
        alwaysToolNameHints: ruleOverrides?.alwaysToolNameHints ?? AUTO_APPROVE_TOOL_NAME_HINTS,
        alwaysToolIdHints: ruleOverrides?.alwaysToolIdHints ?? AUTO_APPROVE_TOOL_ID_HINTS,
        writeToolNameHints: ruleOverrides?.writeToolNameHints ?? AUTO_APPROVE_WRITE_TOOL_HINTS
    };

    const lowerTool = toolName.toLowerCase();
    const lowerId = toolCallId.toLowerCase();
    const decisionForMode: AutoApprovalDecision = (mode === 'yolo' || mode === 'always-proceed') ? 'approved_for_session' : 'approved';

    if (
        AUTO_APPROVE_EXACT_TOOL_NAMES.has(lowerTool)
        || rules.alwaysToolNameHints.some((name) => lowerTool.includes(name))
    ) {
        return decisionForMode;
    }

    if (rules.alwaysToolIdHints.some((name) => lowerId.includes(name))) {
        return decisionForMode;
    }

    if (mode === 'yolo' || mode === 'always-proceed') {
        return 'approved_for_session';
    }

    if (mode === 'safe-yolo') {
        return 'approved';
    }

    if (mode === 'read-only') {
        const isWriteTool = rules.writeToolNameHints.some((name) => lowerTool.includes(name));
        return isWriteTool ? null : 'approved';
    }

    return null;
}

export type PermissionHandlerClient = {
    rpcHandlerManager: RpcHandlerManagerLike;
    updateAgentState: (handler: (state: AgentState) => AgentState) => void;
};

export type PendingPermissionRequest<TResult> = {
    resolve: (value: TResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
};

export type PermissionCompletion = {
    status: 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    allowTools?: string[];
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

export type CancelPendingRequestOptions = {
    completedReason: string;
    rejectMessage: string;
    decision?: PermissionCompletion['decision'];
    /**
     * When set, only pending requests whose toolName satisfies the predicate
     * are canceled; every other pending request (and its agentState entry) is
     * left untouched. Omitting it cancels everything — the original,
     * unscoped behavior every existing caller (session-teardown cancelAll)
     * relies on.
     */
    filter?: (toolName: string) => boolean;
};

export abstract class BasePermissionHandler<TResponse extends { id: string }, TResult> {
    protected readonly pendingRequests = new Map<string, PendingPermissionRequest<TResult>>();
    protected readonly client: PermissionHandlerClient;

    protected constructor(client: PermissionHandlerClient) {
        this.client = client;
        this.setupRpcHandler();
    }

    protected abstract handlePermissionResponse(
        response: TResponse,
        pending: PendingPermissionRequest<TResult>
    ): Promise<PermissionCompletion>;

    protected abstract handleMissingPendingResponse(response: TResponse): void;

    protected onRequestRegistered(_id: string, _toolName: string, _input: unknown): void {
    }

    protected onResponseReceived(_response: TResponse): void {
    }

    protected resolveAutoApprovalDecision(
        mode: PermissionMode | undefined,
        toolName: string,
        toolCallId: string,
        ruleOverrides?: AutoApprovalRuleSet
    ): AutoApprovalDecision | null {
        return resolveToolAutoApprovalDecision(mode, toolName, toolCallId, ruleOverrides);
    }

    protected addPendingRequest(
        id: string,
        toolName: string,
        input: unknown,
        handlers: { resolve: (value: TResult) => void; reject: (error: Error) => void }
    ): void {
        this.pendingRequests.set(id, { ...handlers, toolName, input });
        this.onRequestRegistered(id, toolName, input);
        this.client.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now()
                }
            }
        }));
    }

    protected finalizeRequest(id: string, completion: PermissionCompletion): void {
        this.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;

            const nextRequests = { ...currentState.requests };
            delete nextRequests[id];

            return {
                ...currentState,
                requests: nextRequests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: completion.status,
                        reason: completion.reason,
                        mode: completion.mode,
                        decision: completion.decision,
                        allowTools: completion.allowTools,
                        answers: completion.answers
                    }
                }
            };
        });
    }

    protected cancelPendingRequests(options: CancelPendingRequestOptions): void {
        const { filter } = options;

        for (const [id, pending] of this.pendingRequests.entries()) {
            if (filter && !filter(pending.toolName)) continue;
            pending.reject(new Error(options.rejectMessage));
            this.pendingRequests.delete(id);
        }

        this.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };
            const nextRequests: typeof pendingRequests = {};

            for (const [id, request] of Object.entries(pendingRequests)) {
                if (filter && !filter(request.tool)) {
                    nextRequests[id] = request;
                    continue;
                }
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: options.completedReason,
                    decision: options.decision
                };
            }

            return {
                ...currentState,
                requests: nextRequests,
                completedRequests
            };
        });
    }

    private setupRpcHandler(): void {
        this.client.rpcHandlerManager.registerHandler<TResponse, void>(RPC_METHODS.Permission, async (response) => {
            const pending = this.pendingRequests.get(response.id);

            if (!pending) {
                this.handleMissingPendingResponse(response);
                return;
            }

            this.onResponseReceived(response);
            this.pendingRequests.delete(response.id);

            const completion = await this.handlePermissionResponse(response, pending);
            this.finalizeRequest(response.id, completion);
        });
    }
}
