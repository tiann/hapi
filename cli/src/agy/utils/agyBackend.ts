import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAgyModelPreset } from '@hapi/protocol';
import type { AgentBackend, AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { buildAgyEnv, resolveAgyRuntimeConfig } from './config';

type SpawnCommand = typeof spawn;

type AgyPrintRuntimeOptions = {
    model?: string;
    permissionMode?: string;
};

const AGY_NATIVE_CONVERSATION_ID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const AGY_NATIVE_CONVERSATION_ID_RE = new RegExp(`^${AGY_NATIVE_CONVERSATION_ID_PATTERN}$`);
const AGY_CONVERSATION_LOG_RE = new RegExp(
    `(?:Created conversation|Print mode: conversation=|Streaming conversation|Forwarding user message to conversation|Sending user message to conversation|GetConversationDetail: found conversation)\\s*(${AGY_NATIVE_CONVERSATION_ID_PATTERN})`,
    'g'
);
const AGY_IDENTITY_BOOTSTRAP_PROMPT = 'HAPI lifecycle identity bootstrap. Reply exactly HAPI_IDENTITY_READY. Do not use tools.';

export function isNativeAgyConversationId(sessionId: string | null | undefined): boolean {
    return typeof sessionId === 'string' && AGY_NATIVE_CONVERSATION_ID_RE.test(sessionId);
}

export function extractAgyConversationIdFromLog(text: string): string | null {
    let match: RegExpExecArray | null;
    let last: string | null = null;
    AGY_CONVERSATION_LOG_RE.lastIndex = 0;
    while ((match = AGY_CONVERSATION_LOG_RE.exec(text)) !== null) {
        last = match[1].toLowerCase();
    }
    return last;
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

function contentToPrompt(content: PromptContent[]): string {
    return content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values ?? []) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

export function getAgyLogFileSize(path: string | undefined): number {
    if (!path) {
        return 0;
    }
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}

export function readAgyLogFileFromOffset(path: string | undefined, offset: number): string {
    if (!path || !existsSync(path)) {
        return '';
    }
    const size = getAgyLogFileSize(path);
    if (size <= offset) {
        return '';
    }
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(size - offset);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        closeSync(fd);
    }
}

export function buildAgyAttemptLogFile(baseLogFile: string | undefined, attemptId: string): string | undefined {
    const trimmed = baseLogFile?.trim();
    if (!trimmed) {
        return undefined;
    }
    const safeAttemptId = attemptId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (trimmed.toLowerCase().endsWith('.log')) {
        return `${trimmed.slice(0, -4)}.${safeAttemptId}.log`;
    }
    return `${trimmed}.${safeAttemptId}.log`;
}

export function classifyAgyFailure(detail: string, attemptLog: string): string {
    if (
        /timeout waiting for response/i.test(detail)
        && /token refresh failed due to network error/i.test(attemptLog)
    ) {
        return 'auth_refresh_network_error: Antigravity token refresh failed due to a network error before the response completed';
    }
    return detail;
}

export function buildAgyPrintArgs(opts: {
    additionalDirectories?: readonly string[];
    conversationId?: string;
    logFile?: string;
    model?: string;
    permissionMode?: string;
    prompt: string;
    timeout?: string;
}): string[] {
    const args: string[] = [];
    for (const dir of uniqueNonEmpty(opts.additionalDirectories)) {
        args.push('--add-dir', dir);
    }
    if (opts.logFile?.trim()) {
        args.push('--log-file', opts.logFile.trim());
    }
    if (opts.conversationId && isNativeAgyConversationId(opts.conversationId)) {
        args.push('--conversation', opts.conversationId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.permissionMode === 'read-only' || opts.permissionMode === 'safe-yolo') {
        args.push('--sandbox');
    }
    if (opts.permissionMode === 'yolo' || opts.permissionMode === 'safe-yolo') {
        args.push('--dangerously-skip-permissions');
    }
    args.push('--print-timeout', opts.timeout ?? process.env.HAPI_AGY_PRINT_TIMEOUT ?? '30m');
    args.push('--print', opts.prompt);
    return args;
}

export class AgyPrintBackend implements AgentBackend {
    private activeChildren = new Map<string, ChildProcessWithoutNullStreams>();
    private stderrErrorHandler: ((error: Error) => void) | null = null;
    private lastNativeConversationId: string | null = null;
    private lastObservedNativeConversationId: string | null = null;

    constructor(private readonly opts: {
        additionalDirectories?: string[];
        logFile?: string;
        model?: string;
        cwd?: string;
        permissionMode?: string;
        printTimeout?: string;
        spawnCommand?: SpawnCommand;
        attemptLogIdFactory?: () => string;
    }) {}

    async initialize(): Promise<void> {
        // agy exposes no ACP/stdio control plane. Availability/auth errors surface when --print runs.
    }

    async newSession(_config: AgentSessionConfig): Promise<string> {
        const bootstrapId = `agy-bootstrap-${randomUUID()}`;
        await this.prompt(
            bootstrapId,
            [{ type: 'text', text: AGY_IDENTITY_BOOTSTRAP_PROMPT }],
            () => {},
            { permissionMode: 'read-only' }
        );
        const nativeConversationId = this.lastObservedNativeConversationId;
        if (!nativeConversationId) {
            throw new Error('Antigravity agy did not report a native conversation UUID during identity bootstrap');
        }
        return nativeConversationId;
    }

    async loadSession(config: AgentSessionConfig & { sessionId: string }): Promise<string> {
        if (!isNativeAgyConversationId(config.sessionId)) {
            throw new Error('Antigravity agy --print can only resume native Antigravity conversation UUIDs');
        }
        const requestedId = config.sessionId.toLowerCase();
        await this.prompt(
            requestedId,
            [{ type: 'text', text: AGY_IDENTITY_BOOTSTRAP_PROMPT }],
            () => {},
            { permissionMode: 'read-only' }
        );
        const observedId = this.lastObservedNativeConversationId;
        if (observedId !== requestedId) {
            throw new Error('Antigravity agy did not confirm the requested native conversation UUID during identity bootstrap');
        }
        this.lastNativeConversationId = observedId;
        return observedId;
    }

    getLastNativeConversationId(): string | null {
        return this.lastNativeConversationId;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void,
        runtimeOptions: AgyPrintRuntimeOptions = {}
    ): Promise<void> {
        this.lastObservedNativeConversationId = null;
        const prompt = contentToPrompt(content);
        const model = runtimeOptions.model ?? this.opts.model ?? resolveAgyRuntimeConfig().model;
        if (model && !isAgyModelPreset(model)) {
            throw new Error(`Invalid Antigravity agy model: ${model}`);
        }
        const permissionMode = runtimeOptions.permissionMode ?? this.opts.permissionMode;
        const env = filterEnv(buildAgyEnv({ model, cwd: this.opts.cwd }));
        const conversationId = isNativeAgyConversationId(sessionId) ? sessionId : undefined;
        const attemptLogFile = buildAgyAttemptLogFile(
            this.opts.logFile,
            (this.opts.attemptLogIdFactory ?? randomUUID)()
        );
        const args = buildAgyPrintArgs({
            additionalDirectories: this.opts.additionalDirectories,
            conversationId,
            logFile: attemptLogFile,
            model,
            permissionMode,
            prompt,
            timeout: this.opts.printTimeout
        });
        const child = (this.opts.spawnCommand ?? spawn)('agy', args, {
            cwd: this.opts.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        child.stdin.end();
        this.activeChildren.set(sessionId, child);

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (chunk) => { stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        child.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        child.on('error', (error) => {
            this.stderrErrorHandler?.(error);
        });

        const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.on('close', (code, signal) => resolve({ code, signal }));
        });
        this.activeChildren.delete(sessionId);

        const attemptLog = readAgyLogFileFromOffset(attemptLogFile, 0);
        const observedConversationId = extractAgyConversationIdFromLog(attemptLog);
        this.lastObservedNativeConversationId = observedConversationId;
        if (observedConversationId) {
            this.lastNativeConversationId = observedConversationId;
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();
        if (code === 0) {
            if (trimmedStdout) {
                onUpdate({ type: 'text', text: trimmedStdout });
            }
            if (trimmedStderr) {
                onUpdate({ type: 'error', message: trimmedStderr });
            }
            onUpdate({ type: 'turn_complete', stopReason: 'completed' });
            return;
        }

        const detail = trimmedStderr || trimmedStdout || `agy exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`;
        throw new Error(classifyAgyFailure(detail, attemptLog));
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        const child = this.activeChildren.get(sessionId);
        if (child && !child.killed) {
            child.kill('SIGTERM');
        }
        this.activeChildren.delete(sessionId);
    }

    async respondToPermission(_sessionId: string, _request: PermissionRequest, _response: PermissionResponse): Promise<void> {
        // agy --print currently exposes no structured permission request API.
    }

    onPermissionRequest(_handler: (request: PermissionRequest) => void): void {
        // agy --print currently exposes no structured permission request API.
    }

    onStderrError(handler: (error: Error) => void): void {
        this.stderrErrorHandler = handler;
    }

    async disconnect(): Promise<void> {
        for (const [sessionId, child] of this.activeChildren.entries()) {
            if (!child.killed) {
                child.kill('SIGTERM');
            }
            this.activeChildren.delete(sessionId);
        }
    }
}

export function createAgyBackend(opts: {
    additionalDirectories?: string[];
    logFile?: string;
    model?: string;
    cwd?: string;
    permissionMode?: string;
    printTimeout?: string;
    spawnCommand?: SpawnCommand;
    attemptLogIdFactory?: () => string;
}): AgyPrintBackend {
    const { model } = resolveAgyRuntimeConfig({ model: opts.model });
    return new AgyPrintBackend({
        additionalDirectories: opts.additionalDirectories,
        logFile: opts.logFile,
        model,
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        printTimeout: opts.printTimeout,
        spawnCommand: opts.spawnCommand,
        attemptLogIdFactory: opts.attemptLogIdFactory
    });
}
