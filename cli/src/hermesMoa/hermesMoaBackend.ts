import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';

import type { AgentBackend, AgentMessage, AgentSessionConfig, AgentSessionHandle, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { DEFAULT_HERMES_MOA_PRESET, isHermesMoaPreset } from '@hapi/protocol';
import { logger } from '@/ui/logger';

type JsonRpcId = number;

type JsonRpcFrame = {
    jsonrpc?: string;
    id?: JsonRpcId | null;
    method?: string;
    params?: HermesGatewayEvent;
    result?: unknown;
    error?: { message?: string; code?: number };
};

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
};

export type HermesGatewayEvent = {
    type: string;
    session_id?: string;
    payload?: unknown;
};

type WebSocketLike = {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(event: 'open' | 'message' | 'close' | 'error', handler: (event: any) => void, options?: unknown): void;
    removeEventListener?(event: 'open' | 'message' | 'close' | 'error', handler: (event: any) => void): void;
};

const WS_OPEN = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const PROMPT_REQUEST_TIMEOUT_MS = 30_000;
const SERVE_READY_TIMEOUT_MS = 30_000;
const TITLE_SYNC_TIMEOUT_MS = 45_000;
const TITLE_SYNC_POLL_INTERVAL_MS = 1_000;
const FALLBACK_TITLE_MAX_LENGTH = 40;

export function summarizeHermesServeStderr(value: string | Buffer | number): string {
    const bytes = typeof value === 'number' ? Math.max(0, Math.trunc(value)) : Buffer.byteLength(value);
    return `stderr captured (${bytes} bytes)`;
}

type HermesChildHandle = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill' | 'once' | 'off'>;

function childHasExited(child: HermesChildHandle): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: HermesChildHandle, timeoutMs: number): Promise<boolean> {
    if (childHasExited(child)) return true;
    return await new Promise<boolean>((resolve) => {
        const onExit = () => finish(true);
        const finish = (value: boolean) => {
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(value);
        };
        const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
        timer.unref?.();
        child.once('exit', onExit);
    });
}

