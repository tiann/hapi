/**
 * Permission bridge for PTY-mode agy (Antigravity CLI) sessions.
 *
 * Adapts AGY hook permission requests to HAPI's shared permission RPC.
 * agy uses a PreToolUse hook (camelCase schema) instead of the claude SDK
 * canUseTool callback. We auto-allow read-only tools and route everything
 * else to the web approval modal — reusing the same `state.requests` +
 * shared `permission` RPC machinery.
 *
 * agy session-allow is surfaced via permissionOverrides in the hook response
 * (agy native) rather than claude's allowTools array. We translate between
 * the two internally.
 *
 * Decisions are always allow/deny — never ask/force_ask, which would make
 * agy fall back to its TUI prompt and stall the PTY.
 *
 * Questions take a different route. agy's PreToolUse stdout spec has no
 * updatedInput field, and agy blocks on its own TUI selector rather than
 * invoking the model, so an answer cannot be returned through the hook.
 * registerQuestionRequest() therefore registers an ask_question call as a
 * pending request directly — bypassing requestDecision, so no permission mode
 * can resolve a question without the user — and the launcher injects the
 * answer as keystrokes into that selector.
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

export type AgyPermissionDecision = {
    permissionDecision: 'allow' | 'deny';
    reason?: string;
    permissionOverrides?: string[];
    /**
     * Present only for the synthetic `ask_user_question` pending requests
     * registered via {@link AgyPermissionHandler.registerQuestionRequest} —
     * never for a real hook-driven tool decision. `null` when the request
     * was denied/canceled with no answers to inject.
     */
    answers?: Record<string, string[]> | null;
};

/** Canonical tool name under which agy's native ask_question is registered as
 * a pending request (see registerQuestionRequest) — matches the shared
 * `ask_user_question` id the web's AskUserQuestionView/Footer already
 * recognize (claude/cursor use the same canonical name), so agy's question
 * reuses that UI with no web changes. */
export const AGY_QUESTION_TOOL_NAME = 'ask_user_question';

function normalizeQuestionAnswers(
    answers: Record<string, string[]> | Record<string, { answers: string[] }> | undefined
): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    if (!answers) return result;
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            result[key] = value;
        } else if (value && typeof value === 'object' && Array.isArray((value as { answers?: unknown }).answers)) {
            result[key] = (value as { answers: string[] }).answers;
        }
    }
    return result;
}

