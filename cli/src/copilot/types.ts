import type { PermissionModeOf, Flavors } from '@hapi/protocol/types';
import type { CopilotAgentMode } from '@hapi/protocol';

export type PermissionMode = PermissionModeOf<typeof Flavors.copilot>;

export interface CopilotMode {
    permissionMode: PermissionMode;
    model?: string;
    effort?: string | null;
    agentMode?: CopilotAgentMode;
}