export async function terminateHermesChild(child: HermesChildHandle, graceMs = 2_000): Promise<void> {
    if (childHasExited(child)) return;
    child.kill('SIGTERM');
    if (await waitForChildExit(child, graceMs)) return;
    child.kill('SIGKILL');
    if (!await waitForChildExit(child, graceMs)) {
        throw new Error('Hermes child did not exit after SIGKILL');
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getHermesToolInput(payload: Record<string, unknown>): unknown {
    if (isObject(payload.args)) {
        return payload.args;
    }

    const input: Record<string, unknown> = {};
    const context = asString(payload.context);
    const argsText = asString(payload.args_text);
    if (context) input.context = context;
    if (argsText) input.args_text = argsText;
    return Object.keys(input).length > 0 ? input : null;
}

function getHermesToolOutput(payload: Record<string, unknown>): unknown {
    if ('result' in payload) {
        return payload.result;
    }
    if ('error' in payload) {
        return payload.error;
    }
    if ('summary' in payload) {
        return payload.summary;
    }
    return payload;
}

function cleanFallbackTitle(value: string): string {
    return value
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/^\s*#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)、]\s+/gm, '')
        .replace(/[“”"']/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[。！？!?.,，、:：;；\-\s]+$/g, '')
        .trim();
}

function truncateFallbackTitle(value: string): string {
    const chars = Array.from(value);
    return chars.length > FALLBACK_TITLE_MAX_LENGTH
        ? `${chars.slice(0, FALLBACK_TITLE_MAX_LENGTH - 1).join('')}…`
        : value;
}

export function deriveHermesMoaFallbackTitle(userText: string, assistantText: string): string | null {
    const user = userText.trim();
    const assistant = assistantText.trim();

    const heading = assistant
        .split(/\r?\n/)
        .map((line) => /^#{1,3}\s+(.+)$/.exec(line)?.[1])
        .find((line): line is string => Boolean(line?.trim()));

    const sourceLine = heading
        ?? assistant
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && line !== '---' && !/^材料读完/.test(line))
        ?? user;

    const cleaned = cleanFallbackTitle(sourceLine);
    if (!cleaned) return null;

    const bookTitle = /《([^》]{2,30})》/.exec(cleaned)?.[1]?.trim();
    if (bookTitle) {
        const intent = /世界观|剧情|故事|设定/.test(user) ? '世界观总结' : '';
        return truncateFallbackTitle(`${bookTitle}${intent}`);
    }

    return truncateFallbackTitle(cleaned);
}

function getUserHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.HOME?.trim() || os.homedir();
}

function getHermesCommand(env: NodeJS.ProcessEnv = process.env): string {
    return env.HAPI_HERMES_PATH?.trim() || join(getUserHome(env), '.local', 'bin', 'hermes');
}

function getWebSocketCtor(): new (url: string) => WebSocketLike {
    const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!ctor) {
        throw new Error('WebSocket is unavailable in this runtime; Hermes MoA requires Bun/Node with WebSocket support');
    }
    return ctor;
}

export function parseHermesServeReadyPort(output: string): number | null {
    const match = /HERMES_BACKEND_READY\s+port=(\d+)/.exec(output);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function buildHermesServeSpawnOptions(
    cwd: string,
    token: string,
    env: NodeJS.ProcessEnv = process.env
): SpawnOptions {
    const blockedManagedKeys = new Set([
        'HAPI_LAUNCH_NONCE', 'HAPI_RUNNER_INSTANCE_ID', 'HAPI_RESUME_PROFILE_FINGERPRINT',
        'HAPI_EXPECTED_NATIVE_RESUME_ID', 'HAPI_MANAGED_OUTCOME_FD'
    ]);
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) =>
        !blockedManagedKeys.has(key) && typeof value === 'string'
    ));
    return {
        cwd,
        env: {
            ...childEnv,
            HERMES_DASHBOARD_SESSION_TOKEN: token,
            HERMES_WORKSPACE_ONLY: '1',
            TERMINAL_CWD: cwd,
            HAPI_INVOKED_CWD: cwd,
        },
        stdio: ['ignore', 'pipe', 'pipe']
    };
}

export function convertHermesGatewayEventToAgentMessage(
    event: HermesGatewayEvent,
    sessionId: string
): AgentMessage | null {
    if (event.session_id && event.session_id !== sessionId) {
        return null;
    }

    const payload = isObject(event.payload) ? event.payload : {};
    if (event.type === 'message.delta') {
        const text = asString(payload.text);
        return text ? { type: 'text', text } : null;
    }

    if (event.type === 'message.complete') {
        const status = asString(payload.status) ?? 'complete';
        return { type: 'turn_complete', stopReason: status };
    }

    if (event.type === 'moa.reference') {
        const label = asString(payload.label) ?? 'reference';
        return {
            type: 'moa_reference',
            label,
            text: asString(payload.text) ?? '',
            ...(asNumber(payload.index) !== undefined ? { index: asNumber(payload.index) } : {}),
            ...(asNumber(payload.count) !== undefined ? { count: asNumber(payload.count) } : {})
        };
    }

    if (event.type === 'moa.aggregating') {
        const aggregator = asString(payload.aggregator) ?? undefined;
        return { type: 'moa_aggregating', ...(aggregator ? { aggregator } : {}) };
    }

    if (event.type === 'tool.start') {
        const id = asString(payload.tool_id) ?? asString(payload.id);
        if (!id) return null;
        return {
            type: 'tool_call',
            id,
            name: asString(payload.name) ?? 'tool',
            input: getHermesToolInput(payload),
            status: 'in_progress'
        };
    }

    if (event.type === 'tool.complete') {
        const id = asString(payload.tool_id) ?? asString(payload.id);
        if (!id) return null;
        return {
            type: 'tool_result',
            id,
            output: getHermesToolOutput(payload),
            status: payload.error ? 'failed' : 'completed'
        };
    }

    if (event.type === 'session.title') {
        const title = asString(payload.title)?.trim();
        return title ? { type: 'title', title } : null;
    }

    if (event.type === 'error') {
        return { type: 'error', message: asString(payload.message) ?? 'Hermes gateway error' };
    }

    return null;
}

