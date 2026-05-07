import React from 'react';
import { randomUUID } from 'node:crypto';

import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { AppServerEventConverter } from './utils/appServerEventConverter';
import { registerAppServerPermissionHandlers } from './utils/appServerPermissionAdapter';
import { buildThreadStartParams, buildTurnStartParams } from './utils/appServerConfig';
import { shouldIgnoreTerminalEvent } from './utils/terminalEventGuard';
import { parseCodexSpecialCommand } from './codexSpecialCommands';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];
type QueuedMessage = { message: string; mode: EnhancedMode; isolate: boolean; hash: string };
type ChildAgentRuntime = {
    reasoningProcessor: ReasoningProcessor;
    diffProcessor: DiffProcessor;
    activeToolsByCallId: Map<string, {
        name: string;
        label: string;
        activity: string;
        activityKind: string;
    }>;
    pendingTitleByCallId: Map<string, string>;
    reasoningPreview: string;
    blockedNestedAgent: boolean;
};

const AGENT_RUN_UPDATE_THROTTLE_MS = 300;
const AGENT_RUN_START_TIMEOUT_MS = 30 * 1000;
const THROTTLED_AGENT_RUN_ACTIVITY_KINDS = new Set(['thinking']);

const SAME_THREAD_RETRYABLE_ERROR_PATTERNS = [
    'selected model is at capacity',
    'codex thread entered systemerror'
];
const CONTEXT_COMPACT_RETRYABLE_ERROR_PATTERNS = [
    'ran out of room in the model',
    'context window',
    'clear earlier history'
];
const SAME_THREAD_MAX_RETRIES = 3;
const SAME_THREAD_MAX_COMPACT_RETRIES = 1;
const SAME_THREAD_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

