import { EnhancedMode, PermissionMode } from "./loop";
import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getLiveAgentKind } from "./utils/getLiveAgentKind";
import type { Metadata } from "@/api/types";
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
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string, extras?: Partial<Metadata>) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onFirstResult?: (initialMessage: string) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void
}) {
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

    // Set environment variables for Claude Code SDK.
    // Apply these BEFORE the liveness probe below: `getLiveAgentKind` execs
    // `claude agents --json` using `process.env` (e.g. CLAUDE_CONFIG_DIR,
    // HAPI_CLAUDE_PATH), so the probe must see the same claude env the real
    // launch will use. Otherwise it queries the default config/home, misses the
    // live session, picks `forkSession=false`, and the resume hits the
    // "currently running as a background agent" failure path.
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }
    process.env.DISABLE_AUTOUPDATER = '1';

    // Decide how to resume. A claude session can still be held open by a running
    // agent (background/interactive); a plain `--resume` is then rejected with
    // "currently running as a background agent". When that's the case, branch off
    // a copy with `--fork-session` instead of taking over the live session.
    // `getLiveAgentKind` degrades to null (treat as dead -> plain resume) when the
    // daemon roster is unavailable, so this never blocks the resume path.
    let forkSession = false;
    if (startFrom) {
        const liveKind = getLiveAgentKind(startFrom);
        if (liveKind) {
            forkSession = true;
            logger.debug(`[claudeRemote] Session ${startFrom} is live as ${liveKind} agent; resuming with --fork-session`);
        }
    }
    const forkedFrom = forkSession ? startFrom : null;

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
    // Claude reports the /compact outcome on a `system`/`status` message that
    // arrives before the `result` message. Hold it here so the completion event
    // can report what actually happened. Stays null unless a failure is
    // reported, so an unseen or successful status keeps the success path.
    let compactFailure: string | null = null;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        forkSession,
        mcpServers: opts.mcpServers,
        permissionMode: initial.mode.permissionMode,
        model: initial.mode.model,
        effort: initial.mode.effort,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
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

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    let nextMessageFetchInFlight = false;
    let inputEnded = false;
    let nextMessageFetchSeq = 0;
    let streamMessageSeq = 0;
    let resultSeq = 0;

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
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
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

            // Handle messages
            opts.onMessage(message);

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
                    // When forked, the new session_id is a branched copy: record its
                    // origin so the web list can mark it as "forked from ..." instead
                    // of surfacing two unrelated-looking sessions (R5).
                    const extras = forkedFrom && forkedFrom !== systemInit.session_id
                        ? { forkedFrom }
                        : undefined;
                    opts.onSessionFound(systemInit.session_id, extras);
                }
            }

            // Capture the /compact outcome. Only a reported failure is recorded:
            // anything else leaves the success path untouched, so a status shape
            // we do not recognise cannot invent a failure.
            if (message.type === 'system' && message.subtype === 'status' && isCompactCommand) {
                const systemStatus = message as SDKSystemMessage;
                if (systemStatus.compact_result === 'failed') {
                    const reason = typeof systemStatus.compact_error === 'string'
                        ? systemStatus.compact_error.trim()
                        : '';
                    compactFailure = reason.length > 0 ? reason : 'Compaction failed';
                    logger.debug(`[claudeRemote] Compaction reported as failed: ${compactFailure}`);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                resultSeq += 1;
                updateThinking(false);
                logger.debug(
                    `${debugPrefix} result #${resultSeq} received; scheduling next user message ` +
                    `(nextInFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded})`
                );

                if (resultSeq === 1 && specialCommand.type === null) {
                    opts.onFirstResult?.(initial.message);
                }

                // Send completion messages
                if (isCompactCommand) {
                    const completion = compactFailure
                        ? `Compaction failed: ${compactFailure}`
                        : 'Compaction completed';
                    logger.debug(`[claudeRemote] ${completion}`);
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent(completion);
                    }
                    isCompactCommand = false;
                    compactFailure = null;
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
