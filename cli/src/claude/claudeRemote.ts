import { EnhancedMode, PermissionMode } from "./loop";
import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { PLAN_FAKE_RESTART } from "./sdk/prompts";

export type ClaudeLiveAppend = (next: { message: string, mode: EnhancedMode }) => boolean;

function isBackgroundTaskNotificationMessage(message: SDKMessage): boolean {
    if (message.type !== 'user') return false;
    const userMessage = message as SDKUserMessage;
    if (userMessage.message.role !== 'user') return false;
    if (typeof userMessage.message.content !== 'string') return false;
    return isBackgroundTaskNotificationText(userMessage.message.content);
}

function isBackgroundTaskNotificationSystemEvent(message: SDKMessage): boolean {
    return message.type === 'system' && (message as SDKSystemMessage).subtype === 'task_notification';
}

function isExternalUserTextMessage(message: SDKMessage): boolean {
    if (message.type !== 'user') return false;
    const userMessage = message as SDKUserMessage;
    if (userMessage.message.role !== 'user') return false;
    if (typeof userMessage.message.content !== 'string') return false;
    return !isInternalQueuedMessage(userMessage.message.content);
}

function isBackgroundTaskNotificationText(message: string): boolean {
    return message.trimStart().startsWith('<task-notification>');
}

function isInternalQueuedMessage(message: string): boolean {
    const trimmed = message.trimStart();
    return trimmed === PLAN_FAKE_RESTART
        || trimmed.startsWith('<task-notification>')
        || trimmed.startsWith('<command-name>')
        || trimmed.startsWith('<local-command-caveat>')
        || trimmed.startsWith('<system-reminder>');
}

