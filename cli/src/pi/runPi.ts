import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, createModeChangeHandler, setControlledByUser } from '@/agent/runnerLifecycle';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PiTransport } from './piTransport';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { PiSession } from './session';
import { PiConversationHistory, PiHistoryRestoreError } from './conversationHistory';
import { parsePiModels, parsePiCommands, PiRpcTimeoutError, sendPiRpcAndWait, wireTransportEvents } from './loop';
import { convertPiCompactionUsage } from './piEventConverter';
import { PiThinkingLevelSchema, SetSessionConfigPayloadSchema, PiCompactResultSchema, PiFullSessionStatsSchema } from './schemas';
import type { PiImageContent, PiThinkingLevel } from './types';
import { parsePiSpecialCommand, parseLeadingSlashName, type PiSpecialCommand } from './specialCommands';
import { PiPromptQueue, isPiSpecialQueued, type PiPreparedPrompt } from './promptQueue';
import { PiSteerDispatcher } from './steerDispatcher';
import { getBuiltinSlashCommands, mergeSlashCommands } from '@hapi/protocol/slashCommands';
import type { ListPiModelsResponse, PiCommandSummary, PiModelSummary, SlashCommand, SlashCommandsResponse } from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { ListSkillsResponse, SkillSummary } from '@/modules/common/skills';
import type { AttachmentMetadata } from '@/api/types';
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile';
import { MAX_UPLOAD_BYTES } from '@/modules/common/attachmentLimits';
import { isAuthorizedUploadFile, isPathWithinUploadDir, type UploadFileIdentity } from '@/modules/common/handlers/uploads';

// Grace period before force-draining prompts buffered during Pi startup when no
// get_state response arrives. Comfortably above the 10s Pi RPC timeout so a slow
// but healthy startup still flips ready via get_state first (issue #1143).
const PI_READY_FALLBACK_MS = 30_000;
const PI_ABORT_OPERATION_TIMEOUT_MS = 25_000;
// Manual compaction runs an LLM summarization pass; give it a generous window
// far above the 10s default Pi RPC timeout.
const PI_COMPACT_TIMEOUT_MS = 120_000;

const PI_HELP_TEXT = [
    'Supported HAPI Pi commands:',
    '/compact [instructions] — compress conversation history to save context',
    '/session — show session stats (tokens, cost, context usage)',
    '/model [modelId] — show or switch the active model',
    '/help — show this message',
].join('\n');

function formatPiSessionStatsMessage(stats: {
    totalMessages?: number;
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
    cost?: number;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number };
}): string {
    const lines: string[] = ['📊 Pi session stats'];
    if (stats.totalMessages !== undefined) lines.push(`Messages: ${stats.totalMessages}`);
    const tokens = stats.tokens;
    if (tokens && tokens.total !== undefined) {
        const parts = [`total ${tokens.total}`];
        if (tokens.input !== undefined) parts.push(`in ${tokens.input}`);
        if (tokens.output !== undefined) parts.push(`out ${tokens.output}`);
        if (tokens.cacheRead !== undefined) parts.push(`cacheR ${tokens.cacheRead}`);
        if (tokens.cacheWrite !== undefined) parts.push(`cacheW ${tokens.cacheWrite}`);
        lines.push(`Tokens: ${parts.join(' · ')}`);
    }
    if (stats.cost !== undefined) lines.push(`Cost: $${stats.cost.toFixed(4)}`);
    const usage = stats.contextUsage;
    if (usage && usage.tokens !== null && usage.tokens !== undefined) {
        const window = usage.contextWindow ? ` / ${usage.contextWindow}` : '';
        const percent = usage.percent !== undefined && usage.percent !== null ? ` (${usage.percent}%)` : '';
        lines.push(`Context: ${usage.tokens}${window} tokens${percent}`);
    }
    return lines.join('\n');
}

function isPiNoActiveAbortError(detail: string): boolean {
    return /no active|nothing.*abort/i.test(detail);
}

function getPiSkillName(commandName: string): string {
    return commandName.startsWith('skill:') ? commandName.slice('skill:'.length) : commandName;
}

export function buildPiCommandInventory(commands: readonly PiCommandSummary[]): {
    skills: SkillSummary[];
    slashCommands: SlashCommand[];
} {
    const skills: SkillSummary[] = [];
    const slashCommands: SlashCommand[] = [];

    for (const command of commands) {
        if (command.source === 'skill') {
            const name = getPiSkillName(command.name);
            if (name) skills.push({ name, description: command.description });
            continue;
        }
        slashCommands.push({
            name: command.name,
            description: command.description,
            source: command.source === 'prompt' ? 'user' : 'plugin',
        });
    }

    return { skills, slashCommands };
}

export function rewritePiSkillPrompt(message: string, commands: readonly PiCommandSummary[]): string {
    const match = /^(\s*)\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(message);
    if (!match) return message;

    const command = commands.find(candidate =>
        candidate.source === 'skill' && getPiSkillName(candidate.name) === match[2]
    );
    return `${match[1]}/${command?.name ?? `skill:${match[2]}`}${message.slice(match[0].length)}`;
}

function formatPiFileNotice(path: string): string {
    // Pi 0.83 rejects @file arguments in RPC mode. Keep this as ordinary prompt
    // text so the model can use its read tool, with JSON quoting preventing a
    // path containing whitespace or a newline from injecting another prompt line.
    return `Attached file: ${JSON.stringify(path)}`;
}

function formatPiTextAttachments(attachments: AttachmentMetadata[] | undefined): string {
    if (!attachments) return '';
    return attachments
        .filter((attachment) => !attachment.mimeType.toLowerCase().startsWith('image/'))
        .map((attachment) => formatPiFileNotice(attachment.path))
        .join('\n');
}

export function formatPiUserMessage(
    message: string,
    attachments: AttachmentMetadata[] | undefined,
    commands: readonly PiCommandSummary[],
): string {
    const skillPrompt = rewritePiSkillPrompt(message, commands);
    const attachmentText = formatPiTextAttachments(attachments);
    if (skillPrompt === message) {
        if (!attachmentText) return message;
        return message ? `${attachmentText}\n\n${message}` : attachmentText;
    }
    // Pi parses slash/skill commands only when they are the first line.
    return attachmentText ? `${skillPrompt}\n\n${attachmentText}` : skillPrompt;
}

export type PiPromptPreparation = Omit<PiPreparedPrompt, 'outboundSequence'> & { imageReadErrors: string[] };

export async function preparePiUserMessage(
    message: string,
    attachments: AttachmentMetadata[] | undefined,
    commands: readonly PiCommandSummary[],
    options: {
        authorizeImagePath: (path: string) => boolean;
        authorizeOpenedImage: (path: string, identity: UploadFileIdentity) => boolean;
    },
): Promise<PiPromptPreparation> {
    const formattedMessage = formatPiUserMessage(message, attachments, commands);
    const images: PiImageContent[] = [];
    const imageReadErrors: string[] = [];
    let totalImageBytes = 0;

    for (const attachment of attachments ?? []) {
        if (!attachment.mimeType.toLowerCase().startsWith('image/')) continue;
        try {
            const uploadPath = attachment.path;
            if (!options.authorizeImagePath(uploadPath)) {
                throw new Error('invalid upload path');
            }
            const data = await readBoundedAttachmentFile(
                uploadPath,
                MAX_UPLOAD_BYTES - totalImageBytes,
                (identity) => options.authorizeOpenedImage(uploadPath, identity),
            );
            totalImageBytes += data.length;
            images.push({ type: 'image', data: data.toString('base64'), mimeType: attachment.mimeType });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            imageReadErrors.push(`Could not attach image ${attachment.filename}: ${detail}`);
        }
    }

    return { message: formattedMessage, images, imageReadErrors };
}

