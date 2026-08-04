import type { CopilotPermissionMode } from '@hapi/protocol/types';
import type { CopilotAgentMode } from '@hapi/protocol';

export type PermissionMode = CopilotPermissionMode;

export interface CopilotMode {
    permissionMode: PermissionMode;
    model?: string;
    agentMode?: CopilotAgentMode;
}
