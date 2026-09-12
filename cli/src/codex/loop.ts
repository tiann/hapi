// Mode data retained for protocol/config helpers. Codex execution is shared/runtime.ts.
import type { ReasoningEffort } from './appServerTypes';
import type { CodexCollaborationMode, CodexPermissionMode } from '@hapi/protocol/types';

export type PermissionMode = CodexPermissionMode;

/** Codex response style. Omit from mode to inherit config.toml / thread default. */
export type CodexPersonality = 'friendly' | 'pragmatic' | 'none';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    collaborationMode: CodexCollaborationMode;
    proactiveMultiAgent?: boolean;
    modelReasoningEffort?: ReasoningEffort;
    /**
     * Service tier override. `undefined` leaves it untouched (account default),
     * `'fast'` enables Fast mode, `null` selects the standard tier explicitly.
     */
    serviceTier?: string | null;
    /** When set, forwarded to app-server thread/turn params. */
    personality?: CodexPersonality;
}
