/**
 * Permission bridge for PTY-mode claude sessions.
 *
 * The SDK path routes tool approvals through the SDK's `canUseTool` callback
 * (see {@link ../utils/permissionHandler.ts}). A PTY-mode claude has no such
 * callback — it would render permission prompts in its own TUI and stall the
 * chat-driven flow. Instead, a PreToolUse hook forwards each tool call here; we
 * either auto-allow it or surface it in the web approval modal (reusing the
 * exact `state.requests` + `permission` RPC machinery the SDK path uses) and
 * return the resulting allow/deny to claude.
 *
 * We MUST always resolve to `allow` or `deny` — never `ask` — because `ask`
 * makes claude fall back to its own (TUI) prompt, which blocks the PTY.
 */

import type { PermissionMode } from '@hapi/protocol/types';
import {
    BasePermissionHandler,
    resolveToolAutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion,
    type PermissionHandlerClient
} from '@/modules/common/permission/BasePermissionHandler';
import { logger } from '@/ui/logger';
import {
    isAskUserQuestionToolName,
    isRequestUserInputToolName,
    isQuestionToolName,
    buildAskUserQuestionUpdatedInput,
    buildRequestUserInputUpdatedInput
} from './questionAnswerInput';
import { resolveClaudeModePolicy } from './claudePermissionPolicy';

export type PtyPermissionDecision = {
    permissionDecision: 'allow' | 'deny';
    reason?: string;
    updatedInput?: Record<string, unknown>;
};

