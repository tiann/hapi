import { EnhancedMode, PermissionMode } from "./loop";
import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { getSystemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { filterCatalogAffectingClaudeArgs } from "./sdk/metadataExtractor";
import { buildCompactCompletionEvent } from "./utils/compactCompletion";
import { findLatestCompactSummary } from "./utils/compactSummaryLookup";

export interface CompactSummaryPayload {
    summary: string;
    tokensBefore?: number;
    tokensAfter?: number;
}

interface CompactCompletion {
    completionEvent?: string;
    compactSummary?: CompactSummaryPayload;
    contextTokens?: number;
}

interface ActiveCompact {
    baseline: number | null;
    failure: string | null;
    sawCompactSignal: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
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
    /** Session modes used to spawn Claude before the first fork child prompt. */
    bootstrapMode?: EnhancedMode,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: (completionEvent?: string, compactSummary?: CompactSummaryPayload, compactContextTokens?: number) => void | Promise<void>,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string, extras?: { forkedFrom?: string }) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onFirstResult?: (initialMessage: string) => void,
    onCompactResultAccepted?: () => void,
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

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }
    process.env.DISABLE_AUTOUPDATER = '1';

    // Message-level Fork current passes `--fork-session` via claudeArgs from the runner.
    const forkSession = Boolean(opts.claudeArgs?.includes('--fork-session'));
    if (forkSession) {
        logger.debug(`[claudeRemote] --fork-session requested via claudeArgs`);
    }
    const forkedFrom = forkSession ? startFrom : null;

    // Mode starts from the persisted session for fork bootstrap; updated when
    // the first child prompt arrives. plan/auto must be present at process start.
    const bootstrapMode: EnhancedMode = opts.bootstrapMode ?? { permissionMode: 'default' };
    let mode: EnhancedMode = bootstrapMode;
    let initial: { message: string; mode: EnhancedMode } | null = null;
    let specialCommand: ReturnType<typeof parseSpecialCommand> = { type: null };
    // Owns all mutable state from command enqueue through its result. Null
    // means no manual compact turn can claim stream status or boundaries.
    const compactState: { active: ActiveCompact | null } = { active: null };
    // The local transcript is keyed by the live session id (updated on init),
    // not opts.sessionId which can be stale for forked sessions.
    let currentSessionId = startFrom;
    let awaitingForkInit = forkSession;

    const messages = new PushableAsyncIterable<SDKUserMessage>();

    // Success-only: a failed compaction keeps its failure line, an unknown
    // session id or any transcript read problem falls back to the plain
    // completion line. Never propagates errors into the result flow.
    // Null means the baseline could not be established (unknown session id or
    // unreadable transcript) — summary promotion is skipped entirely, because
    // reading from offset 0 could promote a previous compaction's summary row.
    const getTranscriptBytes = (): number | null => {
        if (!currentSessionId) return null;
        try {
            return statSync(join(getProjectPath(opts.path), `${currentSessionId}.jsonl`)).size;
        } catch {
            return null;
        }
    };
    const beginCompactCommand = () => {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        // Keep baseline capture, state arming, and command enqueue in one event
        // loop turn so an autonomous result cannot claim the pending compact.
        compactState.active = {
            baseline: getTranscriptBytes(),
            failure: null,
            sawCompactSignal: false
        };
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('📦 Compaction started');
        }
    };
    const lookupCompactSummary = async (
        failure: string | null,
        sessionId: string | null,
        baseline: number | null,
        tokensBefore: number | undefined,
        tokensAfter: number | undefined,
        signal?: AbortSignal
    ): Promise<CompactSummaryPayload | undefined> => {
        if (failure !== null || !sessionId || baseline === null) return undefined;
        try {
            const transcriptPath = join(getProjectPath(opts.path), `${sessionId}.jsonl`);
            const summary = await findLatestCompactSummary(transcriptPath, { minBytes: baseline, signal });
            if (summary === null) return undefined;
            return { summary, tokensBefore, tokensAfter };
        } catch (e) {
            logger.debug('[claudeRemote] compact summary lookup failed', e);
            return undefined;
        }
    };

    const applyInitialTurn = async (): Promise<{ message: string; mode: EnhancedMode } | null> => {
        let next: { message: string; mode: EnhancedMode } | null;
        try {
            next = await opts.nextMessage();
        } catch (e) {
            if (e instanceof AbortError) {
                logger.debug(`[claudeRemote] Aborted during initial message`);
                messages.end();
                return null;
            }
            throw e;
        }
        if (!next) {
            logger.debug(`${debugPrefix} initial nextMessage returned null; exiting`);
            messages.end();
            return null;
        }
        logger.debug(`${debugPrefix} initial message acquired`);

        specialCommand = parseSpecialCommand(next.message);
        if (specialCommand.type === 'clear') {
            if (opts.onCompletionEvent) {
                opts.onCompletionEvent('Context was reset');
            }
            if (opts.onSessionReset) {
                opts.onSessionReset();
            }
            messages.end();
            return null;
        }
        if (specialCommand.type === 'compact') {
            beginCompactCommand();
        }

        mode = next.mode;
        messages.push({
            type: 'user',
            message: {
                role: 'user',
                content: next.message,
            },
        });
        return next;
    };

    // Prepare SDK options. For --fork-session, start query() before waiting for the
    // first child prompt so the native fork materializes at the clicked source state.
    const hapiSystemPrompt = getSystemPrompt();
    const sdkOptions: Options = {
        additionalArgs: filterCatalogAffectingClaudeArgs(opts.claudeArgs),
        cwd: opts.path,
        resume: startFrom ?? undefined,
        forkSession,
        mcpServers: opts.mcpServers,
        permissionMode: bootstrapMode.permissionMode,
        model: bootstrapMode.model,
        effort: bootstrapMode.effort,
        fallbackModel: bootstrapMode.fallbackModel,
        customSystemPrompt: bootstrapMode.customSystemPrompt
            ? bootstrapMode.customSystemPrompt + '\n\n' + hapiSystemPrompt
            : undefined,
        appendSystemPrompt: bootstrapMode.appendSystemPrompt
            ? bootstrapMode.appendSystemPrompt + '\n\n' + hapiSystemPrompt
            : hapiSystemPrompt,
        allowedTools: bootstrapMode.allowedTools
            ? bootstrapMode.allowedTools.concat(opts.allowedTools)
            : opts.allowedTools,
        disallowedTools: bootstrapMode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        abort: opts.signal,
        pathToClaudeCodeExecutable: getDefaultClaudeCodePath(),
        settingsPath: opts.hookSettingsPath,
        additionalDirectories: [getHapiBlobsDir()],
    }

    if (!awaitingForkInit) {
        const first = await applyInitialTurn();
        if (!first) {
            return;
        }
        initial = first;
        sdkOptions.permissionMode = first.mode.permissionMode;
        sdkOptions.model = first.mode.model;
        sdkOptions.effort = first.mode.effort;
        sdkOptions.fallbackModel = first.mode.fallbackModel;
        sdkOptions.customSystemPrompt = first.mode.customSystemPrompt
            ? first.mode.customSystemPrompt + '\n\n' + hapiSystemPrompt
            : undefined;
        sdkOptions.appendSystemPrompt = first.mode.appendSystemPrompt
            ? first.mode.appendSystemPrompt + '\n\n' + hapiSystemPrompt
            : hapiSystemPrompt;
        sdkOptions.allowedTools = first.mode.allowedTools
            ? first.mode.allowedTools.concat(opts.allowedTools)
            : opts.allowedTools;
        sdkOptions.disallowedTools = first.mode.disallowedTools;
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
    const compactCompletionAbort = new AbortController();
    let responseClosed = false;
    let compactCompletion: Promise<CompactCompletion> | null = null;
    const abortCompactCompletion = () => compactCompletionAbort.abort();
    opts.signal?.addEventListener('abort', abortCompactCompletion, { once: true });
    if (opts.signal?.aborted) compactCompletionAbort.abort();

    const scheduleNextMessage = () => {
        if (nextMessageFetchInFlight || inputEnded || responseClosed) {
            logger.debug(
                `${debugPrefix} scheduleNextMessage skipped ` +
                `(inFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded}, responseClosed=${responseClosed})`
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
                if (responseClosed) return;
                if (!next) {
                    inputEnded = true;
                    messages.end();
                    logger.debug(
                        `${debugPrefix} nextMessage resolved null fetchId=${fetchId} elapsedMs=${Date.now() - startedAt}; input ended`
                    );
                    return;
                }
                const nextSpecialCommand = parseSpecialCommand(next.message);
                if (nextSpecialCommand.type === 'compact') {
                    // /compact can arrive on any turn, not just the initial
                    // one — arm the compaction tracking here too so later
                    // turns get the same summary/token completion output.
                    beginCompactCommand();
                }
                mode = next.mode;
                specialCommand = nextSpecialCommand;
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

        const responseIterator = response[Symbol.asyncIterator]();
        let pendingResponseNext: Promise<IteratorResult<SDKMessage>> | null = null;
        let pendingResponseDone = false;
        let pendingResponseError: unknown;
        let hasPendingResponseError = false;
        while (true) {
            if (!pendingResponseNext) {
                pendingResponseDone = false;
                pendingResponseError = undefined;
                hasPendingResponseError = false;
                pendingResponseNext = responseIterator.next().then(
                    (result) => {
                        pendingResponseDone = result.done === true;
                        return result;
                    },
                    (error) => {
                        pendingResponseError = error;
                        hasPendingResponseError = true;
                        throw error;
                    }
                );
            }
            let message: SDKMessage;
            if (compactCompletion) {
                const winner = await Promise.race([
                    compactCompletion.then((result) => ({ type: 'compact' as const, result })),
                    pendingResponseNext.then(
                        (result) => ({ type: 'response' as const, result }),
                        (error) => ({ type: 'response-error' as const, error })
                    )
                ]);
                if (winner.type === 'response-error') {
                    if (winner.error instanceof AbortError) throw winner.error;
                    if (opts.signal?.aborted) throw new AbortError('Compaction completion aborted');
                    const completion = await compactCompletion;
                    compactCompletion = null;
                    await opts.onReady(
                        completion.completionEvent,
                        completion.compactSummary,
                        completion.contextTokens
                    );
                    throw winner.error;
                }
                if (winner.type === 'compact') {
                    compactCompletion = null;
                    await opts.onReady(
                        winner.result.completionEvent,
                        winner.result.compactSummary,
                        winner.result.contextTokens
                    );
                    logger.debug(`${debugPrefix} compact completion published`);
                    if (hasPendingResponseError) throw pendingResponseError;
                    if (pendingResponseDone) {
                        responseClosed = true;
                        break;
                    }
                    scheduleNextMessage();
                    continue;
                }
                pendingResponseNext = null;
                if (winner.result.done) {
                    responseClosed = true;
                    const completion = await compactCompletion;
                    compactCompletion = null;
                    await opts.onReady(
                        completion.completionEvent,
                        completion.compactSummary,
                        completion.contextTokens
                    );
                    break;
                }
                message = winner.result.value;
            } else {
                const next = await pendingResponseNext;
                pendingResponseNext = null;
                if (next.done) {
                    responseClosed = true;
                    break;
                }
                message = next.value;
            }
            streamMessageSeq += 1;
            logger.debug(
                `${debugPrefix} stream message #${streamMessageSeq} type=${message.type} ` +
                `subtype=${'subtype' in message ? String((message as any).subtype) : 'n/a'}`
            );
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages. During a manual /compact the compact_boundary
            // system message stays unrelayed: its only web rendering is a
            // "Conversation compacted" status line, which would duplicate the
            // completion output (summary card or token-delta line) right below
            // it. Auto-compact boundaries keep relaying as before.
            const compactMetadata =
                message.type === 'system' && message.subtype === 'compact_boundary'
                    ? (message as any).compact_metadata
                    : undefined;
            const isManualCompactBoundary =
                compactState.active !== null && compactMetadata?.trigger === 'manual';
            // The stdout echo of the active /compact is CLI bookkeeping for
            // this turn — suppress it here where the command state lives, so
            // identical output from other slash commands stays visible.
            const echo = message.type === 'user'
                ? (message as SDKUserMessage).message?.content
                : undefined;
            const isManualCompactBookkeeping =
                compactState.active !== null &&
                typeof echo === 'string' &&
                /^<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>$/.test(echo.trim());
            if (!isManualCompactBoundary && !isManualCompactBookkeeping) {
                opts.onMessage(message);
            }

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    currentSessionId = systemInit.session_id;
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    const extras = forkedFrom && forkedFrom !== systemInit.session_id
                        ? { forkedFrom }
                        : undefined;
                    opts.onSessionFound(systemInit.session_id, extras);
                }

                // Fork: only accept the first child prompt after the native branch exists.
                if (awaitingForkInit) {
                    awaitingForkInit = false;
                    const first = await applyInitialTurn();
                    if (!first) {
                        return;
                    }
                    initial = first;
                }
            }

            // Capture the /compact outcome. Only a reported failure is recorded:
            // anything else leaves the success path untouched, so a status shape
            // we do not recognise cannot invent a failure.
            if (message.type === 'system' && message.subtype === 'status' && compactState.active) {
                const systemStatus = message as SDKSystemMessage;
                if (systemStatus.status === 'compacting' || systemStatus.compact_result !== undefined) {
                    compactState.active.sawCompactSignal = true;
                }
                if (systemStatus.compact_result === 'failed') {
                    const reason = typeof systemStatus.compact_error === 'string'
                        ? systemStatus.compact_error.trim()
                        : '';
                    compactState.active.failure = reason;
                    logger.debug(`[claudeRemote] Compaction reported as failed: ${compactState.active.failure}`);
                }
            }

            // Capture the compaction token delta from the boundary metadata
            // (pre_tokens/post_tokens are the context sizes on each side).
            if (isManualCompactBoundary && compactState.active) {
                compactState.active.sawCompactSignal = true;
                if (typeof compactMetadata?.pre_tokens === 'number') compactState.active.tokensBefore = compactMetadata.pre_tokens;
                if (typeof compactMetadata?.post_tokens === 'number') compactState.active.tokensAfter = compactMetadata.post_tokens;
                logger.debug(`[claudeRemote] compact_boundary tokens: ${compactState.active.tokensBefore} -> ${compactState.active.tokensAfter}`);
            }

            // Handle result messages
            if (message.type === 'result') {
                resultSeq += 1;
                updateThinking(false);
                logger.debug(
                    `${debugPrefix} result #${resultSeq} received; scheduling next user message ` +
                    `(nextInFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded})`
                );

                if (resultSeq === 1 && specialCommand.type === null && initial) {
                    opts.onFirstResult?.(initial.message);
                }

                if (compactState.active) {
                    if (!compactState.active.sawCompactSignal) continue;
                    const compact = compactState.active;
                    const sessionId = currentSessionId;
                    const baseline = compact.baseline;
                    const failure = compact.failure;
                    const tokensBefore = compact.tokensBefore;
                    const tokensAfter = compact.tokensAfter;
                    // Preserve the post-compaction context size even when no
                    // summary was found: the launcher refreshes the context
                    // bar with it, since the next real usage only arrives
                    // with the next model response.
                    compactState.active = null;
                    opts.onCompactResultAccepted?.();

                    compactCompletion = (async () => {
                        const compactSummary = await lookupCompactSummary(
                            failure,
                            sessionId,
                            baseline,
                            tokensBefore,
                            tokensAfter,
                            compactCompletionAbort.signal
                        );
                        if (compactCompletionAbort.signal.aborted) {
                            throw new AbortError('Compaction completion aborted');
                        }
                        const completionEvent = compactSummary
                            ? undefined
                            : buildCompactCompletionEvent(failure, tokensBefore, tokensAfter);
                        logger.debug(`[claudeRemote] ${compactSummary ? `compact summary promoted (${compactSummary.summary.length} chars)` : completionEvent}`);
                        return { completionEvent, compactSummary, contextTokens: tokensAfter };
                    })();
                    continue;
                }

                // An autonomous result may arrive while transcript polling is
                // pending. The coordinator keeps consuming it, but the compact
                // outcome remains the sole owner of ready and the next prompt.
                if (compactCompletion) continue;

                await opts.onReady();
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
        responseClosed = true;
        compactCompletionAbort.abort();
        await Promise.allSettled(compactCompletion ? [compactCompletion] : []);
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            logger.debug(`${debugPrefix} response stream error`, e);
            throw e;
        }
    } finally {
        responseClosed = true;
        if (compactCompletion) {
            compactCompletionAbort.abort();
            await Promise.allSettled([compactCompletion]);
        }
        opts.signal?.removeEventListener('abort', abortCompactCompletion);
        logger.debug(
            `${debugPrefix} finally ` +
            `(streamMessages=${streamMessageSeq}, results=${resultSeq}, nextFetches=${nextMessageFetchSeq}, inputEnded=${inputEnded})`
        );
        updateThinking(false);
    }
}