export function mapPermissionResponseToHermesChoice(
    request: PermissionRequest,
    response: PermissionResponse
): 'once' | 'session' | 'always' | 'deny' {
    if (response.outcome !== 'selected') {
        return 'deny';
    }
    if (response.optionId === 'once' || response.optionId === 'session' || response.optionId === 'always' || response.optionId === 'deny') {
        return response.optionId;
    }
    const option = request.options.find((item) => item.optionId === response.optionId);
    switch (option?.kind) {
        case 'allow_once':
            return 'once';
        case 'allow_always':
            return 'session';
        case 'reject_once':
        case 'reject_always':
            return 'deny';
        default:
            return 'deny';
    }
}

export class HermesMoaBackend implements AgentBackend {
    private child: ChildProcess | null = null;
    private ws: WebSocketLike | null = null;
    private nextId = 1;
    private readonly pending = new Map<JsonRpcId, PendingRequest>();
    private eventHandler: ((event: HermesGatewayEvent) => void) | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private initializedCwd: string | null = null;
    private initializePromise: Promise<void> | null = null;
    private readonly emittedTitles = new Map<string, string>();

    constructor(private readonly options: {
        model?: string | null;
        permissionMode?: string;
        command?: string;
    } = {}) {}

    async initialize(): Promise<void> {
        // Hermes MoA serve must be started after the HAPI session cwd is known.
        // runAgentSession calls initialize() before it builds AgentSessionConfig,
        // so actual initialization is deferred to newSession()/resumeSession().
    }

    private async ensureInitialized(cwd: string): Promise<void> {
        if (this.ws?.readyState === WS_OPEN) {
            if (this.initializedCwd && this.initializedCwd !== cwd) {
                throw new Error(`Hermes MoA backend already initialized for ${this.initializedCwd}, cannot reuse for ${cwd}`);
            }
            return;
        }
        if (this.initializePromise) {
            await this.initializePromise;
            if (this.initializedCwd && this.initializedCwd !== cwd) {
                throw new Error(`Hermes MoA backend already initialized for ${this.initializedCwd}, cannot reuse for ${cwd}`);
            }
            return;
        }
        const token = randomUUID();
        const command = this.options.command ?? getHermesCommand();
        this.initializePromise = (async () => {
            const ready = await this.startServe(command, token, cwd);
            await this.connect(`ws://127.0.0.1:${ready.port}/api/ws?token=${encodeURIComponent(token)}`);
            this.initializedCwd = cwd;
        })();
        try {
            await this.initializePromise;
        } finally {
            this.initializePromise = null;
        }
    }

    async newSession(config: AgentSessionConfig): Promise<AgentSessionHandle> {
        await this.ensureInitialized(config.cwd);
        const preset = this.normalizePreset(this.options.model);
        const result = await this.request('session.create', {
            cwd: config.cwd,
            source: 'hapi',
            model: preset,
            provider: 'moa',
            workspace_only: true,
            close_on_disconnect: false,
        });
        if (!isObject(result) || typeof result.session_id !== 'string') {
            throw new Error('Invalid session.create response from Hermes');
        }
        await this.applyPermissionMode(result.session_id, this.options.permissionMode ?? 'default');
        return {
            sessionId: result.session_id,
            resumeSessionId: typeof result.stored_session_id === 'string' ? result.stored_session_id : result.session_id
        };
    }