function isAllowedByConfiguredTools(toolName: string, input: unknown, allowedTools: string[]): boolean {
    if (allowedTools.length === 0) return false;

    if (toolName !== 'Bash') {
        return allowedTools.includes(toolName);
    }

    const command = typeof input === 'object' && input !== null && typeof (input as { command?: unknown }).command === 'string'
        ? (input as { command: string }).command
        : null;

    for (const tool of allowedTools) {
        if (tool === 'Bash') return true;
        if (!command) continue;

        const match = tool.match(/^Bash\((.+?)\)$/);
        if (!match) continue;

        const allowedCommand = match[1];
        if (allowedCommand.endsWith(':*')) {
            if (command.startsWith(allowedCommand.slice(0, -2))) return true;
        } else if (command === allowedCommand) {
            return true;
        }
    }

    return false;
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    hookSettingsPath: string,
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    registerLiveAppend?: (append: ClaudeLiveAppend) => void,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => Promise<void> | void,
    onThinkingChange?: (thinking: boolean) => void,
    onTurnDuration?: (durationMs: number) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    abortCurrentTurn?: () => void
}): Promise<'background-notification' | void> {
    const debugPrefix = '[claudeRemote][async-debug]';

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }
    process.env.DISABLE_AUTOUPDATER = '1';

    // Get initial message
    let initial;
    try {
        initial = await opts.nextMessage();
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted during initial message`);
            return;
        }
        throw e;
    }
    if (!initial) { // No initial message - exit
        logger.debug(`${debugPrefix} initial nextMessage returned null; exiting`);
        return;
    }
    logger.debug(`${debugPrefix} initial message acquired`);

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const configuredAllowedTools = initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools;
    let backgroundNotificationOnly = isBackgroundTaskNotificationText(initial.message);
    let backgroundNotificationClearPending = false;
    let externalUserMessagesPendingSdkEcho = 0;
    if (backgroundNotificationOnly) {
        logger.debug(`${debugPrefix} background notification guard enabled from initial queued message`);
    }
    const updateBackgroundNotificationOnlyForQueuedMessage = (reason: string, message: string) => {
        if (isBackgroundTaskNotificationText(message)) {
            backgroundNotificationOnly = true;
            backgroundNotificationClearPending = false;
            logger.debug(`${debugPrefix} background notification guard enabled by ${reason}`);
            return;
        }
        if (isInternalQueuedMessage(message)) {
            logger.debug(`${debugPrefix} background notification guard kept for internal queued message (${reason})`);
            return;
        }
        externalUserMessagesPendingSdkEcho += 1;
        if (backgroundNotificationOnly) {
            backgroundNotificationClearPending = true;
            logger.debug(`${debugPrefix} background notification guard clear pending by ${reason}`);
            return;
        }
        backgroundNotificationClearPending = false;
    };
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: initial.mode.permissionMode,
        model: initial.mode.model,
        effort: initial.mode.effort,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        // Keep permission enforcement in HAPI's canCallTool path. Passing
        // allowedTools to Claude Code can pre-approve tools before the HAPI
        // background-notification guard has a chance to deny them.
        allowedTools: [],
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => {
            if (backgroundNotificationOnly) {
                logger.debug(`${debugPrefix} denied tool call while handling background task notification: ${toolName}`);
                return Promise.resolve({
                    behavior: 'deny' as const,
                    message: 'Blocked because the current turn was triggered by an internal background task notification. Only report the background task completion/failure/status, then wait for a real user message before using tools or starting new work.'
                });
            }
            if (isAllowedByConfiguredTools(toolName, input, configuredAllowedTools)) {
                return Promise.resolve({
                    behavior: 'allow' as const,
                    updatedInput: input as Record<string, unknown>
                });
            }
            return opts.canCallTool(toolName, input, mode, options);
        },
        abort: opts.signal,
        pathToClaudeCodeExecutable: getDefaultClaudeCodePath(),
        settingsPath: opts.hookSettingsPath,
        additionalDirectories: [getHapiBlobsDir()],
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    let turnStartedAt = Date.now();

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    let inputEnded = false;
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });
    opts.registerLiveAppend?.((next) => {
        if (inputEnded || messages.done || opts.signal?.aborted) {
            logger.debug(`${debugPrefix} live append rejected (inputEnded=${inputEnded}, done=${messages.done}, aborted=${Boolean(opts.signal?.aborted)})`);
            return false;
        }
        mode = next.mode;
        turnStartedAt = Date.now();
        try {
            updateBackgroundNotificationOnlyForQueuedMessage('live user message', next.message);
            messages.push({ type: 'user', message: { role: 'user', content: next.message } });
            logger.debug(
                `${debugPrefix} live append accepted ` +
                `messageLength=${next.message.length} permissionMode=${next.mode.permissionMode}`
            );
            return true;
        } catch (error) {
            logger.debug(`${debugPrefix} live append failed`, error);
            return false;
        }
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    let nextMessageFetchInFlight = false;
    let nextMessageFetchSeq = 0;
    let streamMessageSeq = 0;
    let resultSeq = 0;

    const extractResultDurationMs = (message: SDKMessage): number | null => {
        const raw = (message as Record<string, unknown>).duration_ms
            ?? (message as Record<string, unknown>).durationMs;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
            return null;
        }
        return Math.round(raw);
    };

    const scheduleNextMessage = () => {
        if (nextMessageFetchInFlight || inputEnded) {
            logger.debug(
                `${debugPrefix} scheduleNextMessage skipped ` +
                `(inFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded})`
            );
            return;
        }

        const fetchId = ++nextMessageFetchSeq;
        const startedAt = Date.now();
        nextMessageFetchInFlight = true;
        logger.debug(`${debugPrefix} scheduleNextMessage start fetchId=${fetchId}`);
        void (async () => {
            try {
                const next = await opts.nextMessage();
                if (!next) {
                    inputEnded = true;
                    messages.end();
                    logger.debug(
                        `${debugPrefix} nextMessage resolved null fetchId=${fetchId} elapsedMs=${Date.now() - startedAt}; input ended`
                    );
                    return;
                }
                mode = next.mode;
                turnStartedAt = Date.now();
                updateBackgroundNotificationOnlyForQueuedMessage('scheduled user message', next.message);
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
                updateThinking(true);
                logger.debug(
                    `${debugPrefix} nextMessage resolved fetchId=${fetchId} elapsedMs=${Date.now() - startedAt} ` +
                    `messageLength=${next.message.length} permissionMode=${next.mode.permissionMode}`
                );
            } catch (e) {
                inputEnded = true;
                if (e instanceof AbortError) {
                    messages.end();
                    logger.debug(`${debugPrefix} nextMessage aborted fetchId=${fetchId}`);
                    return;
                }
                messages.setError(e instanceof Error ? e : new Error(String(e)));
                logger.debug(`${debugPrefix} nextMessage error fetchId=${fetchId}`, e);
            } finally {
                nextMessageFetchInFlight = false;
                logger.debug(`${debugPrefix} scheduleNextMessage done fetchId=${fetchId}`);
            }
        })();
    };

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            streamMessageSeq += 1;
            logger.debug(
                `${debugPrefix} stream message #${streamMessageSeq} type=${message.type} ` +
                `subtype=${'subtype' in message ? String((message as any).subtype) : 'n/a'}`
            );
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            const isTaskNotificationSystemEvent = isBackgroundTaskNotificationSystemEvent(message);
            const isExternalUserEcho = isExternalUserTextMessage(message);
            const hasExternalUserMessagePendingSdkEcho = externalUserMessagesPendingSdkEcho > 0;
            let shouldEndTaskNotificationTurn = false;

            if (isTaskNotificationSystemEvent && hasExternalUserMessagePendingSdkEcho) {
                logger.debug(`${debugPrefix} SDK task_notification observed while external user message is pending echo; preserving real user turn`);
            } else if (isTaskNotificationSystemEvent) {
                backgroundNotificationOnly = true;
                backgroundNotificationClearPending = false;
                shouldEndTaskNotificationTurn = true;
                logger.debug(`${debugPrefix} background notification guard enabled by SDK task_notification event`);
            } else if (isBackgroundTaskNotificationMessage(message)) {
                backgroundNotificationOnly = true;
                backgroundNotificationClearPending = false;
                logger.debug(`${debugPrefix} background notification guard enabled`);
            } else if (isExternalUserEcho) {
                if (externalUserMessagesPendingSdkEcho > 0) {
                    externalUserMessagesPendingSdkEcho -= 1;
                }
                if (backgroundNotificationOnly && externalUserMessagesPendingSdkEcho === 0) {
                    backgroundNotificationOnly = false;
                    backgroundNotificationClearPending = false;
                    logger.debug(`${debugPrefix} background notification guard cleared by SDK user echo`);
                }
            }

            if (backgroundNotificationOnly && message.type === 'assistant') {
                logger.debug(
                    `${debugPrefix} suppressed assistant message while handling background task notification ` +
                    `(clearPending=${backgroundNotificationClearPending})`
                );
                continue;
            }

            // Handle messages
            opts.onMessage(message);

            if (isTaskNotificationSystemEvent && shouldEndTaskNotificationTurn) {
                updateThinking(false);
                opts.onReady();
                opts.abortCurrentTurn?.();
                logger.debug(`${debugPrefix} ended autonomous SDK task_notification turn before assistant/tool continuation`);
                return 'background-notification';
            }

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    await opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                resultSeq += 1;
                updateThinking(false);
                opts.onTurnDuration?.(
                    extractResultDurationMs(message)
                    ?? Math.max(0, Date.now() - turnStartedAt)
                );
                logger.debug(
                    `${debugPrefix} result #${resultSeq} received; scheduling next user message ` +
                    `(nextInFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded})`
                );

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();
                logger.debug(`${debugPrefix} onReady emitted for result #${resultSeq}`);

                // Pull next user message without blocking response stream processing.
                // Claude may emit autonomous async messages (e.g. scheduled tasks) after a result,
                // and we must keep consuming those messages immediately.
                scheduleNextMessage();
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            logger.debug(`${debugPrefix} tool aborted via tool_result; exiting stream loop`);
                            return;
                        }
                    }
                }
            }
        }
        logger.debug(`${debugPrefix} response stream exhausted`);
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            logger.debug(`${debugPrefix} response stream error`, e);
            throw e;
        }
    } finally {
        logger.debug(
            `${debugPrefix} finally ` +
            `(streamMessages=${streamMessageSeq}, results=${resultSeq}, nextFetches=${nextMessageFetchSeq}, inputEnded=${inputEnded})`
        );
        updateThinking(false);
    }
}
