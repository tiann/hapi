import { logger } from '@/ui/logger';
import { opencodeLocal } from './opencodeLocal';
import { OpencodeSession } from './session';
import { ensureOpencodeHookPlugin } from './utils/hookPlugin';
import { buildOpencodeEnv } from './utils/config';
import { ensureOpencodeConfig } from './utils/opencodeConfig';
import { TITLE_INSTRUCTION } from './utils/systemPrompt';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import type { OpencodeHookEvent } from './types';
import type { OpencodeHookServer } from './utils/startOpencodeHookServer';
import { createOpencodeStorageScanner, type OpencodeStorageScannerHandle } from './utils/opencodeStorageScanner';
import { randomUUID } from 'node:crypto';
import { isObject } from '@hapi/protocol';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import type { PermissionCompletion } from '@/modules/common/permission/BasePermissionHandler';
import { hashObject } from '@/utils/deterministicJson';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

type OpencodeLocalLauncherOptions = {
    hookServer: OpencodeHookServer;
    hookUrl: string;
};

type ParsedToolCall = {
    callId: string;
    name: string;
    input: unknown;
};

type ParsedToolResult = {
    callId: string;
    output: unknown;
};

type PermissionDecision = PermissionCompletion['decision'];

function getString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return null;
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return value;
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    }
    return value;
}

function getNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return null;
}

function getTextDelta(payloadRecord: Record<string, unknown> | null): string | null {
    const delta = payloadRecord?.delta;
    return typeof delta === 'string' && delta.length > 0 ? delta : null;
}

function buildToolSignature(name: string, input: unknown): string {
    return `${name}:${hashObject(input ?? null)}`;
}

function pushQueue(map: Map<string, string[]>, key: string, value: string): void {
    const queue = map.get(key) ?? [];
    queue.push(value);
    map.set(key, queue);
}

function shiftQueue(map: Map<string, string[]>, key: string): string | null {
    const queue = map.get(key);
    if (!queue || queue.length === 0) {
        return null;
    }
    const value = queue.shift() ?? null;
    if (!queue.length) {
        map.delete(key);
    } else {
        map.set(key, queue);
    }
    return value;
}

function removeFromQueue(map: Map<string, string[]>, key: string, value: string): void {
    const queue = map.get(key);
    if (!queue || queue.length === 0) {
        return;
    }
    const nextQueue = queue.filter((entry) => entry !== value);
    if (!nextQueue.length) {
        map.delete(key);
    } else {
        map.set(key, nextQueue);
    }
}

function extractSessionId(value: unknown): string | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const direct = getString(record.sessionId)
        || getString(record.sessionID)
        || getString(record.session_id)
        || (isObject(record.session) ? getString((record.session as Record<string, unknown>).id) : null);
    if (direct) {
        return direct;
    }
    if (isObject(record.part)) {
        const nested = extractSessionId(record.part);
        if (nested) {
            return nested;
        }
    }
    if (isObject(record.info)) {
        const nested = extractSessionId(record.info);
        if (nested) {
            return nested;
        }
    }
    return null;
}

function unwrapMessage(payload: unknown): Record<string, unknown> | null {
    if (!isObject(payload)) {
        return null;
    }
    const record = payload as Record<string, unknown>;
    if (isObject(record.message)) {
        return record.message as Record<string, unknown>;
    }
    if (isObject(record.info)) {
        return record.info as Record<string, unknown>;
    }
    return record;
}

function unwrapPart(payload: unknown): Record<string, unknown> | null {
    if (isObject(payload)) {
        const record = payload as Record<string, unknown>;
        if (isObject(record.part)) {
            return record.part as Record<string, unknown>;
        }
        return record;
    }
    return null;
}

function parseToolCall(part: unknown): ParsedToolCall | null {
    if (!isObject(part)) {
        return null;
    }
    const record = part as Record<string, unknown>;
    const name = getString(record.tool) || getString(record.name);
    const callId = getString(record.callID)
        || getString(record.callId)
        || getString(record.id)
        || getString(record.tool_call_id)
        || getString(record.toolCallId);
    if (!name || !callId) {
        return null;
    }
    if (getString(record.type) === 'tool' && isObject(record.state)) {
        const state = record.state as Record<string, unknown>;
        const status = getString(state.status);
        if (status !== 'pending' && status !== 'running') {
            return null;
        }
        const input = parseMaybeJson(state.input ?? state.raw ?? record.input ?? record.args ?? record.arguments);
        return { callId, name, input };
    }
    const input = parseMaybeJson(record.input ?? record.args ?? record.arguments ?? record.raw);
    return { callId, name, input };
}