function isSameThreadRetryableCodexError(error: string | null): boolean {
    if (!error) {
        return false;
    }
    const normalized = error.toLowerCase();
    return SAME_THREAD_RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isContextCompactRetryableCodexError(error: string | null): boolean {
    if (!error) {
        return false;
    }
    const normalized = error.toLowerCase();
    return CONTEXT_COMPACT_RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

class CodexRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CodexSession;
    private readonly appServerClient: CodexAppServerClient;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private currentThreadId: string | null = null;
    private currentTurnId: string | null = null;

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.appServerClient = new CodexAppServerClient();
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private async handleAbort(): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (this.currentThreadId && this.currentTurnId) {
                try {
                    await this.appServerClient.interruptTurn({
                        threadId: this.currentThreadId,
                        turnId: this.currentTurnId
                    });
                } catch (error) {
                    logger.debug('[Codex] Error interrupting app-server turn:', error);
                }
            }
            this.currentTurnId = null;

            this.abortController.abort();
            this.session.queue.reset();
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            this.abortController = new AbortController();
        }
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
        this.exitReason = 'exit';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Switching to local mode via double space');
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchRequest(): Promise<void> {
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        if (this.session.codexArgs && this.session.codexArgs.length > 0) {
            if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
                logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                    `are ignored in remote mode.`);
            } else {
                logger.debug(`[codex-remote] Warning: CLI args [${this.session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                    `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
            }
        }

        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const appServerClient = this.appServerClient;
        const appServerEventConverter = new AppServerEventConverter();

        const normalizeCommand = (value: unknown): string | undefined => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length > 0 ? trimmed : undefined;
            }
            if (Array.isArray(value)) {
                const joined = value.filter((part): part is string => typeof part === 'string').join(' ');
                return joined.length > 0 ? joined : undefined;
            }
            return undefined;
        };

        const asRecord = (value: unknown): Record<string, unknown> | null => {
            if (!value || typeof value !== 'object') {
                return null;
            }
            return value as Record<string, unknown>;
        };

        const asString = (value: unknown): string | null => {
            return typeof value === 'string' && value.length > 0 ? value : null;
        };

        const applyResolvedModel = (value: unknown): string | undefined => {
            const resolvedModel = asString(value) ?? undefined;
            if (!resolvedModel) {
                return undefined;
            }
            session.setModel(resolvedModel);
            logger.debug(`[Codex] Resolved app-server model: ${resolvedModel}`);
            return resolvedModel;
        };

        const buildMcpToolName = (server: unknown, tool: unknown): string | null => {
            const serverName = asString(server);
            const toolName = asString(tool);
            if (!serverName || !toolName) {
                return null;
            }
            return `mcp__${serverName}__${toolName}`;
        };

        const isHapiChangeTitleToolName = (toolName: string | null): boolean => {
            return toolName === 'mcp__hapi__change_title';
        };

        const sendTitleSummary = (title: string): void => {
            session.client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
        };

        const formatOutputPreview = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (value === null || value === undefined) return '';
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const compactText = (text: string): string => {
            return text.replace(/\s+/g, ' ').trim();
        };

        const truncateText = (text: string, maxLength: number): string => {
            const compacted = compactText(text);
            if (compacted.length <= maxLength) return compacted;
            return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
        };

        const previewText = (value: unknown, maxLength = 120): string | null => {
            const text = formatOutputPreview(value);
            const preview = truncateText(text, maxLength);
            return preview.length > 0 ? preview : null;
        };

        const formatActivity = (verb: string, detail?: string | null, maxLength = 120): string => {
            const normalizedDetail = detail ? truncateText(detail, maxLength) : '';
            return normalizedDetail ? `${verb}: ${normalizedDetail}` : verb;
        };

        const extractTextItems = (input: unknown): string[] => {
            const record = asRecord(input);
            if (!record || !Array.isArray(record.items)) return [];
            return record.items
                .map((item) => {
                    const itemRecord = asRecord(item);
                    return asString(itemRecord?.text);
                })
                .filter((text): text is string => Boolean(text));
        };

        const extractAgentPrompt = (input: unknown): string | null => {
            const record = asRecord(input);
            if (!record) return null;

            const direct = asString(record.message ?? record.prompt);
            if (direct) return direct;

            const textItems = extractTextItems(input);
            return textItems.length > 0 ? textItems.join('\n\n') : null;
        };

        const cleanAgentPromptForSummary = (prompt: string): string => {
            const withoutTags = prompt
                .replace(/<[^>\n]+>/g, ' ')
                .replace(/\r/g, '\n');
            const noisePatterns = [
                /not alone in the codebase/i,
                /do not revert/i,
                /don't revert/i,
                /list the file paths/i,
                /changed files/i,
                /final answer/i,
                /avoid merge conflicts/i,
                /accommodate the changes/i
            ];
            const lines = withoutTags
                .split('\n')
                .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^#{1,6}\s+/, ''))
                .filter((line) => line.length > 0)
                .filter((line) => !noisePatterns.some((pattern) => pattern.test(line)));
            const candidate = lines.length > 0 ? lines.join(' ') : withoutTags;
            return compactText(candidate)
                .replace(/^(task|your task|request|prompt)\s*[:：]\s*/i, '')
                .trim();
        };

        const summarizeAgentInput = (input: unknown): string | null => {
            const prompt = extractAgentPrompt(input);
            if (prompt) {
                const cleaned = cleanAgentPromptForSummary(prompt);
                if (cleaned.length > 0) {
                    return truncateText(cleaned, 80);
                }
            }

            const record = asRecord(input);
            const agentType = asString(record?.agent_type ?? record?.subagent_type ?? record?.type);
            return agentType ? `${agentType} agent` : null;
        };

        const getPatchFiles = (changes: unknown): string[] => {
            const record = asRecord(changes);
            if (!record) return [];
            return Object.keys(record).filter((file) => file.length > 0);
        };

        const summarizeFiles = (files: string[]): string | null => {
            if (files.length === 0) return null;
            const first = files[0] ?? '';
            const basename = first.split('/').filter(Boolean).pop() ?? first;
            return files.length > 1 ? `${basename} (+${files.length - 1})` : basename;
        };

        const summarizeDiffFiles = (diff: string): string | null => {
            const files: string[] = [];
            for (const line of diff.split('\n')) {
                if (!line.startsWith('+++ ')) continue;
                const file = line.replace(/^\+\+\+ (b\/)?/, '').trim();
                if (file && file !== '/dev/null') files.push(file);
            }
            return summarizeFiles([...new Set(files)]);
        };

        const displayMcpToolName = (toolName: string): string => {
            const match = toolName.match(/^mcp__(.+?)__(.+)$/);
            if (!match) return toolName;
            return `${match[1]}.${match[2]}`;
        };

        const permissionHandler = new CodexPermissionHandler(session.client, () => {
            const mode = session.getPermissionMode();
            return mode === 'default' || mode === 'read-only' || mode === 'safe-yolo' || mode === 'yolo'
                ? mode
                : undefined;
        }, {
            onRequest: ({ id, toolName, input }) => {
                if (toolName === 'request_user_input') {
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'request_user_input',
                        callId: id,
                        input,
                        id: randomUUID()
                    });
                    return;
                }

                const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
                const message = typeof inputRecord.message === 'string' ? inputRecord.message : undefined;
                const rawCommand = inputRecord.command;
                const command = Array.isArray(rawCommand)
                    ? rawCommand.filter((part): part is string => typeof part === 'string').join(' ')
                    : typeof rawCommand === 'string'
                        ? rawCommand
                        : undefined;
                const cwdValue = inputRecord.cwd;
                const cwd = typeof cwdValue === 'string' && cwdValue.trim().length > 0 ? cwdValue : undefined;

                session.sendAgentMessage({
                    type: 'tool-call',
                    name: 'CodexPermission',
                    callId: id,
                    input: {
                        tool: toolName,
                        message,
                        command,
                        cwd
                    },
                    id: randomUUID()
                });
            },
            onComplete: ({ id, toolName, decision, reason, approved, answers }) => {
                session.sendAgentMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: toolName === 'request_user_input'
                        ? { answers }
                        : {
                            decision,
                            reason
                        },
                    is_error: !approved,
                    id: randomUUID()
                });
            }
        });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendAgentMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendAgentMessage(message);
        });
        const mcpTitleByCallId = new Map<string, string>();
        const agentCardByAgentId = new Map<string, string>();
        const agentSummaryByCardId = new Map<string, string>();
        const agentSummaryByAgentId = new Map<string, string>();
        const agentStatusByAgentId = new Map<string, string>();
        const agentStartedAtByCardId = new Map<string, number>();
        const agentStartedAtByAgentId = new Map<string, number>();
        const pendingAgentStartCardIds = new Set<string>();
        const pendingAgentUpdatesByAgentId = new Map<string, Record<string, unknown>[]>();
        const pendingAgentTracesByAgentId = new Map<string, unknown[]>();
        const pendingAgentToolInputByCallId = new Map<string, { name: string; input: unknown }>();
        const childAgentRuntimeById = new Map<string, ChildAgentRuntime>();
        const lastAgentRunUpdateAtByAgentId = new Map<string, number>();
        const lastAgentRunUpdateSignatureByAgentId = new Map<string, string>();
        const pendingThrottledAgentUpdateByAgentId = new Map<string, {
            update: Record<string, unknown>;
            cardIdOverride?: string | null;
        }>();
        const pendingThrottledAgentUpdateTimerByAgentId = new Map<string, ReturnType<typeof setTimeout>>();
        const pendingAgentStartTimersByCardId = new Map<string, ReturnType<typeof setTimeout>>();
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;
        let readyAfterTurnTimer: ReturnType<typeof setTimeout> | null = null;
        let scheduleReadyAfterTurn: (() => void) | null = null;
        let clearReadyAfterTurnTimer: (() => void) | null = null;
        let turnInFlight = false;
        let allowAnonymousTerminalEvent = false;
        let invalidThreadId: string | null = null;
        let childAgentActivityInCurrentTurn = false;

        const isCodexAgentToolName = (toolName: string | null): boolean => {
            return toolName === 'spawn_agent'
                || toolName === 'send_input'
                || toolName === 'resume_agent'
                || toolName === 'wait_agent'
                || toolName === 'close_agent';
        };

        const isTerminalAgentRunStatus = (status: string | null | undefined): boolean => {
            return status === 'completed'
                || status === 'failed'
                || status === 'error'
                || status === 'canceled'
                || status === 'cancelled'
                || status === 'notFound'
                || status === 'not_found';
        };

        const isCloseAgentCleanupUpdate = (update: Record<string, unknown>): boolean => {
            const activityKind = asString(update.activityKind ?? update.activity_kind);
            if (activityKind === 'close_agent' || activityKind === 'closed') return true;
            return activityKind === 'canceled'
                && (asString(update.activity) === 'Closed' || asString(update.statusText ?? update.status_text) === 'Closed');
        };

        const isScopeSensitiveCodexEvent = (type: string): boolean => {
            return type === 'token_count' || type === 'context_compacted';
        };

        const hasKnownChildAgents = (): boolean => {
            if (childAgentActivityInCurrentTurn) return true;
            if (pendingAgentStartCardIds.size > 0) return true;
            for (const agentId of new Set([...agentCardByAgentId.keys(), ...childAgentRuntimeById.keys()])) {
                const status = agentStatusByAgentId.get(agentId);
                if (!isTerminalAgentRunStatus(status)) {
                    return true;
                }
            }
            return false;
        };

        const buildCodexEventScope = (
            threadId: string | null,
            role: 'parent' | 'child',
            agentId?: string | null
        ): Record<string, unknown> => ({
            role,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            ...(this.currentThreadId ? { parentThreadId: this.currentThreadId, parent_thread_id: this.currentThreadId } : {}),
            ...(agentId ? { agentId, agent_id: agentId } : {})
        });

        const addCodexEventScope = (
            event: Record<string, unknown>,
            role: 'parent' | 'child',
            threadId: string | null,
            agentId?: string | null
        ): Record<string, unknown> => ({
            ...event,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            scopeRole: role,
            scope_role: role,
            scope: buildCodexEventScope(threadId, role, agentId)
        });

        const extractAgentTargets = (input: unknown): string[] => {
            const record = asRecord(input);
            if (!record) return [];
            const targets = Array.isArray(record.targets)
                ? record.targets.filter((target): target is string => typeof target === 'string' && target.length > 0)
                : [];
            if (targets.length > 0) return targets;
            return [record.target, record.agent_id, record.agentId, record.id]
                .filter((target): target is string => typeof target === 'string' && target.length > 0);
        };

        const emitAgentRunEvent = (event: Record<string, unknown>): void => {
            const agentId = asString(event.agentId ?? event.agent_id);
            session.sendAgentMessage({
                ...(agentId ? addCodexEventScope(event, 'child', agentId, agentId) : event),
                id: randomUUID()
            });
        };

        const clearPendingAgentStart = (cardId: string): void => {
            const timer = pendingAgentStartTimersByCardId.get(cardId);
            if (timer) {
                clearTimeout(timer);
            }
            pendingAgentStartTimersByCardId.delete(cardId);
            pendingAgentStartCardIds.delete(cardId);
        };

        let failAgentStartCard = (_cardId: string, _error: unknown): void => {};

        const emitAgentRunStart = (cardId: string, input: unknown): void => {
            childAgentActivityInCurrentTurn = true;
            const startedAt = Date.now();
            agentStartedAtByCardId.set(cardId, startedAt);
            const summary = summarizeAgentInput(input);
            if (summary) {
                agentSummaryByCardId.set(cardId, summary);
            }
            clearPendingAgentStart(cardId);
            pendingAgentStartCardIds.add(cardId);
            const timer = setTimeout(() => {
                failAgentStartCard(
                    cardId,
                    `spawn_agent did not return an agent id within ${AGENT_RUN_START_TIMEOUT_MS / 1000}s`
                );
            }, AGENT_RUN_START_TIMEOUT_MS);
            timer.unref?.();
            pendingAgentStartTimersByCardId.set(cardId, timer);
            emitAgentRunEvent({
                type: 'agent-run-start',
                cardId,
                input,
                startedAt,
                status: 'starting',
                statusText: 'Starting',
                activity: 'Starting',
                activityKind: 'starting',
                ...(summary ? { summary } : {})
            });
        };

        const flushPendingAgentTraces = (agentId: string): void => {
            const traces = pendingAgentTracesByAgentId.get(agentId);
            if (!traces || traces.length === 0) return;
            pendingAgentTracesByAgentId.delete(agentId);
            for (const message of traces) {
                emitAgentRunEvent({
                    type: 'agent-run-trace',
                    agentId,
                    cardId: agentCardByAgentId.get(agentId),
                    ...(agentStartedAtByAgentId.has(agentId) ? { startedAt: agentStartedAtByAgentId.get(agentId) } : {}),
                    message
                });
            }
        };

        const linkAgentToCard = (agentId: string, cardId: string): void => {
            agentCardByAgentId.set(agentId, cardId);
            clearPendingAgentStart(cardId);
            const startedAt = agentStartedAtByCardId.get(cardId) ?? agentStartedAtByAgentId.get(agentId);
            if (startedAt) {
                agentStartedAtByCardId.set(cardId, startedAt);
                agentStartedAtByAgentId.set(agentId, startedAt);
            }
            const summary = agentSummaryByCardId.get(cardId);
            if (summary) {
                agentSummaryByAgentId.set(agentId, summary);
            }
            flushPendingAgentTraces(agentId);
        };

        const flushPendingAgentUpdates = (agentId: string): void => {
            const updates = pendingAgentUpdatesByAgentId.get(agentId);
            if (!updates || updates.length === 0) return;
            pendingAgentUpdatesByAgentId.delete(agentId);
            for (const update of updates) {
                emitAgentRunUpdate(agentId, update);
            }
        };

        const stableStringify = (value: unknown): string => {
            if (value === null || typeof value !== 'object') {
                return JSON.stringify(value);
            }
            if (Array.isArray(value)) {
                return `[${value.map(stableStringify).join(',')}]`;
            }
            const record = value as Record<string, unknown>;
            return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
        };

        const getAgentRunUpdateSignature = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): string => stableStringify({
            agentId,
            cardIdOverride: cardIdOverride ?? null,
            update
        });

        const cancelPendingThrottledAgentRunUpdate = (agentId: string): void => {
            const timer = pendingThrottledAgentUpdateTimerByAgentId.get(agentId);
            if (timer) {
                clearTimeout(timer);
            }
            pendingThrottledAgentUpdateTimerByAgentId.delete(agentId);
            pendingThrottledAgentUpdateByAgentId.delete(agentId);
        };

        const cancelAllPendingThrottledAgentRunUpdates = (): void => {
            for (const agentId of Array.from(pendingThrottledAgentUpdateTimerByAgentId.keys())) {
                cancelPendingThrottledAgentRunUpdate(agentId);
            }
            pendingThrottledAgentUpdateByAgentId.clear();
        };

        const flushPendingThrottledAgentRunUpdate = (agentId: string): void => {
            const pendingUpdate = pendingThrottledAgentUpdateByAgentId.get(agentId);
            pendingThrottledAgentUpdateTimerByAgentId.delete(agentId);
            pendingThrottledAgentUpdateByAgentId.delete(agentId);
            if (!pendingUpdate) return;
            emitAgentRunUpdateNow(agentId, pendingUpdate.update, pendingUpdate.cardIdOverride);
        };

        const scheduleThrottledAgentRunUpdate = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): void => {
            pendingThrottledAgentUpdateByAgentId.set(agentId, { update, cardIdOverride });
            if (pendingThrottledAgentUpdateTimerByAgentId.has(agentId)) {
                return;
            }

            const lastAt = lastAgentRunUpdateAtByAgentId.get(agentId) ?? 0;
            const delay = Math.max(AGENT_RUN_UPDATE_THROTTLE_MS - (Date.now() - lastAt), 0);
            const timer = setTimeout(() => {
                flushPendingThrottledAgentRunUpdate(agentId);
            }, delay);
            timer.unref?.();
            pendingThrottledAgentUpdateTimerByAgentId.set(agentId, timer);
        };

        const emitAgentRunUpdateNow = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): void => {
            const knownCardId = agentCardByAgentId.get(agentId);
            if (
                !cardIdOverride
                && !knownCardId
                && pendingAgentStartCardIds.size > 0
                && childAgentRuntimeById.has(agentId)
            ) {
                const updates = pendingAgentUpdatesByAgentId.get(agentId) ?? [];
                updates.push(update);
                pendingAgentUpdatesByAgentId.set(agentId, updates);
                return;
            }

            const cardId = cardIdOverride ?? knownCardId ?? `codex-agent:${agentId}`;
            if (!knownCardId) {
                agentCardByAgentId.set(agentId, cardId);
            }
            const startedAt = agentStartedAtByAgentId.get(agentId)
                ?? agentStartedAtByCardId.get(cardId)
                ?? Date.now();
            agentStartedAtByAgentId.set(agentId, startedAt);
            agentStartedAtByCardId.set(cardId, startedAt);
            const nextStatus = asString(update.status);
            const currentStatus = agentStatusByAgentId.get(agentId);
            const activityKind = asString(update.activityKind ?? update.activity_kind);
            if (
                isTerminalAgentRunStatus(currentStatus)
                && !isTerminalAgentRunStatus(nextStatus)
                && (activityKind === 'wait_agent' || activityKind === 'close_agent')
            ) {
                return;
            }
            if (
                childAgentRuntimeById.get(agentId)?.blockedNestedAgent
                && nextStatus !== 'failed'
                && nextStatus !== 'error'
            ) {
                return;
            }
            if (
                isTerminalAgentRunStatus(currentStatus)
                && nextStatus !== 'failed'
                && nextStatus !== 'error'
                && isCloseAgentCleanupUpdate(update)
            ) {
                return;
            }
            const nextSummary = asString(update.summary);
            if (nextSummary) {
                agentSummaryByAgentId.set(agentId, nextSummary);
                agentSummaryByCardId.set(cardId, nextSummary);
            }
            if (nextStatus) {
                agentStatusByAgentId.set(agentId, nextStatus);
            }
            const event = {
                type: 'agent-run-update',
                agentId,
                cardId,
                startedAt,
                ...(isTerminalAgentRunStatus(nextStatus) ? { completedAt: Date.now() } : {}),
                ...(agentSummaryByAgentId.has(agentId) ? { summary: agentSummaryByAgentId.get(agentId) } : {}),
                ...update
            };
            const signature = getAgentRunUpdateSignature(agentId, event, cardIdOverride);
            if (lastAgentRunUpdateSignatureByAgentId.get(agentId) === signature) {
                return;
            }
            lastAgentRunUpdateSignatureByAgentId.set(agentId, signature);
            lastAgentRunUpdateAtByAgentId.set(agentId, Date.now());
            emitAgentRunEvent(event);
            flushPendingAgentTraces(agentId);
        };

        const emitAgentRunUpdate = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): void => {
            const nextStatus = asString(update.status);
            const terminal = isTerminalAgentRunStatus(nextStatus);
            if (terminal) {
                cancelPendingThrottledAgentRunUpdate(agentId);
                emitAgentRunUpdateNow(agentId, update, cardIdOverride);
                return;
            }

            const activityKind = asString(update.activityKind ?? update.activity_kind);
            if (!activityKind || !THROTTLED_AGENT_RUN_ACTIVITY_KINDS.has(activityKind)) {
                emitAgentRunUpdateNow(agentId, update, cardIdOverride);
                return;
            }

            const lastAt = lastAgentRunUpdateAtByAgentId.get(agentId);
            if (lastAt === undefined || Date.now() - lastAt >= AGENT_RUN_UPDATE_THROTTLE_MS) {
                emitAgentRunUpdateNow(agentId, update, cardIdOverride);
                return;
            }

            scheduleThrottledAgentRunUpdate(agentId, update, cardIdOverride);
        };

        failAgentStartCard = (cardId: string, error: unknown): void => {
            if (!pendingAgentStartCardIds.has(cardId) && !pendingAgentStartTimersByCardId.has(cardId)) {
                return;
            }

            const agentId = `spawn-error:${cardId}`;
            linkAgentToCard(agentId, cardId);
            emitAgentRunUpdate(agentId, {
                status: 'failed',
                statusText: 'Failed to start',
                activity: formatActivity('Failed to start', previewText(error)),
                activityKind: 'failed',
                error
            }, cardId);
        };

        const failPendingAgentStarts = (error: unknown): void => {
            for (const cardId of Array.from(pendingAgentStartCardIds)) {
                failAgentStartCard(cardId, error);
            }
        };

        const emitAgentRunTraceMessage = (agentId: string, message: unknown): void => {
            const cardId = agentCardByAgentId.get(agentId);
            if (!cardId) {
                const traces = pendingAgentTracesByAgentId.get(agentId) ?? [];
                traces.push(message);
                pendingAgentTracesByAgentId.set(agentId, traces);
                return;
            }
            emitAgentRunEvent({
                type: 'agent-run-trace',
                agentId,
                cardId,
                ...(agentStartedAtByAgentId.has(agentId) ? { startedAt: agentStartedAtByAgentId.get(agentId) } : {}),
                message
            });
        };

        const getChildRuntime = (agentId: string) => {
            const existing = childAgentRuntimeById.get(agentId);
            if (existing) return existing;
            const runtime = {
                reasoningProcessor: new ReasoningProcessor((message) => {
                    emitAgentRunTraceMessage(agentId, message);
                }),
                diffProcessor: new DiffProcessor((message) => {
                    emitAgentRunTraceMessage(agentId, message);
                }),
                activeToolsByCallId: new Map(),
                pendingTitleByCallId: new Map(),
                reasoningPreview: '',
                blockedNestedAgent: false
            };
            childAgentRuntimeById.set(agentId, runtime);
            return runtime;
        };

        const normalizeAgentStatusUpdate = (value: unknown): Record<string, unknown> => {
            if (typeof value === 'string') {
                const activity = formatActivity('Completed', previewText(value));
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity,
                    activityKind: 'completed',
                    result: value
                };
            }

            const record = asRecord(value);
            if (!record) {
                const activity = formatActivity('Completed', previewText(value));
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity,
                    activityKind: 'completed',
                    result: value
                };
            }

            const completed = asString(record.completed);
            if (completed) {
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity: formatActivity('Completed', completed),
                    activityKind: 'completed',
                    result: completed
                };
            }
            const failed = asString(record.failed ?? record.error);
            if (failed) {
                return {
                    status: 'failed',
                    statusText: 'Failed',
                    activity: formatActivity('Failed', failed),
                    activityKind: 'failed',
                    error: failed
                };
            }
            const canceled = asString(record.canceled ?? record.cancelled);
            if (canceled) {
                return {
                    status: 'canceled',
                    statusText: 'Canceled',
                    activity: formatActivity('Canceled', canceled),
                    activityKind: 'canceled',
                    error: canceled
                };
            }

            const rawStatus = asString(record.status ?? record.state);
            if (rawStatus === 'notFound' || rawStatus === 'not_found') {
                const error = record.message ?? record.error ?? value;
                return {
                    status: 'failed',
                    statusText: 'Not found',
                    activity: formatActivity('Agent not found', previewText(error)),
                    activityKind: 'not_found',
                    error
                };
            }
            if (rawStatus === 'completed') {
                const result = record.message ?? record.output ?? value;
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity: formatActivity('Completed', previewText(result)),
                    activityKind: 'completed',
                    result
                };
            }
            if (rawStatus === 'failed' || rawStatus === 'error') {
                const error = record.message ?? record.error ?? value;
                return {
                    status: 'failed',
                    statusText: 'Failed',
                    activity: formatActivity('Failed', previewText(error)),
                    activityKind: 'failed',
                    error
                };
            }
            if (rawStatus === 'canceled' || rawStatus === 'cancelled') {
                const error = record.message ?? record.error ?? value;
                return {
                    status: 'canceled',
                    statusText: 'Canceled',
                    activity: formatActivity('Canceled', previewText(error)),
                    activityKind: 'canceled',
                    error
                };
            }

            return {
                status: rawStatus ?? 'running',
                statusText: rawStatus ?? 'Running',
                activity: formatActivity(rawStatus ?? 'Running', previewText(record.message ?? record.output ?? value)),
                activityKind: rawStatus ?? 'running',
                result: value
            };
        };

        const isAgentNotFoundStatusUpdate = (update: Record<string, unknown>): boolean => {
            const status = asString(update.status);
            const activityKind = asString(update.activityKind ?? update.activity_kind);
            return status === 'notFound'
                || status === 'not_found'
                || activityKind === 'not_found';
        };

        const handleAgentToolEnd = (callId: string, name: string, output: unknown, isError: boolean): void => {
            const pending = pendingAgentToolInputByCallId.get(callId);
            pendingAgentToolInputByCallId.delete(callId);

            if (name === 'spawn_agent') {
                childAgentActivityInCurrentTurn = true;
                const outputRecord = asRecord(output);
                const agentsStates = asRecord(outputRecord?.agentsStates ?? outputRecord?.agents_states);
                const agentIdsFromState = agentsStates ? Object.keys(agentsStates) : [];
                const agentId = asString(outputRecord?.agent_id ?? outputRecord?.agentId ?? outputRecord?.id)
                    ?? (agentIdsFromState.length === 1 ? agentIdsFromState[0] : null)
                    ?? extractAgentTargets(pending?.input).at(0);
                if (!agentId) {
                    const detail = isError
                        ? output
                        : {
                            message: 'spawn_agent completed without returning an agent id',
                            output
                        };
                    failAgentStartCard(callId, detail);
                    return;
                }
                linkAgentToCard(agentId, callId);
                emitAgentRunUpdate(agentId, {
                    status: isError ? 'failed' : 'running',
                    statusText: isError ? 'Failed to start' : 'Running',
                    activity: isError ? formatActivity('Failed to start', previewText(output)) : 'Started',
                    activityKind: isError ? 'failed' : 'running',
                    ...(isError ? { error: output } : { spawnResult: output })
                }, callId);
                flushPendingAgentUpdates(agentId);
                return;
            }

            if (name === 'wait_agent') {
                childAgentActivityInCurrentTurn = true;
                const outputRecord = asRecord(output);
                const statusMap = asRecord(outputRecord?.status) ?? {};
                for (const [agentId, statusValue] of Object.entries(statusMap)) {
                    const update = normalizeAgentStatusUpdate(statusValue);
                    if (!agentCardByAgentId.has(agentId) && isAgentNotFoundStatusUpdate(update)) {
                        continue;
                    }
                    emitAgentRunUpdate(agentId, update);
                }
                return;
            }

            if (name === 'send_input' || name === 'resume_agent') {
                childAgentActivityInCurrentTurn = true;
                const outputRecord = asRecord(output);
                const targets = Array.from(new Set([
                    ...extractAgentTargets(pending?.input),
                    ...extractAgentTargets(outputRecord)
                ]));
                const label = name === 'send_input' ? 'Send input' : 'Resume';
                const successActivity = name === 'send_input' ? 'Input sent' : 'Resumed';
                const errorDetail = asString(outputRecord?.error ?? outputRecord?.message) ?? output;

                for (const agentId of targets) {
                    if (!agentCardByAgentId.has(agentId)) continue;
                    emitAgentRunUpdate(agentId, {
                        status: isError ? 'failed' : 'running',
                        statusText: isError ? `${label} failed` : successActivity,
                        activity: isError ? formatActivity(`${label} failed`, previewText(errorDetail)) : successActivity,
                        activityKind: isError ? 'failed' : name,
                        ...(isError ? { error: output } : { result: output })
                    });
                }
                return;
            }

            if (name === 'close_agent') {
                const outputRecord = asRecord(output);
                const agentId = asString(outputRecord?.agent_id ?? outputRecord?.agentId)
                    ?? extractAgentTargets(pending?.input).at(0);
                if (!agentId) return;
                emitAgentRunUpdate(agentId, {
                    status: isError ? 'failed' : 'completed',
                    statusText: isError ? 'Close failed' : 'Closed',
                    activity: isError ? formatActivity('Close failed', previewText(output)) : 'Closed',
                    activityKind: isError ? 'failed' : 'closed',
                    ...(isError ? { error: output } : { result: output })
                });
                return;
            }
        };

        const handleChildCodexEvent = (agentId: string, msg: Record<string, unknown>): void => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            childAgentActivityInCurrentTurn = true;
            const runtime = getChildRuntime(agentId);
            const isChildTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';
            if (runtime.blockedNestedAgent && !isChildTerminalEvent) {
                return;
            }
            const updateActivity = (
                activity: string,
                activityKind: string,
                extra?: Record<string, unknown>
            ): void => {
                emitAgentRunUpdate(agentId, {
                    status: 'running',
                    statusText: activity,
                    activity,
                    activityKind,
                    ...extra
                });
            };

            if (msgType === 'token_count') {
                return;
            }

            if (msgType === 'context_compacted') {
                emitAgentRunTraceMessage(agentId, {
                    type: 'context_compacted',
                    id: randomUUID()
                });
                updateActivity('Context compacted', 'compact');
                return;
            }

            if (msgType === 'task_started') {
                runtime.reasoningPreview = '';
                updateActivity('Starting task', 'starting');
                return;
            }
            if (msgType === 'agent_reasoning_section_break') {
                runtime.reasoningProcessor.handleSectionBreak();
                runtime.reasoningPreview = '';
                updateActivity('Thinking', 'thinking');
                return;
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    runtime.reasoningProcessor.processDelta(delta);
                    runtime.reasoningPreview = truncateText(`${runtime.reasoningPreview}${delta}`, 160);
                }
                updateActivity(formatActivity('Thinking', runtime.reasoningPreview || null), 'thinking');
                return;
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    runtime.reasoningProcessor.complete(text);
                    runtime.reasoningPreview = truncateText(text, 160);
                }
                updateActivity(formatActivity('Thinking', runtime.reasoningPreview || null), 'thinking');
                return;
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    emitAgentRunTraceMessage(agentId, {
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
                updateActivity(formatActivity('Writing', message), 'writing');
                return;
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId,
                        input: inputs,
                        id: randomUUID()
                    });
                    const command = normalizeCommand(inputs.command) ?? 'command';
                    runtime.activeToolsByCallId.set(callId, {
                        name: 'CodexBash',
                        label: command,
                        activity: formatActivity('Running command', command),
                        activityKind: 'running-command'
                    });
                    emitAgentRunUpdate(agentId, {
                        status: 'running',
                        statusText: formatActivity('Running command', command),
                        activity: formatActivity('Running command', command),
                        activityKind: 'running-command'
                    });
                }
                return;
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;
                    output.stdout = output.output;
                    delete output.output;
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: Boolean(output.error),
                        id: randomUUID()
                    });
                    const label = activeTool?.label ?? normalizeCommand(output.command) ?? 'command';
                    const isError = Boolean(output.error);
                    updateActivity(
                        formatActivity(isError ? 'Command failed' : 'Command finished', label),
                        isError ? 'command-failed' : 'command-completed'
                    );
                }
                return;
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const changes = asRecord(msg.changes) ?? {};
                    const files = getPatchFiles(changes);
                    const fileSummary = summarizeFiles(files);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        id: randomUUID()
                    });
                    runtime.activeToolsByCallId.set(callId, {
                        name: 'CodexPatch',
                        label: fileSummary ?? 'files',
                        activity: formatActivity('Editing files', fileSummary),
                        activityKind: 'editing'
                    });
                    updateActivity(formatActivity('Editing files', fileSummary), 'editing');
                }
                return;
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output: { stdout, stderr, success },
                        is_error: !success,
                        id: randomUUID()
                    });
                    updateActivity(
                        formatActivity(success ? 'Files edited' : 'Edit failed', activeTool?.label ?? previewText(stderr ?? stdout)),
                        success ? 'edited' : 'edit-failed'
                    );
                }
                return;
            }
            if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const invocation = asRecord(msg.invocation) ?? {};
                const name = buildMcpToolName(
                    invocation.server ?? invocation.server_name ?? msg.server,
                    invocation.tool ?? invocation.tool_name ?? msg.tool
                );
                if (callId && name) {
                    const input = invocation.arguments ?? invocation.input ?? msg.arguments ?? msg.input ?? {};
                    const inputRecord = asRecord(input);
                    const requestedTitle = inputRecord ? asString(inputRecord.title) : null;
                    if (isHapiChangeTitleToolName(name) && requestedTitle) {
                        runtime.pendingTitleByCallId.set(callId, requestedTitle);
                    }
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name,
                        callId,
                        input,
                        id: randomUUID()
                    });
                    const label = displayMcpToolName(name);
                    runtime.activeToolsByCallId.set(callId, {
                        name,
                        label,
                        activity: formatActivity('Calling tool', label),
                        activityKind: 'tool'
                    });
                    updateActivity(formatActivity('Calling tool', label), 'tool');
                }
                return;
            }
            if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const rawResult = msg.result;
                    let output = rawResult;
                    let isError = false;
                    const resultRecord = asRecord(rawResult);
                    if (resultRecord) {
                        if (Object.prototype.hasOwnProperty.call(resultRecord, 'Ok')) {
                            output = resultRecord.Ok;
                        } else if (Object.prototype.hasOwnProperty.call(resultRecord, 'Err')) {
                            output = resultRecord.Err;
                            isError = true;
                        }
                    }
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: isError,
                        id: randomUUID()
                    });
                    const title = runtime.pendingTitleByCallId.get(callId);
                    runtime.pendingTitleByCallId.delete(callId);
                    updateActivity(
                        formatActivity(isError ? 'Tool failed' : 'Tool finished', activeTool?.label ?? displayMcpToolName(asString(msg.tool) ?? 'tool')),
                        isError ? 'tool-failed' : 'tool-completed',
                        !isError && title ? { summary: title } : undefined
                    );
                }
                return;
            }
            if (msgType === 'codex_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name);
                if (callId && name) {
                    if (isCodexAgentToolName(name)) {
                        const error = 'Nested agent calls are disabled for child agents.';
                        runtime.blockedNestedAgent = true;
                        emitAgentRunTraceMessage(agentId, {
                            type: 'tool-call',
                            name,
                            callId,
                            input: msg.input ?? {},
                            id: randomUUID()
                        });
                        emitAgentRunTraceMessage(agentId, {
                            type: 'tool-call-result',
                            callId,
                            output: error,
                            is_error: true,
                            id: randomUUID()
                        });
                        emitAgentRunUpdate(agentId, {
                            status: 'failed',
                            statusText: 'Failed',
                            activity: formatActivity('Failed', error),
                            activityKind: 'failed',
                            error
                        });
                        return;
                    }
                    const activity = formatActivity('Running tool', name);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name,
                        callId,
                        input: msg.input ?? {},
                        id: randomUUID()
                    });
                    runtime.activeToolsByCallId.set(callId, {
                        name,
                        label: name,
                        activity,
                        activityKind: 'tool'
                    });
                    updateActivity(activity, 'tool');
                }
                return;
            }
            if (msgType === 'codex_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const isError = Boolean(msg.is_error ?? msg.isError);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output: msg.output,
                        is_error: isError,
                        id: randomUUID()
                    });
                    updateActivity(
                        formatActivity(isError ? 'Tool failed' : 'Tool finished', activeTool?.label ?? 'tool'),
                        isError ? 'tool-failed' : 'tool-completed'
                    );
                }
                return;
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    runtime.diffProcessor.processDiff(diff);
                    updateActivity(formatActivity('Editing files', summarizeDiffFiles(diff)), 'editing');
                }
                return;
            }
            if (isChildTerminalEvent) {
                runtime.reasoningProcessor.reset();
                runtime.diffProcessor.reset();
                runtime.activeToolsByCallId.clear();
                runtime.pendingTitleByCallId.clear();
                runtime.reasoningPreview = '';
                if (msgType === 'task_failed') {
                    const error = asString(msg.error) ?? 'Task failed';
                    emitAgentRunUpdate(agentId, {
                        status: 'failed',
                        statusText: 'Failed',
                        activity: formatActivity('Failed', error),
                        activityKind: 'failed',
                        error
                    });
                } else if (msgType === 'turn_aborted') {
                    emitAgentRunUpdate(agentId, {
                        status: 'canceled',
                        statusText: 'Canceled',
                        activity: 'Canceled',
                        activityKind: 'canceled'
                    });
                } else {
                    emitAgentRunUpdate(agentId, {
                        status: 'completed',
                        statusText: 'Completed',
                        activity: 'Completed',
                        activityKind: 'completed'
                    });
                }
            }
        };

        let activeMessage: QueuedMessage | null = null;
        let sameThreadRetryAttempt = 0;
        let sameThreadCompactAttempt = 0;
        let recoveryInFlight = false;
        let compactRecovery: {
            threadId: string;
            message: QueuedMessage;
            timeout: ReturnType<typeof setTimeout> | null;
        } | null = null;
        let loopWakeWaiter: (() => void) | null = null;

        const wakeLoop = () => {
            const waiter = loopWakeWaiter;
            if (!waiter) {
                return;
            }
            loopWakeWaiter = null;
            waiter();
        };

        const waitForTurnOrRecovery = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
            if (!turnInFlight && !recoveryInFlight) {
                resolve();
                return;
            }

            const finish = () => {
                if (loopWakeWaiter === finish) {
                    loopWakeWaiter = null;
                }
                signal.removeEventListener('abort', finish);
                resolve();
            };

            loopWakeWaiter = finish;
            signal.addEventListener('abort', finish, { once: true });
        });

        const clearCompactRecovery = (recovery: typeof compactRecovery) => {
            if (!recovery) {
                return;
            }
            if (recovery.timeout) {
                clearTimeout(recovery.timeout);
            }
            if (compactRecovery === recovery) {
                compactRecovery = null;
            }
            recoveryInFlight = false;
            wakeLoop();
        };

        const failCompactRecovery = (recovery: typeof compactRecovery, message: string) => {
            if (!recovery || compactRecovery !== recovery) {
                return;
            }
            logger.warn(`[Codex] ${message}`);
            messageBuffer.addMessage(message, 'status');
            session.sendSessionEvent({ type: 'message', message });
            activeMessage = null;
            clearCompactRecovery(recovery);
        };

        const completeCompactRecovery = (threadId: string | null) => {
            const recovery = compactRecovery;
            if (!recovery) {
                return false;
            }
            if (!threadId || threadId !== recovery.threadId) {
                return false;
            }
            if (!this.shouldExit && this.currentThreadId === recovery.threadId) {
                pending = recovery.message;
                const message = 'Context compacted; retrying same conversation';
                messageBuffer.addMessage(message, 'status');
                session.sendSessionEvent({ type: 'message', message });
            }
            clearCompactRecovery(recovery);
            return true;
        };

        const beginCompactRecovery = (threadId: string, messageToRetry: QueuedMessage, error: string | null) => {
            sameThreadCompactAttempt += 1;
            recoveryInFlight = true;
            const recovery = {
                threadId,
                message: messageToRetry,
                timeout: null as ReturnType<typeof setTimeout> | null
            };
            compactRecovery = recovery;
            recovery.timeout = setTimeout(() => {
                failCompactRecovery(
                    recovery,
                    'Task failed: context window overflow and same-conversation compact timed out'
                );
            }, SAME_THREAD_COMPACT_TIMEOUT_MS);
            recovery.timeout.unref?.();

            logger.debug(
                `[Codex] Compacting retryable context failure on same thread ` +
                `(attempt ${sameThreadCompactAttempt}/${SAME_THREAD_MAX_COMPACT_RETRIES}): ${error ?? 'unknown error'}`
            );
            void appServerClient.compactThread({ threadId }, { signal: this.abortController.signal })
                .catch((compactError) => {
                    logger.warn('[Codex] Failed to start app-server thread compact before retry:', compactError);
                    failCompactRecovery(
                        recovery,
                        'Task failed: context window overflow and same-conversation compact failed'
                    );
                });
        };

        const handleCodexEvent = (msg: Record<string, unknown>) => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            const eventTurnId = asString(msg.turn_id ?? msg.turnId);
            const eventThreadId = asString(msg.thread_id ?? msg.threadId);
            const isTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    if (!this.currentThreadId || this.currentThreadId === threadId) {
                        this.currentThreadId = threadId;
                        session.onSessionFound(threadId);
                    } else {
                        logger.debug(
                            `[Codex] Ignoring thread_started for non-active thread; ` +
                            `eventThreadId=${threadId}, activeThread=${this.currentThreadId}`
                        );
                    }
                }
                return;
            }

            if (msgType === 'thread_compacted') {
                completeCompactRecovery(eventThreadId);
                return;
            }

            if (eventThreadId && this.currentThreadId && eventThreadId !== this.currentThreadId) {
                logger.debug(
                    `[Codex] Routing event from non-active thread into agent trace; ` +
                    `type=${msgType}, eventThreadId=${eventThreadId}, activeThread=${this.currentThreadId}`
                );
                handleChildCodexEvent(eventThreadId, msg);
                return;
            }

            if (!eventThreadId && this.currentThreadId && isScopeSensitiveCodexEvent(msgType) && hasKnownChildAgents()) {
                logger.debug(
                    `[Codex] Dropping unscoped scope-sensitive event while child agents are active; ` +
                    `type=${msgType}, activeThread=${this.currentThreadId}`
                );
                return;
            }

            if (msgType === 'task_started') {
                const turnId = eventTurnId;
                if (turnId) {
                    this.currentTurnId = turnId;
                    allowAnonymousTerminalEvent = false;
                } else if (!this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
            }

            const isThreadStatusFailure = msgType === 'task_failed' && msg.terminal_source === 'thread_status';
            const error = msgType === 'task_failed' ? asString(msg.error) : null;
            const shouldCompactAndRetrySameThread = msgType === 'task_failed'
                && isContextCompactRetryableCodexError(error)
                && Boolean(activeMessage)
                && Boolean(this.currentThreadId)
                && sameThreadCompactAttempt < SAME_THREAD_MAX_COMPACT_RETRIES;
            const shouldRetrySameThread = msgType === 'task_failed'
                && !shouldCompactAndRetrySameThread
                && isSameThreadRetryableCodexError(error)
                && Boolean(activeMessage)
                && Boolean(this.currentThreadId)
                && sameThreadRetryAttempt < SAME_THREAD_MAX_RETRIES;

            if (isTerminalEvent) {
                if (shouldIgnoreTerminalEvent({
                    eventTurnId,
                    currentTurnId: this.currentTurnId,
                    turnInFlight,
                    allowAnonymousTerminalEvent,
                    eventThreadId,
                    currentThreadId: this.currentThreadId,
                    allowMatchingThreadIdTerminalEvent: msg.terminal_source === 'thread_status'
                })) {
                    logger.debug(
                        `[Codex] Ignoring terminal event ${msgType} without matching turn context; ` +
                        `eventTurnId=${eventTurnId ?? 'none'}, activeTurn=${this.currentTurnId ?? 'none'}, ` +
                        `eventThreadId=${eventThreadId ?? 'none'}, activeThread=${this.currentThreadId ?? 'none'}, ` +
                        `turnInFlight=${turnInFlight}, allowAnonymous=${allowAnonymousTerminalEvent}`
                    );
                    return;
                }
                if (shouldCompactAndRetrySameThread) {
                    const threadId = this.currentThreadId;
                    const messageToRetry = activeMessage;
                    if (threadId && messageToRetry) {
                        beginCompactRecovery(threadId, messageToRetry, error);
                    }
                } else if (shouldRetrySameThread) {
                    sameThreadRetryAttempt += 1;
                    pending = activeMessage;
                    logger.debug(
                        `[Codex] Retrying retryable failure on same thread ` +
                        `(attempt ${sameThreadRetryAttempt}/${SAME_THREAD_MAX_RETRIES}): ${error ?? 'unknown error'}`
                    );
                }
                this.currentTurnId = null;
                allowAnonymousTerminalEvent = false;
                if (isThreadStatusFailure && !shouldRetrySameThread && !shouldCompactAndRetrySameThread) {
                    logger.warn(`[Codex] Thread-level failure on ${eventThreadId ?? this.currentThreadId ?? 'unknown thread'}; preserving same conversation`);
                }
            }

            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    messageBuffer.addMessage(message, 'assistant');
                }
            } else if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    messageBuffer.addMessage(`[Thinking] ${text.substring(0, 100)}...`, 'system');
                }
            } else if (msgType === 'exec_command_begin') {
                const command = normalizeCommand(msg.command) ?? 'command';
                messageBuffer.addMessage(`Executing: ${command}`, 'tool');
            } else if (msgType === 'exec_command_end') {
                const output = msg.output ?? msg.error ?? 'Command completed';
                const outputText = formatOutputPreview(output);
                const truncatedOutput = outputText.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncatedOutput}${outputText.length > 200 ? '...' : ''}`,
                    'result'
                );
            } else if (msgType === 'task_started') {
                messageBuffer.addMessage('Starting task...', 'status');
            } else if (msgType === 'task_complete') {
                messageBuffer.addMessage('Task completed', 'status');
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
            } else if (msgType === 'task_failed') {
                if (shouldCompactAndRetrySameThread) {
                    const retryMessage = error
                        ? `Task failed: ${error}; compacting same conversation before retry (${sameThreadCompactAttempt}/${SAME_THREAD_MAX_COMPACT_RETRIES})`
                        : `Task failed; compacting same conversation before retry (${sameThreadCompactAttempt}/${SAME_THREAD_MAX_COMPACT_RETRIES})`;
                    messageBuffer.addMessage(retryMessage, 'status');
                    session.sendSessionEvent({ type: 'message', message: retryMessage });
                } else if (shouldRetrySameThread) {
                    const retryMessage = error
                        ? `Task failed: ${error}; retrying same conversation (${sameThreadRetryAttempt}/${SAME_THREAD_MAX_RETRIES})`
                        : `Task failed; retrying same conversation (${sameThreadRetryAttempt}/${SAME_THREAD_MAX_RETRIES})`;
                    messageBuffer.addMessage(retryMessage, 'status');
                    session.sendSessionEvent({ type: 'message', message: retryMessage });
                } else {
                    const message = error ? `Task failed: ${error}` : 'Task failed';
                    messageBuffer.addMessage(message, 'status');
                    session.sendSessionEvent({ type: 'message', message });
                }
            }

            if (msgType === 'task_started') {
                clearReadyAfterTurnTimer?.();
                turnInFlight = true;
                if (!eventTurnId && !this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (isTerminalEvent) {
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                diffProcessor.reset();
                appServerEventConverter.reset();
                mcpTitleByCallId.clear();
                pendingAgentToolInputByCallId.clear();
                childAgentActivityInCurrentTurn = false;
                wakeLoop();
            }

            if (isTerminalEvent && !turnInFlight) {
                scheduleReadyAfterTurn?.();
            } else if (readyAfterTurnTimer && msgType !== 'task_started') {
                scheduleReadyAfterTurn?.();
            }

            if (msgType === 'task_complete') {
                sameThreadRetryAttempt = 0;
                sameThreadCompactAttempt = 0;
                recoveryInFlight = false;
                clearCompactRecovery(compactRecovery);
                activeMessage = null;
            }

            if (msgType === 'agent_reasoning_section_break') {
                reasoningProcessor.handleSectionBreak();
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    reasoningProcessor.processDelta(delta);
                }
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    reasoningProcessor.complete(text);
                }
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    session.sendAgentMessage({
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: callId,
                        input: inputs,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;
                    output.stdout = output.output;
                    delete output.output;

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'token_count') {
                const threadId = eventThreadId ?? this.currentThreadId;
                session.sendAgentMessage({
                    ...addCodexEventScope(msg, 'parent', threadId),
                    id: randomUUID()
                });
            }
            if (msgType === 'context_compacted') {
                const threadId = eventThreadId ?? this.currentThreadId;
                session.sendAgentMessage({
                    ...addCodexEventScope({
                        type: 'context_compacted',
                        ...(eventTurnId ? { turn_id: eventTurnId } : {})
                    }, 'parent', threadId),
                    id: randomUUID()
                });
            }
            if (msgType === 'plan_update') {
                session.sendAgentMessage({
                    type: 'tool-call',
                    name: 'update_plan',
                    callId: 'codex-plan-state',
                    input: {
                        plan: Array.isArray(msg.plan) ? msg.plan : [],
                        source: 'codex'
                    },
                    id: randomUUID()
                });
                session.sendAgentMessage({
                    type: 'tool-call-result',
                    callId: 'codex-plan-state',
                    output: {
                        plan: Array.isArray(msg.plan) ? msg.plan : [],
                        source: 'codex',
                        status: 'updated'
                    },
                    id: randomUUID()
                });
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const changes = asRecord(msg.changes) ?? {};
                    const changeCount = Object.keys(changes).length;
                    const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                    messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId: callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);

                    if (success) {
                        const message = stdout || 'Files modified successfully';
                        messageBuffer.addMessage(message.substring(0, 200), 'result');
                    } else {
                        const errorMsg = stderr || 'Failed to modify files';
                        messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                    }

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: {
                            stdout,
                            stderr,
                            success
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const invocation = asRecord(msg.invocation) ?? {};
                const name = buildMcpToolName(
                    invocation.server ?? invocation.server_name ?? msg.server,
                    invocation.tool ?? invocation.tool_name ?? msg.tool
                );
                if (callId && name) {
                    const input = invocation.arguments ?? invocation.input ?? msg.arguments ?? msg.input ?? {};
                    const inputRecord = asRecord(input);
                    const requestedTitle = inputRecord ? asString(inputRecord.title) : null;
                    if (isHapiChangeTitleToolName(name) && requestedTitle) {
                        mcpTitleByCallId.set(callId, requestedTitle);
                    }
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                const rawResult = msg.result;
                let output = rawResult;
                let isError = false;
                const resultRecord = asRecord(rawResult);
                if (resultRecord) {
                    if (Object.prototype.hasOwnProperty.call(resultRecord, 'Ok')) {
                        output = resultRecord.Ok;
                    } else if (Object.prototype.hasOwnProperty.call(resultRecord, 'Err')) {
                        output = resultRecord.Err;
                        isError = true;
                    }
                }

                if (callId) {
                    const title = mcpTitleByCallId.get(callId);
                    mcpTitleByCallId.delete(callId);
                    if (!isError && title) {
                        sendTitleSummary(title);
                    }

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: isError,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name);
                if (callId && name) {
                    if (isCodexAgentToolName(name)) {
                            const input = msg.input ?? {};
                            pendingAgentToolInputByCallId.set(callId, { name, input });
                            if (name === 'spawn_agent') {
                                emitAgentRunStart(callId, input);
                            } else {
                                for (const agentId of extractAgentTargets(input)) {
                                    if (!agentCardByAgentId.has(agentId)) {
                                        continue;
                                    }
                                    const activity = name === 'wait_agent'
                                        ? 'Waiting for agent'
                                        : name === 'send_input'
                                            ? 'Sending input'
                                        : name === 'resume_agent'
                                            ? 'Resuming agent'
                                            : name === 'close_agent'
                                                ? 'Closing agent'
                                                : 'Running agent tool';
                                emitAgentRunUpdate(agentId, {
                                    status: 'running',
                                    statusText: activity,
                                    activity,
                                    activityKind: name
                                });
                            }
                        }
                        return;
                    }
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input: msg.input ?? {},
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name) ?? pendingAgentToolInputByCallId.get(callId ?? '')?.name ?? null;
                if (callId) {
                    if (name && isCodexAgentToolName(name)) {
                        handleAgentToolEnd(callId, name, msg.output, Boolean(msg.is_error ?? msg.isError));
                        return;
                    }
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: msg.output,
                        is_error: Boolean(msg.is_error ?? msg.isError),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        registerAppServerPermissionHandlers({
            client: appServerClient,
            permissionHandler,
            onUserInputRequest: async ({ id, input }) => {
                try {
                    const answers = await permissionHandler.handleUserInputRequest(id, input);
                    return {
                        decision: 'accept',
                        answers
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`[Codex] request_user_input failed: ${message}`);
                    return {
                        decision: 'cancel'
                    };
                }
            }
        });

        appServerClient.setNotificationHandler((method, params) => {
            const events = appServerEventConverter.handleNotification(method, params);
            for (const event of events) {
                const eventRecord = asRecord(event) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            }
        });

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            // In app-server/collab mode, child agents share this MCP bridge.
            // If the MCP handler writes the title directly, child title calls
            // leak into the parent HAPI session. Defer the side effect until
            // parent-thread mcp_tool_call_end reaches this launcher; child
            // events are filtered above by thread id.
            emitTitleSummary: false
        });
        this.happyServer = happyServer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        function logActiveHandles(tag: string) {
            if (!process.env.DEBUG) return;
            const anyProc: any = process as any;
            const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
            const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
            logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
            try {
                const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
                logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
            } catch {}
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        await appServerClient.connect();
        await appServerClient.initialize({
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        let hasThread = false;
        let pending: QueuedMessage | null = null;

        clearReadyAfterTurnTimer = () => {
            if (!readyAfterTurnTimer) {
                return;
            }
            clearTimeout(readyAfterTurnTimer);
            readyAfterTurnTimer = null;
        };

        scheduleReadyAfterTurn = () => {
            clearReadyAfterTurnTimer?.();
            readyAfterTurnTimer = setTimeout(() => {
                readyAfterTurnTimer = null;
                emitReadyIfIdle({
                    pending: pending ?? (recoveryInFlight ? activeMessage : null),
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
            }, 120);
            readyAfterTurnTimer.unref?.();
        };

        const sendVisibleStatus = (message: string) => {
            messageBuffer.addMessage(message, 'status');
            session.sendSessionEvent({ type: 'message', message });
        };

        const resetCurrentTurnState = () => {
            turnInFlight = false;
            allowAnonymousTerminalEvent = false;
            this.currentTurnId = null;
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            appServerEventConverter.reset();
            session.onThinkingChange(false);
        };

        const interruptActiveTurn = async () => {
            const threadId = this.currentThreadId;
            const turnId = this.currentTurnId;
            if (!threadId || !turnId) {
                return;
            }

            try {
                await appServerClient.interruptTurn({ threadId, turnId });
            } catch (error) {
                logger.debug('[Codex] Error interrupting app-server turn for slash command:', error);
            }
        };

        const resumeExistingThreadForCompact = async (mode: EnhancedMode): Promise<string | null> => {
            if (this.currentThreadId && this.currentThreadId !== invalidThreadId) {
                hasThread = true;
                return this.currentThreadId;
            }

            const resumeCandidate = session.sessionId && session.sessionId !== invalidThreadId
                ? session.sessionId
                : null;
            if (!resumeCandidate) {
                return null;
            }

            const threadParams = buildThreadStartParams({
                cwd: session.path,
                mode,
                mcpServers,
                cliOverrides: session.codexCliOverrides
            });

            try {
                const resumeResponse = await appServerClient.resumeThread({
                    threadId: resumeCandidate,
                    ...threadParams
                }, {
                    signal: this.abortController.signal
                });
                const resumeRecord = asRecord(resumeResponse);
                const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                const threadId = asString(resumeThread?.id) ?? resumeCandidate;
                applyResolvedModel(resumeRecord?.model);
                this.currentThreadId = threadId;
                session.onSessionFound(threadId);
                hasThread = true;
                logger.debug(`[Codex] Resumed app-server thread ${threadId} for /compact`);
                return threadId;
            } catch (error) {
                logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate} for /compact`, error);
                return null;
            }
        };

        const handleSpecialCommand = async (message: QueuedMessage): Promise<boolean> => {
            const specialCommand = parseCodexSpecialCommand(message.message);
            if (!specialCommand.type) {
                return false;
            }

            if (specialCommand.type === 'invalid') {
                await interruptActiveTurn();
                resetCurrentTurnState();
                sendVisibleStatus(specialCommand.message);
                return true;
            }

            if (specialCommand.type === 'clear') {
                await interruptActiveTurn();
                resetCurrentTurnState();
                this.currentThreadId = null;
                invalidThreadId = null;
                hasThread = false;
                session.resetCodexThread();
                sendVisibleStatus('Context was reset');
                return true;
            }

            await interruptActiveTurn();
            resetCurrentTurnState();
            const threadId = await resumeExistingThreadForCompact(message.mode);
            if (!threadId) {
                sendVisibleStatus('Nothing to compact');
                return true;
            }

            sendVisibleStatus('Compaction started');
            try {
                await appServerClient.compactThread({ threadId }, {
                    signal: this.abortController.signal
                });
                sendVisibleStatus('Compaction completed');
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                sendVisibleStatus(`Compaction failed: ${detail}`);
            }
            return true;
        };

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            if (!pending && (turnInFlight || recoveryInFlight) && session.queue.size() === 0) {
                await waitForTurnOrRecovery(this.abortController.signal);
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    logger.debug('[codex]: Internal wait aborted while turn/recovery was active; continuing');
                    continue;
                }
                continue;
            }

            let message: QueuedMessage | null = pending;
            const isRetryMessage = Boolean(message);
            pending = null;
            if (!message) {
                sameThreadRetryAttempt = 0;
                sameThreadCompactAttempt = 0;
                activeMessage = null;
                const waitSignal = this.abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            if (!isRetryMessage) {
                messageBuffer.addMessage(message.message, 'user');
            }
            activeMessage = message;

            try {
                if (await handleSpecialCommand(message)) {
                    continue;
                }

                if (!hasThread) {
                    const threadParams = buildThreadStartParams({
                        cwd: session.path,
                        mode: message.mode,
                        mcpServers,
                        cliOverrides: session.codexCliOverrides
                    });

                    const resumeCandidate = session.sessionId ?? null;
                    let threadId: string | null = null;

                    if (resumeCandidate) {
                        try {
                            const resumeResponse = await appServerClient.resumeThread({
                                threadId: resumeCandidate,
                                ...threadParams
                            }, {
                                signal: this.abortController.signal
                            });
                            const resumeRecord = asRecord(resumeResponse);
                            const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                            threadId = asString(resumeThread?.id) ?? resumeCandidate;
                            applyResolvedModel(resumeRecord?.model);
                            logger.debug(`[Codex] Resumed app-server thread ${threadId}`);
                        } catch (error) {
                            logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate}; preserving old conversation boundary`, error);
                            const failureMessage = `Task failed: Codex conversation ${resumeCandidate} could not be resumed; no new conversation was created`;
                            messageBuffer.addMessage(failureMessage, 'status');
                            session.sendSessionEvent({ type: 'message', message: failureMessage });
                            pending = null;
                            continue;
                        }
                    }

                    if (!threadId) {
                        const threadResponse = await appServerClient.startThread(threadParams, {
                            signal: this.abortController.signal
                        });
                        const threadRecord = asRecord(threadResponse);
                        const thread = threadRecord ? asRecord(threadRecord.thread) : null;
                        threadId = asString(thread?.id);
                        applyResolvedModel(threadRecord?.model);
                        if (!threadId) {
                            throw new Error('app-server thread/start did not return thread.id');
                        }
                    }

                    if (!threadId) {
                        throw new Error('app-server resume did not return thread.id');
                    }

                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                    hasThread = true;
                } else {
                    if (!this.currentThreadId) {
                        logger.debug('[Codex] Missing thread id; restarting app-server thread');
                        hasThread = false;
                        pending = message;
                        continue;
                    }
                }

                const turnParams = buildTurnStartParams({
                    threadId: this.currentThreadId,
                    message: message.message,
                    cwd: session.path,
                    mode: {
                        ...message.mode,
                        model: session.getModel() ?? message.mode.model
                    },
                    cliOverrides: session.codexCliOverrides
                });
                turnInFlight = true;
                allowAnonymousTerminalEvent = false;
                const turnResponse = await appServerClient.startTurn(turnParams, {
                    signal: this.abortController.signal
                });
                const turnRecord = asRecord(turnResponse);
                const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                const turnId = asString(turn?.id);
                if (turnInFlight) {
                    if (turnId) {
                        this.currentTurnId = turnId;
                    } else if (!this.currentTurnId) {
                        allowAnonymousTerminalEvent = true;
                    }
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                this.currentTurnId = null;

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    this.currentTurnId = null;
                    this.currentThreadId = null;
                    hasThread = false;
                }
            } finally {
                if (!turnInFlight) {
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    appServerEventConverter.reset();
                    mcpTitleByCallId.clear();
                    pendingAgentToolInputByCallId.clear();
                    pendingAgentTracesByAgentId.clear();
                    cancelAllPendingThrottledAgentRunUpdates();
                    childAgentRuntimeById.clear();
                    session.onThinkingChange(false);
                    clearReadyAfterTurnTimer?.();
                    emitReadyIfIdle({
                        pending: pending ?? (recoveryInFlight ? activeMessage : null),
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                }
                logActiveHandles('after-turn');
            }
        }

        failPendingAgentStarts('spawn_agent did not return an agent id before the Codex session ended');
        cancelAllPendingThrottledAgentRunUpdates();
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        try {
            await this.appServerClient.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        this.permissionHandler?.reset();
        this.reasoningProcessor?.abort();
        this.diffProcessor?.reset();
        this.permissionHandler = null;
        this.reasoningProcessor = null;
        this.diffProcessor = null;

        logger.debug('[codex-remote]: cleanup done');
    }
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const launcher = new CodexRemoteLauncher(session);
    return launcher.launch();
}