// The web-driven response delivered over the `permission` RPC. Same shape the
// SDK PermissionHandler consumes, so the existing web approval UI works as-is.
type PermissionResponse = {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: PermissionMode;
    allowTools?: string[];
    // Picked answers for the question tools (AskUserQuestion / request_user_input).
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

// Tools claude itself does not prompt for in default mode: pure read-only
// file/search/state tools. Auto-allow them so PTY default mode isn't flooded
// with an approval prompt for every Read/Grep. Network/exec/write tools still
// go to the web. Question tools (AskUserQuestion / request_user_input) are NOT
// here on purpose — they are routed to the web so the user answers in the chat,
// and the picked answers are injected back via the tool's updatedInput.
const PTY_AUTO_ALLOW_TOOLS = new Set<string>([
    'Read',
    'Glob',
    'Grep',
    'LS',
    'NotebookRead',
    'TodoWrite'
]);

export type PtyPermissionHandlerOptions = {
    /** Reads the session's CURRENT permission mode (web dropdown can change it mid-session). */
    getPermissionMode: () => PermissionMode | undefined;
    /** Propagate a mode change requested via the web approval (e.g. "approve & switch to acceptEdits"). */
    onModeChange?: (mode: PermissionMode) => void;
};

export class PtyPermissionHandler extends BasePermissionHandler<PermissionResponse, PtyPermissionDecision> {
    private readonly options: PtyPermissionHandlerOptions;
    // Tools the user chose to always allow this session ("allow for session").
    private readonly sessionAllowedTools = new Set<string>();
    // Bash "allow for session" arrives command-qualified (Bash(<cmd>) or
    // Bash(<prefix>:*)), so it needs literal/prefix matching rather than a plain
    // tool-name set — mirrors the SDK PermissionHandler.
    private readonly allowedBashLiterals = new Set<string>();
    private readonly allowedBashPrefixes = new Set<string>();

    constructor(client: PermissionHandlerClient, options: PtyPermissionHandlerOptions) {
        super(client);
        this.options = options;
    }

    /**
     * Decide whether a PTY tool call may proceed. Resolves immediately for
     * auto-allowed tools/modes; otherwise registers a pending request that
     * resolves when the user answers in the web modal.
     */
    requestDecision(toolUseId: string, toolName: string, input: unknown): Promise<PtyPermissionDecision> {
        const mode = this.options.getPermissionMode();

        // 1. Already allowed for the session via a prior approval.
        if (toolName === 'Bash') {
            // A name-level "Bash" allow covers every command; otherwise fall back
            // to the per-command literal/prefix allows.
            if (this.sessionAllowedTools.has('Bash')) {
                return Promise.resolve({ permissionDecision: 'allow' });
            }
            const command = (input as { command?: string } | null)?.command;
            if (command && this.isBashCommandAllowed(command)) {
                return Promise.resolve({ permissionDecision: 'allow' });
            }
        } else if (this.sessionAllowedTools.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 2. Pure read-only tools — never gated.
        if (PTY_AUTO_ALLOW_TOOLS.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 3. Shared mode-based policy, kept identical to the SDK canCallTool
        //    path (resolveClaudeModePolicy): question tools (AskUserQuestion /
        //    request_user_input) ALWAYS go to the web — otherwise claude renders
        //    its interactive selector in the PTY only and the question never
        //    reaches the chat; bypassPermissions auto-allows; acceptEdits
        //    auto-allows edit tools. 'fallthrough' defers to the auto-approval
        //    hints (change_title, etc.) below.
        const policy = resolveClaudeModePolicy(mode, toolName);
        if (policy === 'allow') {
            return Promise.resolve({ permissionDecision: 'allow' });
        }
        if (policy === 'fallthrough' && resolveToolAutoApprovalDecision(mode, toolName, toolUseId)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 4. Ask the user via the web approval modal.
        return new Promise<PtyPermissionDecision>((resolve, reject) => {
            this.addPendingRequest(toolUseId, toolName, input, { resolve, reject });
            logger.debug(`[ptyPermission] Awaiting web approval for ${toolName} (${toolUseId})`);
        });
    }

    /** Reject every in-flight request (deny) — call on session teardown/abort. */
    cancelAll(reason: string): void {
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'denied'
        });
    }

    protected async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingPermissionRequest<PtyPermissionDecision>
    ): Promise<PermissionCompletion> {
        // Remember "allow for session" choices so we don't re-prompt. Bash comes
        // command-qualified (Bash(<cmd>) / Bash(<prefix>:*)); other tools by name.
        if (response.allowTools && response.allowTools.length > 0) {
            for (const tool of response.allowTools) {
                if (tool === 'Bash' || tool.startsWith('Bash(')) {
                    this.rememberBashPermission(tool);
                } else {
                    this.sessionAllowedTools.add(tool);
                }
            }
        }

        // A mode switch chosen alongside the approval (e.g. acceptEdits).
        if (response.mode) {
            this.options.onModeChange?.(response.mode);
        }

        const completion: PermissionCompletion = {
            status: response.approved ? 'approved' : 'denied',
            reason: response.reason,
            mode: response.mode,
            allowTools: response.allowTools,
            answers: response.answers
        };

        // Question tools: the user answered in the chat. Inject the picked
        // answers into the tool's updatedInput so claude echoes them instead of
        // re-prompting in its TUI (same trick the SDK canUseTool path uses).
        if (isQuestionToolName(pending.toolName)) {
            const answers = response.answers ?? {};
            const denyNoAnswers = (): PermissionCompletion => {
                completion.status = 'denied';
                completion.reason = completion.reason ?? 'No answers were provided.';
                pending.resolve({ permissionDecision: 'deny', reason: 'No answers were provided.' });
                return completion;
            };
            if (Object.keys(answers).length === 0) {
                return denyNoAnswers();
            }
            const updatedInput = isAskUserQuestionToolName(pending.toolName)
                ? buildAskUserQuestionUpdatedInput(pending.input, answers)
                : isRequestUserInputToolName(pending.toolName)
                    ? buildRequestUserInputUpdatedInput(pending.input, answers)
                    : (pending.input as Record<string, unknown>);
            // Never-stall guard: if the index->questionText mapping produced no
            // usable answers (e.g. malformed/reordered questions), an `allow` with
            // empty answers makes claude echo an empty "answered: ." result and
            // lock the turn. Deny instead so the bridge never silently stalls.
            if (isAskUserQuestionToolName(pending.toolName)) {
                const mapped = (updatedInput as { answers?: unknown }).answers;
                if (!mapped || typeof mapped !== 'object' || Object.keys(mapped as object).length === 0) {
                    return denyNoAnswers();
                }
            }
            pending.resolve({ permissionDecision: 'allow', updatedInput });
            return completion;
        }

        if (response.approved) {
            pending.resolve({
                permissionDecision: 'allow',
                updatedInput: (pending.input as Record<string, unknown>) ?? undefined
            });
        } else {
            pending.resolve({
                permissionDecision: 'deny',
                reason:
                    response.reason ||
                    "The user declined this tool use. The tool was NOT run. Stop and wait for the user to tell you how to proceed."
            });
        }

        return completion;
    }

    protected handleMissingPendingResponse(response: PermissionResponse): void {
        logger.debug(`[ptyPermission] No pending request for response ${response.id} (already resolved?)`);
    }

    private isBashCommandAllowed(command: string): boolean {
        if (this.allowedBashLiterals.has(command)) {
            return true;
        }
        for (const prefix of this.allowedBashPrefixes) {
            if (command.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private rememberBashPermission(permission: string): void {
        // Plain "Bash" would allow every command — treat it as a name-level allow.
        if (permission === 'Bash') {
            this.sessionAllowedTools.add('Bash');
            return;
        }
        const match = permission.match(/^Bash\((.+?)\)$/);
        if (!match) {
            return;
        }
        const command = match[1];
        if (command.endsWith(':*')) {
            this.allowedBashPrefixes.add(command.slice(0, -2));
        } else {
            this.allowedBashLiterals.add(command);
        }
    }
}