function parseToolResult(part: unknown): ParsedToolResult | null {
    if (!isObject(part)) {
        return null;
    }
    const record = part as Record<string, unknown>;
    const callId = getString(record.callID)
        || getString(record.callId)
        || getString(record.tool_call_id)
        || getString(record.toolCallId)
        || getString(record.id);
    if (!callId) {
        return null;
    }
    if (getString(record.type) === 'tool' && isObject(record.state)) {
        const state = record.state as Record<string, unknown>;
        const status = getString(state.status);
        if (status === 'completed') {
            const output = {
                content: state.output ?? state.title,
                metadata: state.metadata,
                title: state.title,
                attachments: state.attachments
            };
            return { callId, output };
        }
        if (status === 'error') {
            const output = {
                content: state.error,
                isError: true
            };
            return { callId, output };
        }
        return null;
    }
    const output = {
        content: record.content,
        metadata: record.metadata,
        isError: record.is_error
    };
    return { callId, output };
}

function normalizeDecision(response: string | null, approved: boolean): PermissionDecision {
    if (response === 'always' || response === 'approved_for_session') {
        return 'approved_for_session';
    }
    if (response === 'once' || response === 'approved') {
        return 'approved';
    }
    if (response === 'reject' || response === 'denied') {
        return 'denied';
    }
    if (response === 'abort' || response === 'cancel' || response === 'canceled') {
        return 'abort';
    }
    return approved ? 'approved' : 'denied';
}

function resolveOpencodeConfigDir(session: OpencodeSession): string {
    if (process.env.OPENCODE_CONFIG_DIR) {
        return process.env.OPENCODE_CONFIG_DIR;
    }
    return join(configuration.happyHomeDir, 'tmp', 'opencode', session.client.sessionId, '.opencode');
}

