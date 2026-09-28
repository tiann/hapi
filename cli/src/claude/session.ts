import { LocalPermissionBridge } from './utils/localPermissionBridge';
import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { Metadata, SessionEffort, SessionModel } from '@/api/types';
import type { EnhancedMode } from './loop';
import type { PermissionMode } from './loop';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import { decideClaudeSessionFound, resolveClaudeResumeGuardId } from './utils/claudeResumeGuard';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class Session extends AgentSessionBase<EnhancedMode> {
    readonly claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];
    readonly mcpServers: Record<string, any>;
    readonly allowedTools?: string[];
    readonly hookSettingsPath: string;
    /** Interactive TUI hooks: mode tracking and native-dialog permission bridge. */
    readonly localHookSettingsPath: string;
    readonly localPermissionBridge: LocalPermissionBridge;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    private nativeSkillNames = new Set<string>();
    /**
     * Resume id we asked Claude to continue on this spawn. Cleared after the
     * first successful sessionFound adopt so later SessionStart events
     * (`/clear`, compact, …) can mint a new id without being treated as a
     * silent overwrite of the resume pointer (#1933).
     */
    private resumeGuardId: string | null;
    /**
     * Synchronous durable resume target. Prefer this over getMetadata() because
     * updateMetadata is async and can lag behind adopt /clear.
     */
    private durableResumeId: string | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        claudeEnvVars?: Record<string, string>;
        claudeArgs?: string[];
        mcpServers: Record<string, any>;
        messageQueue: MessageQueue2<EnhancedMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        allowedTools?: string[];
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        hookSettingsPath: string;
        localHookSettingsPath?: string;
        permissionMode?: PermissionMode;
        model?: SessionModel;
        effort?: SessionEffort;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'Session',
            sessionIdLabel: 'Claude Code',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                claudeSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort
        });

        this.claudeEnvVars = opts.claudeEnvVars;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this.allowedTools = opts.allowedTools;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.localHookSettingsPath = opts.localHookSettingsPath ?? opts.hookSettingsPath;
        this.localPermissionBridge = new LocalPermissionBridge(opts.client);
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.effort = opts.effort;
        this.resumeGuardId = resolveClaudeResumeGuardId(opts.sessionId, opts.claudeArgs);
        this.durableResumeId = resolveClaudeResumeGuardId(opts.sessionId, opts.claudeArgs);
    }

    /**
     * Adopt a Claude transcript id into durable metadata — unless we asked to
     * resume A on this spawn and Claude silently minted B (tiann/hapi#1933).
     * Launchers rearm the guard before each spawn from the ID actually passed
     * to Claude; a successful adopt / confirmed resume clears it so `/clear`
     * can mint a new id. Mismatch keeps the guard armed.
     */
    override onSessionFound = (sessionId: string, extras?: Partial<Metadata>): void => {
        const forkRequested = Boolean(extras?.forkedFrom)
            || Boolean(this.claudeArgs?.includes('--fork-session'));
        const decision = decideClaudeSessionFound({
            requestedId: this.resumeGuardId,
            reportedId: sessionId,
            forkRequested
        });
        if (decision.action === 'reject') {
            const message =
                `Claude resume mismatch: requested ${decision.requestedId} but Claude ` +
                `reported ${decision.reportedId}. Keeping the prior resume pointer; ` +
                `refusing to overwrite metadata.claudeSessionId. Reopen with an explicit ` +
                `fork if a new native transcript is intended.`;
            logger.warn(`[Session] ${message}`);
            this.client.sendSessionEvent({ type: 'message', message });
            // Local transport tails registered ids only — still notify listeners
            // so the live process is followed, without burning the durable pointer.
            // Keep resumeGuardId armed so a subsequent launch that reports B
            // again cannot write B into metadata.
            this.sessionId = decision.reportedId;
            this.notifySessionFoundListeners(decision.reportedId);
            return;
        }
        this.commitSessionId(decision.sessionId, extras);
        this.durableResumeId = decision.sessionId;
        this.resumeGuardId = null;
    };

    /**
     * Durable Claude transcript id for the next `--resume` / SDK resume.
     * Backed by an in-memory pointer so async metadata ACK lag cannot resume
     * a stale A after adopt or /clear. After mismatch, live sessionId may
     * follow minted B for local transport while durableResumeId stays A.
     */
    getClaudeResumeSessionId = (): string | null => {
        if (typeof this.durableResumeId === 'string' && this.durableResumeId.trim().length > 0) {
            return this.durableResumeId.trim();
        }
        return null;
    };

    /**
     * Arm the mismatch guard from the resume id about to be passed to Claude.
     * Call immediately before each local/remote launch.
     */
    armResumeGuard = (requestedId: string | null): void => {
        this.resumeGuardId = typeof requestedId === 'string' && requestedId.trim().length > 0
            ? requestedId.trim()
            : null;
    };

    /**
     * Successful local `--resume A` often re-emits SessionStart with the same
     * id, so onSessionFound is skipped. Clear the mismatch guard anyway so a
     * later `/clear` can mint B.
     */
    confirmResumeSessionId = (sessionId: string): void => {
        if (this.resumeGuardId && this.resumeGuardId === sessionId) {
            this.resumeGuardId = null;
            this.durableResumeId = sessionId;
            logger.debug(`[Session] Resume confirmed for ${sessionId}; mismatch guard released`);
        }
    };

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    // Override base getPermissionMode to return the Claude-narrow type. Safe
    // because the only writer (setPermissionMode above) accepts only Claude
    // PermissionMode, so the field cannot hold a foreign flavor value.
    getPermissionMode(): PermissionMode | undefined {
        return this.permissionMode as PermissionMode | undefined;
    }

    setModel = (model: SessionModel): void => {
        this.model = model;
    };

    setEffort = (effort: SessionEffort): void => {
        this.effort = effort;
    };

    setNativeSkillNames = (names: readonly string[]): void => {
        this.nativeSkillNames = new Set(names);
    };

    expandSkillReference = (message: string, trailingContext = ''): string => {
        const match = /^\s*\$([^\s]+)(?=\s|$)/.exec(message);
        if (!match || !this.nativeSkillNames.has(match[1])) return message;
        const expanded = `/${match[1]}${message.slice(match[0].length)}`;
        return trailingContext ? `${expanded}\n\n${trailingContext}` : expanded;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    /**
     * Clear the current session ID (used by /clear command).
     * Also drops durable metadata.claudeSessionId so the next launch does not
     * resume the transcript the user just discarded.
     */
    clearSessionId = (): void => {
        this.sessionId = null;
        this.resumeGuardId = null;
        this.durableResumeId = null;
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            claudeSessionId: undefined
        }));
        logger.debug('[Session] Session ID cleared');
    };

    /**
     * Consume one-time Claude flags from claudeArgs after Claude spawn.
     * Handles: --resume (with or without session ID) and --fork-session.
     * `--fork-session` must be one-shot; keeping it across relaunches would
     * branch again off the already-forked native id.
     */
    consumeOneTimeFlags = (): void => {
        if (!this.claudeArgs) return;

        const filteredArgs: string[] = [];
        for (let i = 0; i < this.claudeArgs.length; i++) {
            if (this.claudeArgs[i] === '--resume') {
                // Check if next arg looks like a UUID (contains dashes and alphanumeric)
                if (i + 1 < this.claudeArgs.length) {
                    const nextArg = this.claudeArgs[i + 1];
                    // Simple UUID pattern check - contains dashes and is not another flag
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        // Skip both --resume and the UUID
                        i++; // Skip the UUID
                        logger.debug(`[Session] Consumed --resume flag with session ID: ${nextArg}`);
                    } else {
                        // Just --resume without UUID
                        logger.debug('[Session] Consumed --resume flag (no session ID)');
                    }
                } else {
                    // --resume at the end of args
                    logger.debug('[Session] Consumed --resume flag (no session ID)');
                }
            } else if (this.claudeArgs[i] === '--fork-session') {
                logger.debug('[Session] Consumed --fork-session flag');
            } else {
                filteredArgs.push(this.claudeArgs[i]);
            }
        }

        this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
        logger.debug(`[Session] Consumed one-time flags, remaining args:`, this.claudeArgs);
    };
}