    async resumeSession(resumeSessionId: string, _config: AgentSessionConfig): Promise<AgentSessionHandle> {
        await this.ensureInitialized(_config.cwd);
        const result = await this.request('session.resume', {
            session_id: resumeSessionId,
            cwd: _config.cwd,
            source: 'hapi',
            workspace_only: true,
            close_on_disconnect: false,
        });
        if (!isObject(result) || typeof result.session_id !== 'string') {
            throw new Error('Invalid session.resume response from Hermes');
        }
        await this.applyPermissionMode(result.session_id, this.options.permissionMode ?? 'default');
        return {
            sessionId: result.session_id,
            resumeSessionId: typeof result.session_key === 'string'
                ? result.session_key
                : typeof result.resumed === 'string'
                    ? result.resumed
                    : resumeSessionId
        };
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        const text = content.map((item) => item.text).join('\n\n');
        let sawDelta = false;
        let settled = false;

        await new Promise<void>((resolve, reject) => {
            const previousHandler = this.eventHandler;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                this.eventHandler = previousHandler;
                if (error) reject(error);
                else resolve();
            };

            this.eventHandler = (event) => {
                previousHandler?.(event);
                if (event.session_id && event.session_id !== sessionId) return;

                if (event.type === 'message.delta') {
                    sawDelta = true;
                }

                if (event.type === 'message.complete') {
                    const payload = isObject(event.payload) ? event.payload : {};
                    if (!sawDelta) {
                        const fullText = asString(payload.text);
                        if (fullText) {
                            onUpdate({ type: 'text', text: fullText });
                        }
                    }
                    const fullText = asString(payload.text) ?? '';
                    const stopReason = asString(payload.status) ?? 'complete';
                    onUpdate({ type: 'turn_complete', stopReason });
                    this.waitForTitleIfAvailable(sessionId, onUpdate)
                        .then((titleFound) => {
                            if (!titleFound && stopReason === 'complete') {
                                this.emitFallbackTitle(sessionId, text, fullText, onUpdate);
                            }
                        })
                        .finally(() => finish());
                    return;
                }

                const converted = convertHermesGatewayEventToAgentMessage(event, sessionId);
                if (converted) {
                    if (converted.type === 'title') {
                        this.emitTitle(sessionId, converted.title, onUpdate);
                    } else {
                        onUpdate(converted);
                    }
                    if (converted.type === 'error') {
                        finish(new Error(converted.message));
                    }
                }
            };

            this.request('prompt.submit', { session_id: sessionId, text }, { timeoutMs: PROMPT_REQUEST_TIMEOUT_MS })
                .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
        });
    }

    private async emitTitleIfAvailable(
        sessionId: string,
        onUpdate: (msg: AgentMessage) => void
    ): Promise<boolean> {
        try {
            const result = await this.request('session.title', { session_id: sessionId }, { timeoutMs: 5_000 });
            const title = isObject(result) ? asString(result.title)?.trim() : '';
            return this.emitTitle(sessionId, title ?? '', onUpdate);
        } catch (error) {
            logger.debug('[HermesMoA] session.title sync failed', error);
            return false;
        }
    }

    private emitTitle(
        sessionId: string,
        title: string,
        onUpdate: (msg: AgentMessage) => void
    ): boolean {
        const cleanTitle = title.trim();
        if (!cleanTitle) return false;
        if (this.emittedTitles.get(sessionId) === cleanTitle) return true;
        this.emittedTitles.set(sessionId, cleanTitle);
        onUpdate({ type: 'title', title: cleanTitle });
        return true;
    }

    private async waitForTitleIfAvailable(
        sessionId: string,
        onUpdate: (msg: AgentMessage) => void
    ): Promise<boolean> {
        const deadline = Date.now() + TITLE_SYNC_TIMEOUT_MS;
        if (await this.emitTitleIfAvailable(sessionId, onUpdate)) {
            return true;
        }
        while (Date.now() < deadline) {
            if (this.emittedTitles.has(sessionId)) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, TITLE_SYNC_POLL_INTERVAL_MS));
            if (await this.emitTitleIfAvailable(sessionId, onUpdate)) {
                return true;
            }
        }
        return false;
    }

    private emitFallbackTitle(
        sessionId: string,
        userText: string,
        assistantText: string,
        onUpdate: (msg: AgentMessage) => void
    ): boolean {
        if (this.emittedTitles.has(sessionId)) return true;
        const title = deriveHermesMoaFallbackTitle(userText, assistantText);
        if (!title) return false;
        const emitted = this.emitTitle(sessionId, title, onUpdate);
        if (emitted) {
            this.request('session.title', { session_id: sessionId, title }, { timeoutMs: 5_000 }).catch((error) => {
                logger.debug('[HermesMoA] fallback session.title persist failed', error);
            });
        }
        return emitted;
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        await this.request('session.interrupt', { session_id: sessionId }, { timeoutMs: 10_000 }).catch((error) => {
            logger.debug('[HermesMoA] session.interrupt failed', error);
        });
    }

    async setSessionConfig(
        sessionId: string,
        config: { model?: string | null; permissionMode?: string }
    ): Promise<{ model?: string | null; permissionMode?: string }> {
        const applied: { model?: string | null; permissionMode?: string } = {};
        if (config.model !== undefined) {
            const preset = this.normalizePreset(config.model);
            await this.request('config.set', {
                session_id: sessionId,
                key: 'model',
                value: `${preset} --provider moa`,
                confirm_expensive_model: false,
            });
            applied.model = preset;
        }
        if (config.permissionMode !== undefined) {
            await this.applyPermissionMode(sessionId, config.permissionMode);
            applied.permissionMode = config.permissionMode;
        }
        return applied;
    }

    async respondToPermission(
        sessionId: string,
        _request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const choice = mapPermissionResponseToHermesChoice(_request, response);
        await this.request('approval.respond', { session_id: sessionId, choice }, { timeoutMs: 10_000 }).catch((error) => {
            logger.debug('[HermesMoA] approval.respond failed', error);
        });
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    async disconnect(): Promise<void> {
        for (const [id, pending] of this.pending.entries()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new Error('Hermes backend disconnected'));
            this.pending.delete(id);
        }
        try {
            this.ws?.close();
        } catch {
            // ignore
        }
        this.ws = null;
        const child = this.child;
        this.child = null;
        this.initializedCwd = null;
        this.initializePromise = null;
        if (child) await terminateHermesChild(child);
    }

    private normalizePreset(model: string | null | undefined): string {
        if (model === undefined) {
            return DEFAULT_HERMES_MOA_PRESET;
        }
        if (model === null) {
            throw new Error('Hermes MoA preset is required');
        }
        const value = model.trim();
        if (!isHermesMoaPreset(value)) {
            throw new Error(`Unsupported Hermes MoA preset: ${value}`);
        }
        return value;
    }

    private async applyPermissionMode(sessionId: string, mode: string): Promise<void> {
        const normalized = mode === 'yolo' ? '1' : '0';
        await this.request('config.set', {
            session_id: sessionId,
            key: 'yolo',
            value: normalized,
            scope: 'session',
        }, { timeoutMs: 10_000 });
    }

    private async startServe(command: string, token: string, cwd: string): Promise<{ port: number }> {
        return await new Promise((resolve, reject) => {
            let settled = false;
            let stdoutBuffer = '';
            let stderrBytes = 0;
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn();
            };
            const timer = setTimeout(() => {
                settle(() => {
                    this.child?.kill('SIGTERM');
                    const stderrSummary = stderrBytes > 0 ? `: ${summarizeHermesServeStderr(stderrBytes)}` : '';
                    reject(new Error(`Hermes serve did not report a ready port within ${SERVE_READY_TIMEOUT_MS}ms${stderrSummary}`));
                });
            }, SERVE_READY_TIMEOUT_MS);

            const child = spawn(command, ['serve', '--host', '127.0.0.1', '--port', '0', '--skip-build'], buildHermesServeSpawnOptions(cwd, token));
            this.child = child;

            if (!child.stdout || !child.stderr) {
                settle(() => reject(new Error('Hermes serve did not expose piped stdio')));
                return;
            }

            child.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                stdoutBuffer += text;
                const port = parseHermesServeReadyPort(stdoutBuffer);
                if (port !== null) {
                    settle(() => resolve({ port }));
                }
            });

            child.stderr.on('data', (chunk) => {
                const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
                stderrBytes += bytes;
                logger.debug('[HermesMoA] serve stderr captured', { bytes });
            });

            child.once('error', (error) => {
                const code = (error as NodeJS.ErrnoException).code;
                settle(() => reject(new Error(`Hermes serve failed to start${code ? ` (${code})` : ''}`)));
            });

            child.once('exit', (code, signal) => {
                if (!settled) {
                    const stderrSummary = stderrBytes > 0 ? `: ${summarizeHermesServeStderr(stderrBytes)}` : '';
                    settle(() => reject(new Error(`Hermes serve exited before ready (code=${code}, signal=${signal})${stderrSummary}`)));
                }
            });
        });
    }

    private async connect(url: string): Promise<void> {
        const WebSocketCtor = getWebSocketCtor();
        const ws = new WebSocketCtor(url);
        this.ws = ws;
        ws.addEventListener('message', (event: { data: unknown }) => this.handleRawMessage(event.data));
        ws.addEventListener('close', () => {
            for (const [id, pending] of this.pending.entries()) {
                if (pending.timer) clearTimeout(pending.timer);
                pending.reject(new Error('Hermes websocket closed'));
                this.pending.delete(id);
            }
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Hermes websocket connect timed out')), DEFAULT_CONNECT_TIMEOUT_MS);
            const onOpen = () => {
                clearTimeout(timer);
                resolve();
            };
            const onError = () => {
                clearTimeout(timer);
                reject(new Error('Hermes websocket connection failed'));
            };
            ws.addEventListener('open', onOpen, { once: true });
            ws.addEventListener('error', onError, { once: true });
        });
    }

    private request(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown> {
        const ws = this.ws;
        if (!ws || ws.readyState !== WS_OPEN) {
            return Promise.reject(new Error('Hermes websocket is not connected'));
        }

        const id = this.nextId++;
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const pending: PendingRequest = { resolve, reject };
            if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
                pending.timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`Hermes request timed out: ${method}`));
                }, timeoutMs);
            }
            this.pending.set(id, pending);
            try {
                ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            } catch (error) {
                if (pending.timer) clearTimeout(pending.timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private handleRawMessage(raw: unknown): void {
        let frame: JsonRpcFrame;
        try {
            frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
        } catch {
            return;
        }

        if (frame.id !== undefined && frame.id !== null) {
            const pending = this.pending.get(frame.id);
            if (!pending) return;
            this.pending.delete(frame.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (frame.error) {
                pending.reject(new Error(frame.error.message ?? 'Hermes RPC failed'));
            } else {
                pending.resolve(frame.result);
            }
            return;
        }

        if (frame.method === 'event' && frame.params?.type) {
            const event = frame.params;
            if (event.type === 'approval.request') {
                this.handleApprovalRequest(event);
            }
            this.eventHandler?.(event);
        }
    }

    private handleApprovalRequest(event: HermesGatewayEvent): void {
        const payload = isObject(event.payload) ? event.payload : {};
        const id = asString(payload.id) ?? asString(payload.approval_id) ?? randomUUID();
        this.permissionHandler?.({
            id,
            sessionId: event.session_id ?? '',
            toolCallId: id,
            title: asString(payload.command) ?? asString(payload.message) ?? 'Hermes approval request',
            kind: 'hermes-approval',
            rawInput: payload,
            options: [
                { optionId: 'once', name: 'Run once', kind: 'allow_once' },
                { optionId: 'session', name: 'Allow for session', kind: 'allow_always' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ]
        });
    }

}

export function createHermesMoaBackend(options: { model?: string | null; permissionMode?: string } = {}): HermesMoaBackend {
    return new HermesMoaBackend(options);
}