export async function opencodeLocalLauncher(
    session: OpencodeSession,
    opts: OpencodeLocalLauncherOptions
): Promise<'switch' | 'exit'> {
    const hookUrl = opts.hookUrl;

    const opencodeConfigDir = resolveOpencodeConfigDir(session);
    ensureOpencodeHookPlugin(opencodeConfigDir, hookUrl, opts.hookServer.token);

    // Start the hapi MCP server for change_title support (optional feature)
    let happyServer: { url: string; stop: () => void } | null = null;
    let opencodeConfigPath: string | null = null;
    try {
        const bridge = await buildHapiMcpBridge(session.client);
        happyServer = bridge.server;
        logger.debug(`[opencode-local]: Started hapi MCP server at ${happyServer.url}`);

        // Generate opencode.json config with MCP server and instructions
        const { configPath } = ensureOpencodeConfig(opencodeConfigDir, bridge.mcpServers.hapi, TITLE_INSTRUCTION);
        opencodeConfigPath = configPath;
    } catch (error) {
        logger.debug('[opencode-local]: Failed to start hapi MCP server (change_title will be unavailable)', error);
    }

    const launcher = new BaseLocalLauncher({
        label: 'opencode-local',
        failureLabel: 'Local OpenCode process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            const env = buildOpencodeEnv();
            env.HAPI_OPENCODE_HOOK_URL = hookUrl;
            env.HAPI_OPENCODE_HOOK_TOKEN = opts.hookServer.token;
            if (!env.OPENCODE_CONFIG_DIR) {
                env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
            }
            if (!env.OPENCODE_CONFIG && opencodeConfigPath) {
                env.OPENCODE_CONFIG = opencodeConfigPath;
            }

            await opencodeLocal({
                path: session.path,
                abort: abortSignal,
                env,
                sessionId: session.sessionId ?? undefined
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    let storageScanner: OpencodeStorageScannerHandle | null = null;
    const messageRoles = new Map<string, string>();
    const sentTextParts = new Set<string>();
    const sentToolCalls = new Set<string>();
    const sentToolResults = new Set<string>();
    const textBuffers = new Map<string, string>();
    const toolExecutionQueues = new Map<string, string[]>();

    const handleHookEvent = (event: OpencodeHookEvent) => {
        const payload = event.payload;
        const eventType = event.event;
        const payloadRecord = isObject(payload) ? payload as Record<string, unknown> : null;
        const sessionId = event.sessionId
            || extractSessionId(payload)
            || (payloadRecord ? extractSessionId(payloadRecord.info) : null);
        if (sessionId) {
            session.onSessionFound(sessionId);
            storageScanner?.onNewSession(sessionId);
        }

        if (eventType === 'session.created' || eventType === 'session.updated') {
            if (payloadRecord) {
                const info = isObject(payloadRecord.info) ? payloadRecord.info as Record<string, unknown> : payloadRecord;
                const sessionIdValue = extractSessionId(info) || getString(info.id);
                if (sessionIdValue) {
                    session.onSessionFound(sessionIdValue);
                    storageScanner?.onNewSession(sessionIdValue);
                }
            }
            return;
        }

        if (eventType === 'message.updated') {
            const message = unwrapMessage(payload);
            if (!message) {
                return;
            }
            const messageId = getString(message.id) || getString(message.messageId);
            const role = getString(message.role);
            if (messageId && role) {
                messageRoles.set(messageId, role);
            }
            return;
        }

        if (eventType === 'message.part.updated') {
            const part = unwrapPart(payload);
            if (!part) {
                return;
            }
            const partType = getString(part.type);
            const partId = getString(part.id);
            const messageId = getString(part.messageID)
                || getString(part.messageId)
                || (payloadRecord ? getString(payloadRecord.messageID) || getString(payloadRecord.messageId) : null);
            const delta = getTextDelta(payloadRecord);

            if (partType === 'text') {
                if (partId && sentTextParts.has(partId)) {
                    return;
                }
                const role = (messageId && messageRoles.get(messageId)) ?? 'assistant';
                const key = partId ?? messageId;
                const bufferValue = key ? textBuffers.get(key) ?? '' : '';
                const textFromPart = getString(part.text);
                const nextBuffer = delta ? bufferValue + delta : bufferValue;

                if (key && (delta || textFromPart)) {
                    textBuffers.set(key, textFromPart ?? nextBuffer);
                }

                const time = isObject(part.time) ? part.time as Record<string, unknown> : null;
                const hasEnd = time ? getNumber(time.end) !== null : false;
                const shouldFlush = role === 'user'
                    || part.synthetic === true
                    || hasEnd
                    || (!delta && Boolean(textFromPart));
                const text = textFromPart ?? (key ? textBuffers.get(key) : null);
                if (shouldFlush && text) {
                    if (role === 'user') {
                        session.sendUserMessage(text, { sentFrom: 'scanner' });
                    } else {
                        session.sendCodexMessage({ type: 'message', message: text });
                    }
                    if (partId) {
                        sentTextParts.add(partId);
                    }
                    if (key) {
                        textBuffers.delete(key);
                    }
                }
                return;
            }

            const toolCall = parseToolCall(part);
            if (toolCall && !sentToolCalls.has(toolCall.callId)) {
                sentToolCalls.add(toolCall.callId);
                session.sendCodexMessage({
                    type: 'tool-call',
                    name: toolCall.name,
                    callId: toolCall.callId,
                    input: toolCall.input
                });
            }

            const toolResult = parseToolResult(part);
            if (toolResult && !sentToolResults.has(toolResult.callId)) {
                sentToolResults.add(toolResult.callId);
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: toolResult.callId,
                    output: toolResult.output
                });
            }
            return;
        }

        if (eventType === 'tool.execute.before' || eventType === 'tool.execute.after') {
            if (!isObject(payload)) {
                return;
            }
            const record = payload as Record<string, unknown>;
            const tool = isObject(record.tool) ? record.tool as Record<string, unknown> : record;
            const name = getString(tool.name) || getString(record.name);
            if (!name) {
                return;
            }
            const toolInput = parseMaybeJson(tool.input ?? tool.args ?? record.input ?? record.args);
            const signature = buildToolSignature(name, toolInput);
            const fallbackSignature = buildToolSignature(name, null);
            const existingId = getString(tool.id)
                || getString(tool.tool_call_id)
                || getString(tool.toolCallId);
            const isBefore = eventType === 'tool.execute.before';
            let callId = existingId;

            if (!callId) {
                callId = isBefore
                    ? randomUUID()
                    : shiftQueue(toolExecutionQueues, signature)
                        ?? shiftQueue(toolExecutionQueues, fallbackSignature)
                        ?? randomUUID();
            }

            if (isBefore) {
                pushQueue(toolExecutionQueues, signature, callId);
                if (fallbackSignature !== signature) {
                    pushQueue(toolExecutionQueues, fallbackSignature, callId);
                }
            } else {
                removeFromQueue(toolExecutionQueues, signature, callId);
                if (fallbackSignature !== signature) {
                    removeFromQueue(toolExecutionQueues, fallbackSignature, callId);
                }
            }
            if (eventType === 'tool.execute.before' && !sentToolCalls.has(callId)) {
                sentToolCalls.add(callId);
                session.sendCodexMessage({
                    type: 'tool-call',
                    name,
                    callId,
                    input: toolInput
                });
                return;
            }
            if (eventType === 'tool.execute.after' && !sentToolResults.has(callId)) {
                sentToolResults.add(callId);
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId,
                    output: {
                        content: tool.content ?? record.content ?? record.output,
                        metadata: tool.metadata ?? record.metadata,
                        isError: tool.is_error ?? record.is_error
                    }
                });
                return;
            }
        }

        if (eventType === 'permission.updated' || eventType === 'permission.asked') {
            if (!isObject(payload)) {
                return;
            }
            const record = payload as Record<string, unknown>;
            const metadata = isObject(record.metadata) ? record.metadata as Record<string, unknown> : undefined;
            const id = getString(record.id)
                || getString(record.permissionID)
                || getString(record.permissionId)
                || getString(record.requestID)
                || getString(record.requestId);
            if (!id) {
                return;
            }

            const toolName = getString(record.permission)
                || getString(record.type)
                || (metadata ? getString(metadata.tool) : null)
                || 'Permission';

            const toolInput = metadata?.input
                ?? record.pattern
                ?? record.message
                ?? record.metadata;

            session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: toolInput,
                        createdAt: Date.now()
                    }
                }
            }));
            return;
        }

        if (eventType === 'permission.replied') {
            if (!isObject(payload)) {
                return;
            }
            const record = payload as Record<string, unknown>;
            const metadata = isObject(record.metadata) ? record.metadata as Record<string, unknown> : undefined;
            const id = getString(record.permissionID)
                || getString(record.permissionId)
                || getString(record.requestID)
                || getString(record.requestId)
                || getString(record.id);
            if (!id) {
                return;
            }

            const toolName = getString(record.permission)
                || getString(record.type)
                || (metadata ? getString(metadata.tool) : null)
                || 'Permission';

            const toolInput = metadata?.input
                ?? record.pattern
                ?? record.message
                ?? record.metadata;

            const response = getString(record.response)
                || getString(record.reply)
                || getString(record.decision);
            const approved = record.approved === true
                || response === 'once'
                || response === 'always'
                || response === 'approved';
            const decision = normalizeDecision(response, approved);
            const status = decision === 'approved' || decision === 'approved_for_session'
                ? 'approved'
                : decision === 'abort'
                    ? 'canceled'
                    : 'denied';
            const reason = getString(record.reason) ?? undefined;
            const allowTools = Array.isArray(record.allowTools) ? record.allowTools : undefined;

            session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id] ?? {
                    tool: toolName,
                    arguments: toolInput,
                    createdAt: Date.now()
                };
                const nextRequests = { ...(currentState.requests || {}) };
                delete nextRequests[id];
                return {
                    ...currentState,
                    requests: nextRequests,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status,
                            decision,
                            reason,
                            allowTools
                        }
                    }
                };
            });
            return;
        }
    };

    session.addHookEventHandler(handleHookEvent);

    try {
        try {
            storageScanner = await createOpencodeStorageScanner({
                sessionId: session.sessionId,
                cwd: session.path,
                onEvent: (event) => session.emitHookEvent(event),
                onSessionFound: (sessionId) => {
                    session.onSessionFound(sessionId);
                },
                onSessionMatchFailed: (message) => {
                    session.sendSessionEvent({ type: 'message', message });
                }
            });
        } catch (error) {
            logger.debug('[opencode-local]: Failed to start storage scanner', error);
        }
        return await launcher.run();
    } finally {
        session.removeHookEventHandler(handleHookEvent);
        if (storageScanner) {
            await storageScanner.cleanup();
        }
        if (happyServer) {
            happyServer.stop();
            logger.debug('[opencode-local]: Stopped hapi MCP server');
        }
    }
}
