import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { SessionEffort, SessionModel } from '@/api/types';
import type { EnhancedMode } from './loop';
import type { PermissionMode } from './loop';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

/**
 * Decides what happens to a user message that arrives while a turn is already
 * running. Returns true if the message was steered into the live turn -- the
 * caller must then NOT also push it to the queue, or Claude would see it
 * twice. Returns false to mean "not steerable right now", i.e. the caller
 * should fall back to the normal queue path.
 *
 * `intent` is the sender's per-message preference (see MessageMetaSchema.steer):
 * true asks to steer, false asks to queue, undefined means "no opinion" and
 * lets the CLI-side default decide.
 *
 * Installed by claudeRemoteLauncher for the lifetime of one claudeRemote()
 * attempt; absent (and therefore always false) in local mode, before the first
 * spawn, and after the process is gone.
 */
export type SteerHook = (
    text: string,
    mode: EnhancedMode,
    localId?: string,
    intent?: boolean
) => boolean;

export class Session extends AgentSessionBase<EnhancedMode> {
    readonly claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];
    readonly mcpServers: Record<string, any>;
    readonly allowedTools?: string[];
    readonly hookSettingsPath: string;
    /** Settings for the interactive TUI: also forwards permission-mode-carrying hooks. */
    readonly localHookSettingsPath: string;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    private nativeSkillNames = new Set<string>();
    private steerHook: SteerHook | null = null;

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
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.effort = opts.effort;
    }

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

    setSteerHook = (hook: SteerHook | null): void => {
        this.steerHook = hook;
    };

    /**
     * Offer a message to the live turn. Falls back to `false` -- never throws
     * -- so a bug in the steering path can only cost the steering, never the
     * message: the caller queues it as it always did.
     */
    trySteer = (text: string, mode: EnhancedMode, localId?: string, intent?: boolean): boolean => {
        if (!this.steerHook) return false;
        try {
            return this.steerHook(text, mode, localId, intent);
        } catch (error) {
            logger.debug('[Session] Steer hook threw, falling back to queue', error);
            return false;
        }
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    /**
     * Clear the current session ID (used by /clear command)
     */
    clearSessionId = (): void => {
        this.sessionId = null;
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