// The web-driven response delivered over the `permission` RPC. Same shape as
// the shared PTY path (the web UI is shared).
type PermissionResponse = {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: PermissionMode;
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    // Picked answers for a pending ask_user_question request (see
    // registerQuestionRequest) — same wire shape the web's
    // AskUserQuestionFooter already sends for claude/cursor questions.
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

// agy read-only tools — auto-allow so PTY default mode isn't flooded with
// approval prompts for every file read / search / web lookup.
// Source: [agy hooks topic](knowledge/topics/2026-06-13_agy-antigravity-cli-hooks.md)
const AGY_AUTO_ALLOW_TOOLS = new Set<string>([
    'view_file',
    'list_dir',
    'find_by_name',
    'grep_search',
    'read_url_content',
    'search_web',
    'list_permissions'
]);

export type AgyPermissionHandlerOptions = {
    /** Reads the session's current permission mode. */
    getPermissionMode: () => PermissionMode | undefined;
    /** Propagate a mode change chosen via the web approval. */
    onModeChange?: (mode: PermissionMode) => void;
};

export class AgyPermissionHandler extends BasePermissionHandler<PermissionResponse, AgyPermissionDecision> {
    private readonly options: AgyPermissionHandlerOptions;
    // Tools the user chose to always allow this session.
    private readonly sessionAllowedTools = new Set<string>();
    // agy command-qualified session allows: command(<cmd>) strings.
    private readonly allowedCommandLiterals = new Set<string>();
    private readonly allowedCommandPrefixes = new Set<string>();

    constructor(client: PermissionHandlerClient, options: AgyPermissionHandlerOptions) {
        super(client);
        this.options = options;
    }

    /**
     * Decide whether an agy tool call may proceed. Resolves immediately for
     * auto-allowed tools/modes; otherwise registers a pending request that
     * resolves when the user answers in the web modal.
     *
     * toolUseId for agy is derived from conversationId+stepIdx (no SDK-style
     * tool_use_id) — callers must pass a stable composite ID.
     */
    requestDecision(toolUseId: string, toolName: string, input: unknown): Promise<AgyPermissionDecision> {
        const mode = this.options.getPermissionMode();

        // 1. Already allowed for the session via a prior approval.
        if (toolName === 'run_command') {
            const command = (input as { CommandLine?: string } | null)?.CommandLine ?? '';
            if (command && this.isCommandAllowed(command)) {
                return Promise.resolve({ permissionDecision: 'allow' });
            }
        } else if (this.sessionAllowedTools.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 2. Pure read-only tools — never gated.
        if (AGY_AUTO_ALLOW_TOOLS.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 3. Mode-based auto-approval. agy's only auto-allow mode is 'always-proceed',
        // which resolveToolAutoApprovalDecision maps to 'approved_for_session'.
        // (No 'bypassPermissions' branch — that is a claude mode and never a
        // valid AgyPermissionMode.)
        if (resolveToolAutoApprovalDecision(mode, toolName, toolUseId)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 4. Ask the user via the web approval modal.
        return new Promise<AgyPermissionDecision>((resolve, reject) => {
            this.addPendingRequest(toolUseId, toolName, input, { resolve, reject });
            logger.debug(`[agyPermission] Awaiting web approval for ${toolName} (${toolUseId})`);
        });
    }

    /**
     * Register agy's native `ask_question` as a pending request so it renders
     * in the web chat via the SAME agentState.requests/`permission` RPC
     * machinery as every other tool approval — reusing AskUserQuestionView/
     * Footer with zero web changes (see AGY_QUESTION_TOOL_NAME).
     *
     * Unlike requestDecision(), this is never invoked from a PreToolUse hook
     * callback — agy never hooks ask_question (it is a pure TUI interaction
     * with no side effect to gate). agyPtyLauncher calls this directly upon
     * seeing the tool_call in the transcript, and awaits the returned promise
     * to build the PTY key sequence that answers the live TUI selector.
     *
     * Resolves with the normalized answers (`Record<questionIndex, string[]>`)
     * on approval, or `null` if the request was denied/canceled with no
     * answers to inject (e.g. session teardown mid-question).
     */
    registerQuestionRequest(
        toolUseId: string,
        canonicalInput: { questions: unknown }
    ): Promise<Record<string, string[]> | null> {
        return new Promise<Record<string, string[]> | null>((resolve, reject) => {
            this.addPendingRequest(toolUseId, AGY_QUESTION_TOOL_NAME, canonicalInput, {
                resolve: (decision) => resolve(decision.answers ?? null),
                reject
            });
        });
    }

    /** Reject every in-flight request — call on session teardown. */
    cancelAll(reason: string): void {
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'denied'
        });
    }

    /**
     * Reject only pending `ask_user_question` requests (see
     * registerQuestionRequest), leaving unrelated pending tool-approval
     * requests untouched.
     *
     * The TUI selector a question answers into can go stale WITHOUT a full
     * session teardown: agy's PTY can crash/respawn mid-question
     * (runRespawnLoop), or the current turn can be aborted (Ctrl-C
     * interrupt) while a question is pending. In both cases Phase 0 measured
     * that the selector state is NOT recoverable (a respawn/resume lands on
     * a plain idle prompt, and an abort kills the in-flight turn), so a
     * stale answer arriving afterward must never be injected as keystrokes —
     * it would type into an idle prompt (submitting arbitrary text as a
     * brand-new turn) or leak into whatever comes next. Calling this at
     * those two points (agyPtyLauncher's PTY onExit and its abort handler)
     * rejects the pending promise so agyPtyLauncher's `.then()` never fires
     * and `ptyControls.sendKeys` is never called with a stale sequence, and
     * it resolves the web's question card instead of leaving it pending
     * forever. Unrelated pending tool-approval requests (regular
     * requestDecision() calls) are NOT canceled — the agy process may still
     * be legitimately blocked on those.
     */
    cancelPendingQuestions(reason: string): void {
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'denied',
            filter: (toolName) => toolName === AGY_QUESTION_TOOL_NAME
        });
    }

    protected async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingPermissionRequest<AgyPermissionDecision>
    ): Promise<PermissionCompletion> {
        // ask_user_question (agy's native ask_question, registered via
        // registerQuestionRequest — never a real hook-driven tool decision):
        // short-circuit before any of the run_command/write_to_file
        // session-allow bookkeeping below, which doesn't apply here. Resolve
        // with the normalized answers (or null on deny/no-answers) so the
        // caller (agyPtyLauncher) can build the PTY key sequence.
        if (pending.toolName === AGY_QUESTION_TOOL_NAME) {
            const answers = response.approved ? normalizeQuestionAnswers(response.answers) : null;
            pending.resolve({
                permissionDecision: response.approved ? 'allow' : 'deny',
                reason: response.reason,
                answers
            });
            return {
                status: response.approved ? 'approved' : 'denied',
                reason: response.reason,
                answers: response.approved ? normalizeQuestionAnswers(response.answers) : undefined
            };
        }

        // Remember "allow for session" choices.
        // agy uses command(<cmd>) qualifiers for run_command session-allows
        // (matching the permissionOverrides format we emit).
        //
        // M2 fix: bare `run_command` in allowTools is NOT added to
        // sessionAllowedTools (which requestDecision never checks for
        // run_command). Instead we register the pending CommandLine in
        // allowedCommandLiterals — consistent with what buildPermissionOverrides
        // emits as command(<CommandLine>) and with what isCommandAllowed checks.
        const pendingInput = pending.input as { CommandLine?: string } | null;
        const allowTools = response.allowTools ?? (
            response.approved && response.decision === 'approved_for_session'
                ? [pending.toolName]
                : undefined
        );
        // n1 guard: only an approved response may populate the session-allow
        // caches. A deny must never grant a future allow. Today the hub only
        // sends allowTools on approval, but that is a convention — enforce the
        // invariant here so a malformed/denied response carrying allowTools
        // can never escalate into a cached allow.
        if (response.approved && allowTools && allowTools.length > 0) {
            for (const tool of allowTools) {
                if (tool === 'run_command') {
                    // Scope to the specific command being approved — mirrors the
                    // command(<CommandLine>) override we emit to agy.
                    const cmd = pendingInput?.CommandLine;
                    if (cmd) {
                        this.allowedCommandLiterals.add(cmd);
                    }
                } else if (tool.startsWith('command(')) {
                    this.rememberCommandPermission(tool);
                } else {
                    this.sessionAllowedTools.add(tool);
                }
            }
        }

        if (response.mode) {
            this.options.onModeChange?.(response.mode);
        }

        const completion: PermissionCompletion = {
            status: response.approved ? 'approved' : 'denied',
            reason: response.reason,
            mode: response.mode,
            allowTools
        };

        // Build agy permissionOverrides for session-allows (agy native format).
        // The pending tool input provides the CommandLine context needed to
        // scope bare run_command session-allows to the specific command.
        const permissionOverrides = this.buildPermissionOverrides(allowTools, pendingInput?.CommandLine);

        if (response.approved) {
            pending.resolve({
                permissionDecision: 'allow',
                permissionOverrides: permissionOverrides.length > 0 ? permissionOverrides : undefined
            });
        } else {
            pending.resolve({
                permissionDecision: 'deny',
                reason:
                    response.reason ||
                    'The user declined this tool use. The tool was NOT run. Stop and wait for the user to tell you how to proceed.'
            });
        }

        return completion;
    }

    protected handleMissingPendingResponse(response: PermissionResponse): void {
        logger.debug(`[agyPermission] No pending request for response ${response.id} (already resolved?)`);
    }

    /**
     * Build agy permissionOverrides strings from a web allowTools array.
     *
     * Security invariant: bare `run_command` in allowTools (from the web when
     * the tool name is shown without a specific command, e.g. PermissionFooter
     * `toolName === 'Bash'` path) must NOT map to `command(*)` — that would
     * escalate a single-command approval into a session-wide command allow.
     * Instead we emit `command(<commandLine>)` scoped to the specific command
     * that is currently pending. Only explicit `command(<x>)` entries (already
     * scoped) are passed through as-is.
     *
     * @param allowTools - The allowTools array from the web permission response.
     * @param pendingCommandLine - The CommandLine from the pending run_command
     *   input, used to scope bare `run_command` session-allows.
     */
    private buildPermissionOverrides(allowTools?: string[], pendingCommandLine?: string): string[] {
        if (!allowTools || allowTools.length === 0) return [];
        const overrides: string[] = [];
        for (const tool of allowTools) {
            if (tool === 'run_command') {
                // Scope to the specific command being approved. If no CommandLine
                // is available (shouldn't happen for run_command), skip the
                // override rather than emitting an unbounded command(*).
                if (pendingCommandLine) {
                    overrides.push(`command(${pendingCommandLine})`);
                }
                // No fallback to command(*) — that would be a privilege escalation.
            } else if (tool.startsWith('command(')) {
                // Already scoped — pass through as-is.
                overrides.push(tool);
            } else {
                // Generic tool session-allow: pass through as-is.
                overrides.push(tool);
            }
        }
        return overrides;
    }

    private isCommandAllowed(command: string): boolean {
        if (this.allowedCommandLiterals.has(command)) {
            return true;
        }
        for (const prefix of this.allowedCommandPrefixes) {
            if (command.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private rememberCommandPermission(permission: string): void {
        const match = permission.match(/^command\((.+?)\)$/);
        if (!match) {
            // Unrecognized format — treat as a plain tool name.
            this.sessionAllowedTools.add(permission);
            return;
        }
        const command = match[1];
        if (command === '*') {
            // command(*) should never arrive here (buildPermissionOverrides never
            // emits it), but handle defensively by ignoring rather than granting
            // unbounded session permission.
            logger.debug('[agyPermission] Ignoring command(*) in rememberCommandPermission — unbounded session allow not permitted');
        } else if (command.endsWith(':*')) {
            this.allowedCommandPrefixes.add(command.slice(0, -2));
        } else {
            this.allowedCommandLiterals.add(command);
        }
    }
}