/** A failed source restore leaves the live wrapper on an unknown native branch. */
export function failPiHistoryOnRestoreError(error: unknown, failNativeStartup: (error: Error) => void): void {
    if (error instanceof PiHistoryRestoreError) failNativeStartup(error);
}

export async function runPi(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    // Pi only runs as `pi --mode rpc` with piped stdio — there is no local
    // terminal/TUI input path (unlike Claude/Codex). Defaulting a terminal
    // launch to 'local' would mark the session local-controlled while the user
    // cannot drive it from the terminal, leaving it stuck until a web switch.
    // Default to 'remote' so the session is immediately drivable from the web;
    // an explicit opts.startingMode (e.g. runner) still takes precedence.
    const startingMode: 'local' | 'remote' = opts.startingMode ?? 'remote';

    logger.debug(`[pi] Starting with options: startedBy=${startedBy}, startingMode=${startingMode}`);

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'pi',
            startedBy,
            workingDirectory,
        })
        : await bootstrapSession({
            flavor: 'pi',
            startedBy,
            workingDirectory,
            // Do not seed the hub session model from opts.model: it is unconfirmed
            // until get_available_models/set_model accept it. The hub's
            // handleSessionAlive persists every non-undefined keepAlive model, so
            // passing it here would store/show a model Pi may reject. PiSession
            // carries opts.model as initialModel and applies it once confirmed.
            model: undefined
        });
    const { session: apiSession } = bootstrap;

    setControlledByUser(apiSession, startingMode);

    const piSession = new PiSession({
        api: bootstrap.api,
        client: apiSession,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        startedBy,
        startingMode,
        model: opts.model,
        expectedNativeSessionId: opts.resumeSessionId,
    });

    const transportArgs = ['--mode', 'rpc'];
    if (opts.resumeSessionId) {
        transportArgs.push('--session', opts.resumeSessionId);
    }
    const transport = new PiTransport({
        command: getAgentLaunchCommand('pi'),
        args: transportArgs,
        cwd: workingDirectory,
        env: { ...process.env, PI_RPC_EMIT_TITLE: '1' },
    });
    const conversationHistory = new PiConversationHistory(
        piSession,
        (command, timeoutMs) => sendPiRpcAndWait(piSession, transport, command, timeoutMs),
    );
    let historyBaseline: Promise<boolean> | null = null;
    let historyInitialization: Promise<void> | null = null;
    const initializeHistoryBaseline = (): Promise<boolean> => {
        historyBaseline ??= conversationHistory.initializeBaseline();
        return historyBaseline;
    };
    const initializeHistory = (): Promise<void> => {
        historyInitialization ??= initializeHistoryBaseline().then(async (baselineReady) => {
            if (baselineReady) await conversationHistory.probeCapabilities();
        });
        return historyInitialization;
    };
    piSession.setNativeReadyPreparation(initializeHistory);

    const publishConversationHistoryCapabilities = async () => {
        const conversationHistoryCapabilities = conversationHistory.getCapabilitiesForMetadata()?.conversationHistory;
        piSession.updateMetadata((metadata) => {
            const capabilities = { ...metadata.capabilities };
            delete capabilities.conversationHistory;
            if (conversationHistoryCapabilities) {
                capabilities.conversationHistory = conversationHistoryCapabilities;
            }
            return { ...metadata, capabilities };
        });
    };
    conversationHistory.setPublishCapabilities(publishConversationHistoryCapabilities);
    conversationHistory.restoreEntryIds(
        typeof apiSession.getMetadata === 'function'
            ? apiSession.getMetadata()?.conversationHistoryEntryIds
            : undefined,
    );

    piSession.startKeepAlive();

    let killedByCleanup = false;
    const lifecycle = createRunnerLifecycle({
        session: apiSession,
        logTag: 'pi',
        stopKeepAlive: () => piSession.stopKeepAlive(),
        onAfterClose: () => {
            piSession.stopKeepAlive();
            killedByCleanup = true;
            transport.kill();
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(apiSession.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(apiSession.rpcHandlerManager, lifecycle);

    let cleanupInitiated = false;
    let steerDispatcher: PiSteerDispatcher | null = null;
    const safeCleanup = async () => {
        if (cleanupInitiated) return;
        cleanupInitiated = true;
        steerDispatcher?.stop();
        piSession.cancelReadyGate();
        await lifecycle.cleanupAndExit();
    };

    // Install the completion hook before transport.start(). Pi can synchronously
    // report an invalid --session during the first get_state send; installing it
    // later would leave runPi awaiting a promise that can no longer be resolved.
    let resolveCleanupCompletion!: () => void;
    const cleanupCompletion = new Promise<void>((resolve) => {
        resolveCleanupCompletion = resolve;
    });
    const originalCleanupAndExit = lifecycle.cleanupAndExit.bind(lifecycle);
    lifecycle.cleanupAndExit = async (codeOverride?: number) => {
        resolveCleanupCompletion();
        await originalCleanupAndExit(codeOverride);
    };

    // Pending user-message localIds in FIFO order
    const pendingLocalIds: string[] = [];

    let transportEvents: ReturnType<typeof wireTransportEvents> | null = null;

    // --- Transport error/close handlers ---
    transport.onError((error) => {
        steerDispatcher?.stop();
        transportEvents?.flush();
        transportEvents?.cancelPendingExtensionUi('Pi transport failed', { sendResponse: false });
        transportEvents?.terminatePendingRpc(error);
        logger.debug(`[pi] Transport error: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onClose((code, signal) => {
        steerDispatcher?.stop();
        transportEvents?.flush();
        transportEvents?.cancelPendingExtensionUi('Pi session ended', { sendResponse: false });
        transportEvents?.terminatePendingRpc(new Error('Pi session ended'));
        if (killedByCleanup) {
            logger.debug(`[pi] Pi process closed during lifecycle cleanup (code=${code}, signal=${signal})`);
            void safeCleanup();
            return;
        }
        const reason = signal
            ? `Pi process killed by signal ${signal}`
            : `Pi process exited with code ${code ?? 'null'}`;
        logger.debug(`[pi] ${reason}`);
        lifecycle.markCrash(new Error(reason));
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(reason.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    // --- Wire transport events to session ---
    // Capture the requested startup effort WITHOUT mutating currentThinkingLevel.
    // It is applied (and committed) only after Pi confirms set_thinking_level,
    // mirroring the startup-model contract; seeding it here would leak an
    // unconfirmed/rejected value via the first keepAlive (pushKeepAlive persists
    // effort) before the RPC runs. get_state's thinkingLevel is the authoritative
    // source until set_thinking_level succeeds.
    let startupThinkingLevel: PiThinkingLevel | null = null;
    if (opts.effort) {
        const result = PiThinkingLevelSchema.safeParse(opts.effort.trim().toLowerCase());
        if (result.success) {
            startupThinkingLevel = result.data;
        } else {
            logger.debug(`[pi] Ignoring invalid effort value on resume: ${opts.effort}`);
        }
    }

    const failNativeStartup = (error: Error) => {
        // A wrapper socket can already be active while Pi rejects --session.
        // End this process immediately so the hub's Pi-ready wait fails and
        // an archived HAPI row is restored rather than shown as reopened.
        logger.debug(`[pi] Native startup failed: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    };

    const promptQueue = new PiPromptQueue();
    const preparingLocalIds = new Set<string>();
    const cancelledWhilePreparing = new Set<string>();
    // LocalIds whose owner pressed Steer while image preparation was still in
    // flight, mapped to the streaming generation observed at request time.
    // Checked after preparation completes, before normal FIFO routing, so an
    // explicit steer request is never lost to the queue (and cancel still wins
    // over it because cancellation is checked earlier in the chain). The
    // captured generation matters: if the original turn ends and a new one
    // starts while the message is preparing, the dispatcher's mismatch check
    // degrades the message to the prompt FIFO instead of steering into a turn
    // the operator never targeted.
    const steerPendingWhilePreparing = new Map<string, number>();
    let preparationChain = Promise.resolve();
    let promptCommandInFlight = false;
    let abortInFlight = false;
    // Set while a queued Pi special command (e.g. /compact) is executing. Pi's
    // compact() aborts any active stream itself, so piIsStreaming/
    // promptCommandInFlight can go false mid-compaction; this flag keeps the
    // prompt pump from dispatching the next FIFO item Pi would reject
    // ("Cannot submit a prompt while compaction is in progress").
    let piSpecialCommandInFlight = false;
    // Tracks a dequeued /compact through the gap between queue dispatch and
    // the compact RPC actually being issued (the runtime-mutation lock can
    // be held by an earlier mutation). Abort uses it to cancel a compact
    // that has not started yet, or to interrupt one that has.
    let activeCompact: { rpcStarted: boolean; cancelled: boolean } | null = null;
    let activePromptLocalId: string | undefined;
    let historyPumpDeferred = false;
    let agentLifecycleStarted = false;
    let nextOutboundSequence = 0;

    const setPromptCommandInFlight = (value: boolean): void => {
        promptCommandInFlight = value;
        piSession.setPromptInFlight(value);
    };

    type ActiveAbortGuard = {
        deadlineAt: number;
        lifecycleStartedAtRequest: boolean;
        compensationRequired: boolean;
        compensationStarted: boolean;
        compensationConfirmed: boolean;
        lifecycleMissingObserved: boolean;
        settled: boolean;
        timer: ReturnType<typeof setTimeout>;
        resolve: () => void;
        reject: (error: Error) => void;
    };
    let activeAbortGuard: ActiveAbortGuard | null = null;

    const maybeResolveAbortGuard = (): void => {
        const guard = activeAbortGuard;
        if (!guard?.settled) return;
        if (guard.compensationRequired && !guard.compensationConfirmed) return;
        clearTimeout(guard.timer);
        guard.resolve();
    };

    const markPromptBoundarySettled = (): void => {
        if (activeAbortGuard) {
            activeAbortGuard.settled = true;
            maybeResolveAbortGuard();
            return;
        }
        setPromptCommandInFlight(false);
        activePromptLocalId = undefined;
        agentLifecycleStarted = false;
        pumpPromptQueue();
    };

    const createAbortGuard = (deadlineAt: number): { guard: ActiveAbortGuard; promise: Promise<void> } => {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        let guard!: ActiveAbortGuard;
        const timer = setTimeout(() => {
            // A successful prompt response with no agent lifecycle is how Pi
            // reports extension-command-only prompts. During abort we keep the
            // guard for the entire stability window so a genuinely late
            // agent_start can still trigger compensation.
            if (guard.lifecycleMissingObserved && !guard.compensationRequired) {
                guard.settled = true;
                maybeResolveAbortGuard();
                return;
            }
            reject(new Error(`Pi prompt did not settle within ${PI_ABORT_OPERATION_TIMEOUT_MS}ms after abort`));
        }, Math.max(1, deadlineAt - Date.now()));
        timer.unref?.();
        guard = {
            deadlineAt,
            lifecycleStartedAtRequest: agentLifecycleStarted,
            compensationRequired: false,
            compensationStarted: false,
            compensationConfirmed: false,
            lifecycleMissingObserved: false,
            settled: false,
            timer,
            resolve,
            reject,
        };
        return { guard, promise };
    };

    const pumpPromptQueue = (): void => {
        if (cleanupInitiated) return;
        if (piSession.isHistoryTransactionActive) {
            if (!historyPumpDeferred) {
                historyPumpDeferred = true;
                piSession.runWhenHistoryIdle(() => {
                    historyPumpDeferred = false;
                    pumpPromptQueue();
                });
            }
            return;
        }
        if (
            !piSession.isReady
            || abortInFlight
            || piSpecialCommandInFlight
            // Earlier steers can fall back only after async preparation/runtime
            // lock wait. Do not let a later normal prompt overtake that result.
            || steerDispatcher?.hasPending
        ) return;
        // A head-of-line /compact stays interruptible while Pi is streaming:
        // Pi's compact() aborts the active generation itself, so a long or
        // stuck turn can still be compacted from HAPI. Every other item waits
        // for the stream to settle (FIFO order preserved).
        const next = promptQueue.peek();
        const canInterrupt = next !== undefined
            && isPiSpecialQueued(next)
            && next.command.type === 'compact'
            && piSession.piIsStreaming;
        if (!canInterrupt && (piSession.piIsStreaming || promptCommandInFlight)) return;
        const dequeued = promptQueue.dequeue();
        if (!dequeued) return;
        if (isPiSpecialQueued(dequeued)) {
            // Slash commands share the prompt FIFO so dispatch order matches
            // arrival order; execute out-of-band while the pump stays blocked.
            piSpecialCommandInFlight = true;
            if (dequeued.command.type === 'compact') {
                activeCompact = { rpcStarted: false, cancelled: false };
            }
            // Special commands are executed by HAPI itself and are never
            // delivered to Pi as prompts. Consume the queue row the moment
            // dispatch starts: deferring consumption until the command
            // finishes would keep the row stuck in the web queued bar for the
            // whole execution — a /compact run performs an LLM summarization
            // pass that can take minutes.
            if (dequeued.localId) {
                piSession.emitMessagesConsumed(
                    [dequeued.localId],
                    // The queued-thinking grace is session-scoped; only drop
                    // it for commands that finish synchronously. /compact
                    // keeps working for minutes with queued prompts behind it
                    // still awaiting their turn, so its acknowledgement must
                    // not clear their grace.
                    dequeued.command.type === 'compact'
                        ? undefined
                        : { clearQueuedThinkingGrace: true },
                );
            }
            void handlePiSpecialCommand(dequeued.command)
                .catch((error) => {
                    // All known command failures surface as events inside
                    // handlePiSpecialCommand; this catch only guards against
                    // an unexpected rejection leaving an unhandled promise
                    // rejection, and always keeps the pump unblocked via the
                    // finally below.
                    logger.warn(`[pi] Special command ${dequeued.command.type} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
                })
                .finally(() => {
                    piSpecialCommandInFlight = false;
                    activeCompact = null;
                    pumpPromptQueue();
                });
            return;
        }
        setPromptCommandInFlight(true);
        activePromptLocalId = dequeued.localId;
        agentLifecycleStarted = false;
        const promptId = randomUUID();
        transportEvents?.beginPromptLifecycle(promptId);
        if (dequeued.localId) {
            conversationHistory.registerUserEntry(dequeued.localId);
            pendingLocalIds.push(dequeued.localId);
        }
        transport.send({ id: promptId, type: 'prompt', message: dequeued.message, ...(dequeued.images.length > 0 ? { images: dequeued.images } : {}) });
    };

    transportEvents = wireTransportEvents(transport, piSession, pendingLocalIds, {
        onStartupFailure: failNativeStartup,
        conversationHistory,
        onReady: () => piSession.runWhenReady(pumpPromptQueue),
        onAgentLifecycleStarted: () => {
            const wasStarted = agentLifecycleStarted;
            agentLifecycleStarted = true;
            const guard = activeAbortGuard;
            if (!guard || guard.lifecycleStartedAtRequest || wasStarted || guard.compensationStarted) return;

            // Pi 0.83 can acknowledge abort while a prompt is still in async
            // preflight. If that prompt starts afterwards, compensate only once
            // now that agent.abort() has an active run to cancel.
            guard.compensationRequired = true;
            guard.compensationStarted = true;
            const remainingMs = Math.floor(guard.deadlineAt - Date.now());
            if (remainingMs <= 0) {
                guard.reject(new Error('Pi compensating abort missed the abort deadline'));
                return;
            }
            void sendPiRpcAndWait(piSession, transport, { type: 'abort' }, Math.min(10_000, remainingMs))
                .then(() => {
                    if (activeAbortGuard !== guard) return;
                    guard.compensationConfirmed = true;
                    maybeResolveAbortGuard();
                })
                .catch((error: unknown) => {
                    if (activeAbortGuard !== guard) return;
                    const detail = error instanceof Error ? error.message : String(error);
                    guard.reject(new Error(`Pi compensating abort failed: ${detail}`));
                });
        },
        onAgentSettled: markPromptBoundarySettled,
        onPromptRejected: (localId) => {
            const rejectedLocalId = localId ?? activePromptLocalId;
            if (rejectedLocalId) conversationHistory.rejectPendingEntry(rejectedLocalId);
            markPromptBoundarySettled();
        },
        onPromptLifecycleMissing: (localId) => {
            const rejectedLocalId = localId ?? activePromptLocalId;
            if (rejectedLocalId) {
                conversationHistory.rejectPendingEntry(rejectedLocalId);
                if (pendingLocalIds[0] === rejectedLocalId) pendingLocalIds.shift();
                piSession.emitMessagesConsumed([rejectedLocalId], { clearQueuedThinkingGrace: true });
            }
            if (activeAbortGuard) {
                activeAbortGuard.lifecycleMissingObserved = true;
                return false;
            }
            markPromptBoundarySettled();
            return true;
        },
    });

    steerDispatcher = new PiSteerDispatcher({
        session: piSession,
        transport,
        conversationHistory,
        enqueuePrompt: (entry) => {
            if (cleanupInitiated) return;
            promptQueue.enqueue(entry);
        },
        onIndeterminateTimeout: (error) => {
            failNativeStartup(new Error(`Pi steer outcome is indeterminate: ${error.message}`));
        },
        onPendingStateChange: pumpPromptQueue,
    });

    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.ForkConversation, async (payload: unknown) => {
        const messageLocalId = payload && typeof payload === 'object'
            && typeof (payload as { messageLocalId?: unknown }).messageLocalId === 'string'
            ? (payload as { messageLocalId: string }).messageLocalId
            : undefined;
        try {
            return await conversationHistory.fork(messageLocalId);
        } catch (error) {
            failPiHistoryOnRestoreError(error, failNativeStartup);
            throw error;
        }
    });
    // --- Steer-queued-message RPC ---
    // Delivers one queued message into the active Pi turn (native steer). The
    // web shows a per-message Steer button only while Pi is thinking; the hub
    // gates flavor/remote/scheduled before reaching this handler. Messages
    // still being prepared are marked for steering and promoted right after
    // preparation completes, so the request is never lost to the FIFO.
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async (payload: unknown) => {
        const localId = payload && typeof payload === 'object'
            && typeof (payload as { localId?: unknown }).localId === 'string'
            ? (payload as { localId: string }).localId
            : undefined;
        if (!localId) {
            return { steered: false, error: 'localId is required' };
        }
        if (preparingLocalIds.has(localId)) {
            const generation = piSession.currentStreamingGeneration;
            if (!piSession.isReady || generation === null) {
                return { steered: false, error: 'Session is not streaming' };
            }
            steerPendingWhilePreparing.set(localId, generation);
            return { steered: true };
        }
        if (!steerDispatcher) {
            return { steered: false, error: 'Steering is not ready' };
        }
        const entry = promptQueue.removeByLocalId(localId);
        if (!entry) {
            return { steered: false, error: 'Message not found or already dispatched' };
        }
        // Slash commands are not steerable prompts: restoring them into the FIFO
        // lets the pump execute them in arrival order once the turn settles.
        if (isPiSpecialQueued(entry)) {
            promptQueue.enqueue(entry);
            return { steered: false, error: 'Slash commands cannot be steered' };
        }
        // Only steer into a live Pi generation. Otherwise restore the entry to
        // its FIFO position (enqueue re-orders by outboundSequence) and let the
        // normal pump deliver it when the agent settles.
        const currentGeneration = piSession.currentStreamingGeneration;
        if (!piSession.isReady || currentGeneration === null) {
            promptQueue.enqueue(entry);
            return { steered: false, error: 'Session is not streaming' };
        }
        steerDispatcher.enqueue({ ...entry, targetStreamingGeneration: currentGeneration });
        return { steered: true };
    });

    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object' || typeof (payload as { messageLocalId?: unknown }).messageLocalId !== 'string') {
            throw new Error('messageLocalId is required');
        }
        try {
            return await conversationHistory.rewind((payload as { messageLocalId: string }).messageLocalId);
        } catch (error) {
            failPiHistoryOnRestoreError(error, failNativeStartup);
            throw error;
        }
    });

    // --- Session config RPC ---
    //
    // Pi manually registers SetSessionConfig instead of using
    // registerSessionConfigRpc() because Pi's wire protocol requires
    // separate provider + modelId fields (transport.send({ type:
    // 'set_model', provider, modelId })), while registerSessionConfigRpc
    // only handles model as a simple string. The hub sends model as
    // { provider, modelId } for Pi sessions.

    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (rawPayload: unknown) => {
        piSession.assertNoHistoryTransaction('change session configuration');
        const parsed = SetSessionConfigPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
            throw new Error('Invalid session config payload');
        }
        const config = parsed.data;
        logger.debug(`[pi] SetSessionConfig received: ${JSON.stringify(config)}`);

        // Resolve requested values WITHOUT mutating PiSession yet. Commit them
        // only after Pi confirms via sendPiRpcAndWait, otherwise a rejected
        // set_model/set_thinking_level would leave PiSession holding unconfirmed
        // values that the 2s keepalive reports back to the hub, persisting a
        // model/effort Pi never accepted.
        let requestedModel: { modelId: string | null; provider: string | null } | undefined;
        if (config.model !== undefined) {
            const modelValue = config.model;
            logger.debug(`[pi] SetSessionConfig model: ${JSON.stringify(modelValue)}`);

            if (modelValue === null) {
                requestedModel = { modelId: null, provider: null };
            } else if (typeof modelValue === 'string') {
                const trimmed = modelValue.trim();
                if (!trimmed) throw new Error('Invalid model');
                // Fallback: search cached models for provider
                const cached = piSession.cachedPiModels.find(m => m.modelId === trimmed);
                requestedModel = { modelId: trimmed, provider: cached?.provider ?? null };
            } else {
                // { provider, modelId } form
                requestedModel = { modelId: modelValue.modelId, provider: modelValue.provider };
            }
            logger.debug(`[pi] SetSessionConfig resolved: model=${requestedModel.modelId}, provider=${requestedModel.provider}`);
        }
        let requestedThinkingLevel: PiThinkingLevel | null | undefined;
        if (config.effort !== undefined) {
            if (config.effort === null) {
                requestedThinkingLevel = null;
            } else {
                const result = PiThinkingLevelSchema.safeParse(
                    typeof config.effort === 'string' ? config.effort.trim().toLowerCase() : config.effort,
                );
                if (!result.success) throw new Error('Invalid effort');
                requestedThinkingLevel = result.data;
            }
        }

        try {
            return await piSession.runRuntimeMutation(async () => {
                // Forward changes to Pi process — wait for Pi to confirm before
                // committing to PiSession or reporting applied. The runtime mutation
                // lock is shared with clone/fork/switch_session so a slow set_model
                // can never finish against a temporary history branch.
                if (requestedModel) {
                    if (requestedModel.modelId && requestedModel.provider) {
                        await sendPiRpcAndWait(piSession, transport, {
                            type: 'set_model',
                            provider: requestedModel.provider,
                            modelId: requestedModel.modelId,
                        });
                        piSession.currentModel = requestedModel.modelId;
                        piSession.currentProvider = requestedModel.provider;
                    } else if (requestedModel.modelId && !requestedModel.provider) {
                        // Provider is unknown until get_state/get_available_models resolve.
                        // Committing now would persist piSelectedModel while Pi never received
                        // set_model — contradicting the "await Pi confirmation" contract above.
                        // Throw so the hub returns 409 and the web client can retry once the
                        // provider is known.
                        logger.debug('[pi] set_model suppressed: provider unknown until get_state');
                        throw new Error('Model cannot be applied yet: provider is not yet known');
                    } else if (requestedModel.modelId === null) {
                        // Clearing the model needs no Pi RPC (nothing to confirm), so commit
                        // immediately. This path is not reachable from the web Pi picker today.
                        piSession.currentModel = null;
                        piSession.currentProvider = null;
                    }
                }
                if (requestedThinkingLevel !== undefined) {
                    const level = requestedThinkingLevel ?? 'off';
                    await sendPiRpcAndWait(piSession, transport, { type: 'set_thinking_level', level });
                    piSession.currentThinkingLevel = requestedThinkingLevel;
                }
                piSession.pushKeepAlive();

                // Return provider-qualified model so the hub persists piSelectedModel.
                // A bare modelId string would make applySessionConfig clear the
                // provider metadata (object check fails), defeating Fix #3.
                const appliedModel = piSession.currentModel && piSession.currentProvider
                    ? { provider: piSession.currentProvider, modelId: piSession.currentModel }
                    : piSession.currentModel;

                return {
                    applied: {
                        model: appliedModel,
                        effort: piSession.currentThinkingLevel,
                    },
                };
            }, { poisonOnError: (error) => error instanceof PiRpcTimeoutError });
        } catch (error) {
            if (error instanceof PiRpcTimeoutError) {
                failNativeStartup(new Error(`Pi configuration outcome is indeterminate: ${error.message}`));
            }
            throw error;
        }
    });

    // --- Pi model discovery RPC ---
    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, ListPiModelsResponse>(
        RPC_METHODS.ListPiModels,
        async () => {
            if (piSession.cachedPiModels.length > 0) {
                return {
                    success: true,
                    availableModels: piSession.cachedPiModels,
                    currentModelId: piSession.currentModel,
                };
            }
            try {
                const data = await sendPiRpcAndWait(piSession, transport, { type: 'get_available_models' });
                const models = parsePiModels(data);
                if (models.length > 0) {
                    piSession.cachedPiModels = models;
                    piSession.updateMetadata(meta => ({ ...meta, piAvailableModels: models }));
                }
                return { success: true, availableModels: models, currentModelId: piSession.currentModel };
            } catch (error) {
                logger.debug('[pi] ListPiModels RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to list Pi models',
                };
            }
        }
    );

    const getPiCommands = async (): Promise<PiCommandSummary[]> => {
        if (piSession.cachedPiCommands.length > 0) return piSession.cachedPiCommands;
        try {
            const data = await sendPiRpcAndWait(piSession, transport, { type: 'get_commands' });
            const commands = parsePiCommands(data);
            if (commands.length > 0) piSession.cachedPiCommands = commands;
            return commands;
        } catch {
            return [];
        }
    };

    const getPiModels = async (): Promise<PiModelSummary[]> => {
        // Startup model discovery can be late or fail once; retry the RPC on
        // an empty cache so /model never reports valid models as unknown.
        if (piSession.cachedPiModels.length > 0) return piSession.cachedPiModels;
        try {
            const data = await sendPiRpcAndWait(piSession, transport, { type: 'get_available_models' });
            const models = parsePiModels(data);
            if (models.length > 0) piSession.cachedPiModels = models;
            return models;
        } catch {
            return [];
        }
    };

    // --- Pi commands and skills ---
    apiSession.rpcHandlerManager.registerHandler<{ agent?: string }, SlashCommandsResponse>(
        RPC_METHODS.ListSlashCommands,
        async () => {
            const { slashCommands } = buildPiCommandInventory(await getPiCommands());
            return {
                success: true,
                // Pi's get_commands only reports extension commands, prompt
                // templates, and skills — never its TUI builtins. Merge the
                // HAPI-side builtin list (the subset translatable to Pi RPC)
                // so the web / menu exposes /compact, /session, /model, /help.
                commands: mergeSlashCommands([...getBuiltinSlashCommands('pi'), ...slashCommands]),
            };
        }
    );

    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, ListSkillsResponse>(
        RPC_METHODS.ListSkills,
        async () => {
            const { skills } = buildPiCommandInventory(await getPiCommands());
            return { success: true, skills };
        }
    );

    // --- Pi built-in slash commands ---
    // pi only runs as `pi --mode rpc` over piped stdio, so TUI slash commands
    // typed in web would otherwise fall through to the LLM as plain text and
    // silently do nothing. Intercept the subset HAPI can translate to Pi RPC
    // (compact/session/model/help) and make terminal-only commands explicit.
    const handlePiSpecialCommand = async (command: PiSpecialCommand): Promise<void> => {
        const sendEvent = (message: string): void => {
            piSession.sendSessionEvent({ type: 'message', message });
        };
        const errorDetail = (error: unknown): string => error instanceof Error ? error.message : String(error);

        switch (command.type) {
            case 'help':
                sendEvent(PI_HELP_TEXT);
                return;
            case 'session': {
                try {
                    const data = await sendPiRpcAndWait(piSession, transport, { type: 'get_session_stats' });
                    const parsed = PiFullSessionStatsSchema.safeParse(data);
                    sendEvent(formatPiSessionStatsMessage(parsed.success ? parsed.data : {}));
                } catch (error) {
                    sendEvent(`⚠️ Could not read Pi session stats: ${errorDetail(error)}`);
                }
                return;
            }
            case 'model': {
                const qualified = (model: PiModelSummary): string => `${model.provider}/${model.modelId}`;
                const models = await getPiModels();
                if (!command.modelId) {
                    // List qualified selectors: duplicate bare IDs across
                    // providers are rejected by the switch path, so every
                    // listed entry must be copy-paste usable.
                    const current = piSession.currentModel && piSession.currentProvider
                        ? qualified({ provider: piSession.currentProvider, modelId: piSession.currentModel })
                        : piSession.currentModel ?? 'unset';
                    const available = models.map(qualified).join(', ');
                    sendEvent(`Current model: ${current}.\nAvailable: ${available || 'unknown — use /model <modelId>'}`);
                    return;
                }
                // The catalog is provider-qualified; prefer an exact
                // provider/modelId match and refuse bare IDs shared by more
                // than one provider instead of silently picking the first.
                const exact = models.find((model) => qualified(model) === command.modelId);
                const bare = models.filter((model) => model.modelId === command.modelId);
                if (!exact && bare.length > 1) {
                    sendEvent(`⚠️ Ambiguous model: ${command.modelId}. Use ${bare.map(qualified).join(', ')}.`);
                    return;
                }
                const match = exact ?? bare[0];
                if (!match) {
                    sendEvent(`⚠️ Unknown model: ${command.modelId}. Use /model to list available models.`);
                    return;
                }
                try {
                    await piSession.runRuntimeMutation(async () => {
                        await sendPiRpcAndWait(piSession, transport, {
                            type: 'set_model',
                            provider: match.provider,
                            modelId: match.modelId,
                        });
                        piSession.currentModel = match.modelId;
                        piSession.currentProvider = match.provider;
                        // The web picker prefers piSelectedModel metadata for
                        // selection, context-window resolution, and effort
                        // options; a bare keepalive model is not enough to
                        // reflect a provider-qualified switch.
                        piSession.updateMetadata((meta) => ({
                            ...meta,
                            piSelectedModel: { provider: match.provider, modelId: match.modelId },
                        }));
                        piSession.pushKeepAlive();
                    }, { poisonOnError: (error) => error instanceof PiRpcTimeoutError });
                    sendEvent(`Model switched to ${command.modelId}`);
                } catch (error) {
                    if (error instanceof PiRpcTimeoutError) {
                        failNativeStartup(new Error(`Pi model switch outcome is indeterminate: ${error.message}`));
                    } else {
                        sendEvent(`⚠️ Model switch failed: ${errorDetail(error)}`);
                    }
                }
                return;
            }
            case 'compact': {
                // A compaction run can take minutes without any Pi streaming
                // event, so mark the session as thinking for the duration;
                // the 15s queued-thinking grace alone would let the web show
                // the session idle while compaction and any queued prompts
                // are still pending.
                piSession.updateThinkingState(true)
                // Interrupting a turn with /compact must retire pending
                // extension UI requests exactly like the Abort path does;
                // editor requests have no timeout, so a stale input/permission
                // card would otherwise stick in AgentState.requests and the
                // next answer could be routed to the aborted turn.
                transportEvents?.cancelPendingExtensionUi('Pi prompt compacted', { sendResponse: true });
                try {
                    const data = await piSession.runRuntimeMutation(async () => {
                        // Abort can land while this compact is still queued on
                        // the runtime-mutation lock; skip it once the lock
                        // arrives instead of starting a compaction the user
                        // already cancelled.
                        const state = activeCompact;
                        if (state?.cancelled) return null;
                        if (state) state.rpcStarted = true;
                        try {
                            return await sendPiRpcAndWait(piSession, transport, {
                                type: 'compact',
                                ...(command.instructions ? { customInstructions: command.instructions } : {}),
                            }, PI_COMPACT_TIMEOUT_MS);
                        } finally {
                            if (state) state.rpcStarted = false;
                        }
                    }, { poisonOnError: (error) => error instanceof PiRpcTimeoutError });
                    if (data === null) {
                        // Cancelled by Abort before the RPC was issued;
                        // nothing ran, so there is nothing to report.
                        return;
                    }
                    // Pi emits compaction_start/compaction_end lifecycle events
                    // which surface as "📦 Compaction …" status messages. The
                    // summary itself is a structured event so the web chat can
                    // render it as a dedicated block instead of a tiny status
                    // line; the token delta rides on the same event.
                    const parsed = PiCompactResultSchema.safeParse(data);
                    const result = parsed.success ? parsed.data : {};
                    if (result.summary) {
                        piSession.sendSessionEvent({
                            type: 'compact-summary',
                            summary: result.summary,
                            tokensBefore: result.tokensBefore,
                            estimatedTokensAfter: result.estimatedTokensAfter,
                        });
                    } else {
                        // No summary in the RPC result (defensive): fall back to
                        // the plain status line so the token delta still lands.
                        const delta: string[] = [];
                        if (result.tokensBefore !== undefined) delta.push(String(result.tokensBefore));
                        delta.push('→');
                        if (result.estimatedTokensAfter !== undefined) delta.push(String(result.estimatedTokensAfter));
                        else delta.push('?');
                        sendEvent(`📦 Compaction completed (tokens: ${delta.join(' ')})`);
                    }
                    // Pi reports unknown context stats until the next model
                    // response; use the compact result's estimate as a
                    // temporary context-only update, then let real usage
                    // replace it on the next turn.
                    const usage = convertPiCompactionUsage(result.estimatedTokensAfter);
                    const convertedUsage = usage ? convertAgentMessage(usage, piSession.currentModel) : null;
                    if (convertedUsage) piSession.sendAgentMessage(convertedUsage);
                } catch (error) {
                    if (error instanceof PiRpcTimeoutError) {
                        // The runtime lease is deliberately retained on timeout
                        // (poisonOnError), so the session is indeterminate: Pi
                        // may still be compacting while model switches, steers,
                        // and history mutations can no longer run. Fail the
                        // session instead of reopening the prompt FIFO.
                        failNativeStartup(new Error(`Pi compaction outcome is indeterminate: ${error.message}`));
                        return;
                    }
                    const detail = errorDetail(error);
                    if (/cancell?ed/i.test(detail)) {
                        // Interrupted by the Abort action: Pi already emitted
                        // the compaction_end(aborted) lifecycle event
                        // ("📦 Compaction canceled"), so do not double-report
                        // the same cancellation as a failure.
                        return;
                    }
                    sendEvent(`⚠️ Compaction failed: ${detail}`);
                } finally {
                    piSession.updateThinkingState(false)
                }
                return;
            }
            case 'unsupported':
                sendEvent(`⚠️ /${command.name} is a Pi terminal-only command and cannot run from HAPI web. Supported here: /compact, /session, /model, /help.`);
                return;
        }
    };

    // Preparation reads image files asynchronously. A single promise chain keeps
    // attachment completion order identical to user-message arrival order.
    apiSession.onUserMessage((message, localId) => {
        const deliveryMode = message.meta?.deliveryMode ?? 'queue';
        // Reserve message order and, for native steering, the exact turn before
        // attachment preparation or a runtime-lock wait can yield execution.
        const outboundSequence = nextOutboundSequence++;
        const targetStreamingGeneration = deliveryMode === 'steer'
            ? piSession.currentStreamingGeneration
            : null;
        if (localId) preparingLocalIds.add(localId);
        preparationChain = preparationChain.then(async () => {
            if (localId && cancelledWhilePreparing.delete(localId)) {
                preparingLocalIds.delete(localId);
                return;
            }

            const name = parseLeadingSlashName(message.content.text);
            // Discovered extension commands / prompt templates win over HAPI
            // builtins: the menu already lets them override same-name entries,
            // so a user extension named "compact" must keep executing instead
            // of being swallowed by the builtin interception.
            const discovered = name
                ? await getPiCommands()
                : piSession.cachedPiCommands;
            // Discovery can take an RPC round-trip; a cancel acknowledged during
            // that window must still win over the command.
            if (localId && cancelledWhilePreparing.delete(localId)) {
                preparingLocalIds.delete(localId);
                return;
            }
            const isCustomCommand = Boolean(name && discovered.some((item) => item.name.toLowerCase() === name.toLowerCase()));
            const specialCommand = isCustomCommand
                ? null
                : parsePiSpecialCommand(message.content.text);
            if (specialCommand) {
                // Enter the same FIFO as prompts so dispatch order matches
                // arrival order (a /compact typed after a queued prompt never
                // jumps it). Release the cancellation reservation first: a
                // cancel that lands while the queued command is being dispatched
                // or executing is handled by the queue itself (cancelByLocalId)
                // and must not be acknowledged via preparingLocalIds.
                if (localId) {
                    preparingLocalIds.delete(localId);
                }
                promptQueue.enqueue({
                    kind: 'special',
                    command: specialCommand,
                    outboundSequence,
                    ...(localId ? { localId } : {}),
                });
                pumpPromptQueue();
                return;
            }

            const prepared = await preparePiUserMessage(
                message.content.text,
                message.content.attachments,
                piSession.cachedPiCommands,
                {
                    authorizeImagePath: (path) => isPathWithinUploadDir(path, apiSession.sessionId),
                    authorizeOpenedImage: (path, identity) => isAuthorizedUploadFile(path, apiSession.sessionId, identity),
                },
            );
            if (localId) {
                preparingLocalIds.delete(localId);
                if (cancelledWhilePreparing.delete(localId)) return;
            }
            for (const imageReadError of prepared.imageReadErrors) {
                piSession.sendSessionEvent({ type: 'message', message: imageReadError });
            }
            if (!prepared.message.trim() && prepared.images.length === 0) {
                // An image-only prompt can lose every image during asynchronous
                // preparation. Never issue an empty Pi prompt; resolve the HAPI
                // queue row so QueuedMessagesBar cannot remain stuck forever.
                if (localId) piSession.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                return;
            }
            const entry = {
                message: prepared.message,
                images: prepared.images,
                outboundSequence,
                ...(localId ? { localId } : {}),
            };
            if (deliveryMode === 'steer') {
                steerDispatcher?.enqueue({ ...entry, targetStreamingGeneration });
            } else if (localId && steerPendingWhilePreparing.has(localId)) {
                // The user pressed Steer while this message was still preparing.
                // Promote it into the turn observed at request time; if that
                // turn already ended, the dispatcher degrades it to the FIFO.
                const targetGeneration = steerPendingWhilePreparing.get(localId)!;
                steerPendingWhilePreparing.delete(localId);
                steerDispatcher?.enqueue({ ...entry, targetStreamingGeneration: targetGeneration });
            } else {
                promptQueue.enqueue(entry);
                pumpPromptQueue();
            }
        }).catch((error: unknown) => {
            const wasCancelled = localId ? cancelledWhilePreparing.delete(localId) : false;
            if (localId) preparingLocalIds.delete(localId);
            const detail = error instanceof Error ? error.message : String(error);
            piSession.sendSessionEvent({ type: 'message', message: `Failed to prepare Pi prompt: ${detail}` });
            if (localId && !wasCancelled) {
                piSession.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
            }
        }).finally(() => {
            // Deferred-steer bookkeeping must not outlive the message it refers
            // to: the promotion path already deletes it, and every early exit
            // (cancellation before/after preparation, empty prepared message,
            // preparation failure) lands here. A stale entry could misroute a
            // later reuse of the same localId.
            if (localId) steerPendingWhilePreparing.delete(localId);
        });
    });

    // --- Cancel-queued-message handler ---
    // HAPI owns both asynchronous preparation and the local FIFO. A cancel may
    // arrive before image preparation completes or while the ready/settled queue
    // holds the item; both cases are removable. Once sent to Pi it is best-effort
    // only, matching other harness queues.
    apiSession.onCancelQueuedMessage((localId) => {
        if (preparingLocalIds.has(localId)) {
            cancelledWhilePreparing.add(localId);
            return true;
        }
        return promptQueue.cancelByLocalId(localId) || steerDispatcher?.cancelByLocalId(localId) === true;
    });

    // --- Abort handler ---
    // Only cancel the current turn, keep session alive for next prompt.
    // Pi's `abort` command cancels the active turn but the process stays in RPC mode.
    let abortPromise: Promise<{ success: true }> | null = null;
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        if (abortPromise) return await abortPromise;
        // /compact owns the runtime-mutation lease for up to
        // PI_COMPACT_TIMEOUT_MS (120s), far beyond the 25s abort deadline —
        // waiting on the lease would fail closed and tear down the session.
        // Interrupt the compaction directly: Pi's abort RPC cancels its
        // compaction AbortController, and Pi reports the cancellation through
        // the compaction_end lifecycle event. If the compact RPC has not been
        // issued yet (still queued on the mutation lock), cancel it in place
        // instead so it never starts.
        if (piSpecialCommandInFlight && activeCompact) {
            abortInFlight = true;
            const interrupted = activeCompact.rpcStarted
                ? sendPiRpcAndWait(piSession, transport, { type: 'abort' }, PI_ABORT_OPERATION_TIMEOUT_MS).then(() => ({ success: true } as const))
                : (() => {
                    activeCompact.cancelled = true;
                    return Promise.resolve({ success: true } as const);
                })();
            abortPromise = interrupted
                .catch((error) => {
                    // Mirror the ordinary Abort path: an unanswered abort RPC
                    // leaves the compaction outcome indeterminate (the compact
                    // RPC can keep the mutation lease for up to 120s), so fail
                    // the session instead of presenting the wrapper as live.
                    if (error instanceof PiRpcTimeoutError) {
                        const fatal = new Error(`Pi abort failed closed: ${error.message}`);
                        failNativeStartup(fatal);
                        throw fatal;
                    }
                    throw error;
                })
                .finally(() => {
                    abortInFlight = false;
                    abortPromise = null;
                });
            return await abortPromise;
        }
        piSession.assertNoHistoryTransaction('abort Pi');
        const deadlineAt = Date.now() + PI_ABORT_OPERATION_TIMEOUT_MS;
        abortInFlight = true;
        transportEvents?.cancelPendingExtensionUi('Pi prompt aborted', { sendResponse: true });
        const abortedLocalId = activePromptLocalId;
        const hadActivePrompt = promptCommandInFlight;
        const hadNativeWork = hadActivePrompt || piSession.piIsStreaming;
        const abortBoundary = hadActivePrompt ? createAbortGuard(deadlineAt) : null;
        if (abortBoundary) {
            activeAbortGuard = abortBoundary.guard;
            // The runtime lock can be queued behind a config mutation; attach a
            // handler immediately so a deadline rejection is never unhandled.
            void abortBoundary.promise.catch(() => {});
        }
        // Reserve our mutation slot synchronously, after installing the pump
        // barrier. A prompt that settles while an older config mutation owns the
        // lock therefore cannot start the next FIFO item or change our target.
        const acquireRuntimeMutation = hadNativeWork
            ? piSession.acquireRuntimeMutation()
            : null;

        let streamingInvalidatedUnderLock = false;
        abortPromise = (async (): Promise<{ success: true }> => {
            let releaseRuntimeMutation: (() => void) | null = null;
            let nativeAbortIssued = false;
            let firstAbortConfirmed = false;
            try {
                if (!acquireRuntimeMutation) {
                    return { success: true };
                }

                let lockTimer: ReturnType<typeof setTimeout> | null = null;
                try {
                    releaseRuntimeMutation = await Promise.race([
                        acquireRuntimeMutation,
                        new Promise<never>((_, reject) => {
                            lockTimer = setTimeout(() => reject(new PiRpcTimeoutError(
                                'abort-lock',
                                -1,
                                PI_ABORT_OPERATION_TIMEOUT_MS,
                            )), Math.max(1, deadlineAt - Date.now()));
                            lockTimer.unref?.();
                        }),
                    ]);
                } finally {
                    if (lockTimer) clearTimeout(lockTimer);
                }

                if (!abortBoundary?.guard.settled) {
                    const remainingMs = Math.floor(deadlineAt - Date.now());
                    if (remainingMs <= 0) {
                        throw new PiRpcTimeoutError('abort', -1, PI_ABORT_OPERATION_TIMEOUT_MS);
                    }
                    nativeAbortIssued = true;
                    await sendPiRpcAndWait(
                        piSession,
                        transport,
                        { type: 'abort' },
                        Math.min(10_000, remainingMs),
                    );
                    firstAbortConfirmed = true;
                }
                if (abortBoundary) await abortBoundary.promise;
                // Invalidate the aborted turn while still holding the runtime
                // mutation lease. A queued steer waiter must observe idle (and
                // therefore fall back) before it can acquire this same lease.
                piSession.updateThinkingState(false);
                streamingInvalidatedUnderLock = true;
                return { success: true };
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                const targetSettled = abortBoundary?.guard.settled === true;
                const mayStillStart = Boolean(
                    !(error instanceof PiRpcTimeoutError)
                    && !firstAbortConfirmed
                    && abortBoundary
                    && !abortBoundary.guard.lifecycleStartedAtRequest
                    && isPiNoActiveAbortError(detail)
                );
                if (mayStillStart) {
                    try {
                        // Pi can reject abort before async prompt preflight
                        // produces agent_start. Keep the guard for the complete
                        // stability window so a late start is compensated even
                        // when the 1s lifecycle-missing fallback has not fired.
                        await abortBoundary!.promise;
                        // Match the ordinary abort-success path: invalidate the
                        // target generation before releasing this mutex so a
                        // queued steer cannot enter the just-aborted turn.
                        piSession.updateThinkingState(false);
                        streamingInvalidatedUnderLock = true;
                        return { success: true };
                    } catch (guardError) {
                        const fatal = new Error(`Pi abort failed closed: ${guardError instanceof Error ? guardError.message : String(guardError)}`);
                        failNativeStartup(fatal);
                        throw fatal;
                    }
                }
                if (error instanceof PiRpcTimeoutError || firstAbortConfirmed || (!nativeAbortIssued && !targetSettled)) {
                    const fatal = new Error(`Pi abort failed closed: ${detail}`);
                    failNativeStartup(fatal);
                    throw fatal;
                }
                if (activeAbortGuard === abortBoundary?.guard) {
                    clearTimeout(abortBoundary.guard.timer);
                    activeAbortGuard = null;
                }
                abortInFlight = false;
                if (targetSettled) {
                    setPromptCommandInFlight(false);
                    activePromptLocalId = undefined;
                    agentLifecycleStarted = false;
                }
                pumpPromptQueue();
                piSession.sendSessionEvent({ type: 'message', message: `Pi abort failed: ${detail}` });
                throw new Error(`Pi abort failed: ${detail}`);
            } finally {
                releaseRuntimeMutation?.();
                if (!releaseRuntimeMutation && acquireRuntimeMutation) {
                    void acquireRuntimeMutation.then((lateRelease) => lateRelease());
                }
            }
        })().then((result) => {
            if (activeAbortGuard === abortBoundary?.guard) {
                clearTimeout(abortBoundary.guard.timer);
                activeAbortGuard = null;
            }
            transportEvents?.abortPromptLifecycle();
            if (abortedLocalId) {
                conversationHistory.rejectPendingEntry(abortedLocalId);
                if (pendingLocalIds[0] === abortedLocalId) {
                    pendingLocalIds.shift();
                    piSession.emitMessagesConsumed([abortedLocalId], { clearQueuedThinkingGrace: true });
                }
            }
            activePromptLocalId = undefined;
            agentLifecycleStarted = false;
            // The native-work path already invalidated the generation under
            // the runtime mutex. The no-work fast path reaches only this hook.
            if (!streamingInvalidatedUnderLock) piSession.updateThinkingState(false);
            setPromptCommandInFlight(false);
            abortInFlight = false;
            pumpPromptQueue();
            return result;
        }).finally(() => { abortPromise = null; });
        return await abortPromise;
    });

    // --- Switch handler ---
    // Unlike Claude/Codex (which use BaseLocalLauncher's restart loop), Pi runs
    // as a single long-lived subprocess. Switching mode should change control
    // ownership without killing the process or archiving the session.
    const handleModeChange = createModeChangeHandler(apiSession);
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async (payload: { to?: 'local' | 'remote' } = {}) => {
        const mode = payload.to ?? 'remote';
        piSession.setMode(mode);
        handleModeChange(mode);
        return { success: true };
    });

    // --- Run ---
    let crashed = false;
    // Fallback: if Pi never returns get_state (never flips ready), force-drain
    // buffered prompts after a grace period rather than swallowing them forever.
    // This degrades to pre-fix behaviour (send anyway) instead of something
    // worse. markReady is idempotent, so a real get_state that lands first wins.
    const readyFallback = setTimeout(() => {
        if (piSession.isReady) return;
        if (piSession.expectedNativeSessionId) {
            failNativeStartup(new Error(`Pi native resume did not become ready within ${PI_READY_FALLBACK_MS}ms`));
        } else {
            logger.debug('[pi] get_state ready signal not seen within grace — establishing history baseline before draining buffered messages');
            void initializeHistoryBaseline()
                .catch(() => {})
                .finally(() => {
                    if (cleanupInitiated) return;
                    piSession.markReady();
                    pumpPromptQueue();
                });
        }
    }, PI_READY_FALLBACK_MS);
    readyFallback.unref?.();
    try {
        transport.start();
        // Pi creates a fresh session (or resumes --session) before RPC mode
        // starts. Sending new_session here races get_state and discards a resumed session.
        transport.send({ type: 'get_state' });
        transport.send({ type: 'get_available_models' });
        transport.send({ type: 'get_commands' });

        // Apply the requested startup effort only after Pi confirms
        // set_thinking_level. Commit currentThinkingLevel on success and push a
        // keepAlive so the hub sees the accepted value; on rejection keep Pi's
        // default (already reported by get_state). Detached so the run loop is
        // not blocked; sent after get_state so the authoritative baseline lands
        // first and a late get_state response does not clobber the confirmed
        // value (get_state runs on the wire before this await resolves). When a
        // startup model is also requested, wait for it to settle first so
        // set_thinking_level cannot be rejected against Pi's default model
        // before set_model confirms the requested one.
        if (startupThinkingLevel) {
            void (async () => {
                if (opts.model) {
                    await piSession.startupModelSettled;
                }
                try {
                    await piSession.runRuntimeMutation(async () => {
                        await sendPiRpcAndWait(piSession, transport, {
                            type: 'set_thinking_level',
                            level: startupThinkingLevel,
                        });
                        piSession.currentThinkingLevel = startupThinkingLevel;
                        piSession.pushKeepAlive();
                    }, { poisonOnError: (error) => error instanceof PiRpcTimeoutError });
                    logger.debug(`[pi] Startup effort applied: ${startupThinkingLevel}`);
                } catch (error) {
                    if (error instanceof PiRpcTimeoutError) {
                        failNativeStartup(new Error(`Pi startup effort outcome is indeterminate: ${error.message}`));
                        return;
                    }
                    logger.debug(`[pi] Startup effort rejected, keeping Pi default: ${error instanceof Error ? error.message : String(error)}`);
                }
            })();
        }

        // Block until cleanup is triggered by error/close handler.
        await cleanupCompletion;
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        lifecycle.setSessionEndReason('error');
        logger.debug('[pi] Loop error:', error);
    } finally {
        clearTimeout(readyFallback);
        if (!crashed && !lifecycle.hasExplicitSessionEndReason()) {
            lifecycle.setSessionEndReason('completed');
        }
        await safeCleanup();
    }
}
