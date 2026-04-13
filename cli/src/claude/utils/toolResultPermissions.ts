import type { ClaudePermissionMode, ExitPlanImplementationMode } from "@hapi/protocol/types";

export type ClaudeToolResultPermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

export type ClaudeToolResultPermissionResponse = {
    approved: boolean;
    receivedAt?: number;
    mode?: ClaudePermissionMode;
    implementationMode?: ExitPlanImplementationMode;
    allowTools?: string[];
    decision?: ClaudeToolResultPermissionDecision;
};

export type ClaudeToolResultPermissions = {
    date: number;
    result: 'approved' | 'denied';
    mode?: ClaudePermissionMode;
    implementationMode?: ExitPlanImplementationMode;
    allowedTools?: string[];
    decision?: ClaudeToolResultPermissionDecision;
};

export function buildClaudeToolResultPermissions(
    response: ClaudeToolResultPermissionResponse
): ClaudeToolResultPermissions {
    const permissions: ClaudeToolResultPermissions = {
        date: response.receivedAt || Date.now(),
        result: response.approved ? 'approved' : 'denied'
    };

    if (response.mode) {
        permissions.mode = response.mode;
    }

    if (response.implementationMode) {
        permissions.implementationMode = response.implementationMode;
    }

    if (response.allowTools && response.allowTools.length > 0) {
        permissions.allowedTools = response.allowTools;
    }

    if (response.decision) {
        permissions.decision = response.decision;
    }

    return permissions;
}
