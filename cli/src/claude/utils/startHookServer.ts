/**
 * Dedicated loopback HTTP server for receiving agent lifecycle hooks.
 *
 * Claude forwards lifecycle events and local permissions; Codex forwards
 * selected lifecycle/tool events as observers only.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { logger } from '@/ui/logger';
import { LOCAL_PERMISSION_TIMEOUT_SECONDS, PermissionRequestHookSchema, type PermissionRequestHook, type LocalPermissionDecision } from './localPermissionProtocol';

/**
 * Data received from Claude's SessionStart hook.
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    /** Present on UserPromptSubmit/PreToolUse hooks; absent on SessionStart. */
    permission_mode?: unknown;
    [key: string]: unknown;
}

/**
 * Legacy PreToolUse gate payload. Local Claude now sends PreToolUse through
 * the lifecycle route and uses PermissionRequest for interactive approval.
 *
 * Also handles agy (Antigravity CLI) payloads which use camelCase:
 *   claude: { tool_name, tool_input, tool_use_id, hook_event_name, ... }
 *   agy:    { toolCall: { name, args }, conversationId, stepIdx, ... }
 */
export interface PreToolUseHookData {
    // claude fields
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    permission_mode?: string;
    cwd?: string;
    hook_event_name?: string;
    // agy fields
    toolCall?: { name?: string; args?: unknown };
    conversationId?: string;
    stepIdx?: number;
    [key: string]: unknown;
}

/** Extract a normalized tool name from a PreToolUse payload (claude or agy). */
export function extractToolName(data: PreToolUseHookData): string | undefined {
    return data.tool_name ?? data.toolCall?.name;
}

/** Extract a normalized tool input from a PreToolUse payload (claude or agy). */
export function extractToolInput(data: PreToolUseHookData): unknown {
    return data.tool_input ?? data.toolCall?.args;
}

/** Extract a normalized tool use ID from a PreToolUse payload (claude or agy). */
export function extractToolUseId(data: PreToolUseHookData): string | undefined {
    // agy uses conversationId+stepIdx as identity; claude uses tool_use_id.
    return data.tool_use_id ?? (data.conversationId ? `${data.conversationId}:${data.stepIdx ?? 0}` : undefined);
}

/** Decision shape for the legacy PreToolUse gate, also consumed by agy. */
export interface PreToolUseDecision {
    permissionDecision: 'allow' | 'deny';
    reason?: string;
    updatedInput?: Record<string, unknown>;
}

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID. */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
    /**
     * Called for each PreToolUse hook (PTY mode). Resolves with the allow/deny
     * decision once the user answers; may legitimately take minutes. When
     * omitted, no decision is made. Observation must never grant permission.
     */
    onPreToolUse?: (data: PreToolUseHookData) => Promise<PreToolUseDecision>;
    /** Main local session's native dialog remains available during this wait. */
    onPermissionRequest?: (data: PermissionRequestHook, signal: AbortSignal) => Promise<LocalPermissionDecision | null>;
    /** Optional token to require for hook requests. */
    token?: string;
}

export interface HookServer {
    /** The port the server is listening on. */
    port: number;
    /** Token required for hook requests. */
    token: string;
    /** Stop the server. */
    stop: () => void;
}

function readHookToken(req: IncomingMessage): string | null {
    const header = req.headers['x-hapi-hook-token'];
    if (Array.isArray(header)) {
        return header[0] ?? null;
    }
    return header ?? null;
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks.
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook } = options;
    const hookToken = options.token || randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
        const permissionRequests = new Set<AbortController>();
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const requestPath = req.url?.split('?')[0];
            if (req.method === 'POST' && requestPath === '/hook/permission-request') {
                if (readHookToken(req) !== hookToken) {
                    res.writeHead(401).end('unauthorized');
                    req.resume();
                    return;
                }
                const controller = new AbortController();
                permissionRequests.add(controller);
                const onClose = () => { if (!res.writableEnded) controller.abort(); };
                res.once('close', onClose);
                const bodyTimeout = setTimeout(() => req.destroy(), 5000);
                const decisionTimeout = setTimeout(() => controller.abort(), LOCAL_PERMISSION_TIMEOUT_SECONDS * 1000);
                try {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    for await (const chunk of req) {
                        size += (chunk as Buffer).length;
                        if (size > 2 * 1024 * 1024) {
                            res.writeHead(413).end('hook payload too large');
                            req.resume();
                            return;
                        }
                        chunks.push(chunk as Buffer);
                    }
                    clearTimeout(bodyTimeout);
                    const parsed = PermissionRequestHookSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    if (!parsed.success) {
                        res.writeHead(400).end('invalid permission request');
                        return;
                    }
                    if (controller.signal.aborted) return;
                    const canceled = new Promise<null>(resolveCanceled => {
                        controller.signal.addEventListener('abort', () => resolveCanceled(null), { once: true });
                    });
                    const decision = await Promise.race([
                        options.onPermissionRequest?.(parsed.data, controller.signal) ?? Promise.resolve(null),
                        canceled
                    ]);
                    if (!res.destroyed && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision ?? {}));
                    }
                } catch (error) {
                    logger.debug('[hookServer] Local permission bridge failed; retaining native prompt', error);
                    controller.abort();
                    if (!res.destroyed && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
                    }
                } finally {
                    clearTimeout(bodyTimeout);
                    clearTimeout(decisionTimeout);
                    res.removeListener('close', onClose);
                    permissionRequests.delete(controller);
                }
                return;
            }
            if (req.method === 'POST' && requestPath === '/hook/session-start') {
                const providedToken = readHookToken(req);
                if (providedToken !== hookToken) {
                    logger.debug('[hookServer] Unauthorized hook request');
                    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized');
                    req.resume();
                    return;
                }

                let timedOut = false;
                const timeout = setTimeout(() => {
                    timedOut = true;
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Request timeout');
                        res.writeHead(408).end('timeout');
                    }
                    req.destroy(new Error('Request timeout'));
                }, 5000);

                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(chunk as Buffer);
                    }
                    clearTimeout(timeout);

                    if (timedOut || res.headersSent || res.writableEnded) {
                        return;
                    }

                    const body = Buffer.concat(chunks).toString('utf-8');
                    let data: SessionHookData = {};
                    try {
                        const parsed = JSON.parse(body);
                        if (!parsed || typeof parsed !== 'object') {
                            logger.debug('[hookServer] Parsed hook data is not an object');
                            res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
                            return;
                        }
                        data = parsed as SessionHookData;
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse hook data as JSON:', parseError);
                        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
                        return;
                    }

                    const hookEventName = typeof data.hook_event_name === 'string'
                        ? data.hook_event_name
                        : 'SessionStart';
                    logger.debug(`[hookServer] Received ${hookEventName} hook`);

                    const sessionId = data.session_id || data.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                        res.writeHead(422, { 'Content-Type': 'text/plain' }).end('missing session_id');
                        return;
                    }

                    try {
                        // Dispatch before acknowledging so Codex cannot append the matching
                        // transcript output before HAPI records the nested tool lifecycle.
                        onSessionHook(sessionId, data);
                    } catch (error) {
                        logger.debug('[hookServer] Error dispatching session hook:', error);
                    }
                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                    }
                } catch (error) {
                    clearTimeout(timeout);
                    if (timedOut) {
                        return;
                    }
                    logger.debug('[hookServer] Error handling session hook:', error);
                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(500).end('error');
                    }
                }
                return;
            }

            if (req.method === 'POST' && requestPath === '/hook/pre-tool-use') {
                const providedToken = readHookToken(req);
                if (providedToken !== hookToken) {
                    logger.debug('[hookServer] Unauthorized pre-tool-use request');
                    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized');
                    req.resume();
                    return;
                }

                // No request timeout here: a permission decision may legitimately
                // wait minutes for the user to answer on their phone. claude's own
                // (generous) hook timeout bounds the wait; if it fires it kills the
                // forwarder, the socket closes, and we just stop caring about the
                // orphaned decision (it is cleaned up on session teardown).
                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(chunk as Buffer);
                    }
                    const body = Buffer.concat(chunks).toString('utf-8');

                    let data: PreToolUseHookData;
                    try {
                        const parsed = JSON.parse(body);
                        if (!parsed || typeof parsed !== 'object') {
                            res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
                            return;
                        }
                        data = parsed as PreToolUseHookData;
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse pre-tool-use data:', parseError);
                        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
                        return;
                    }

                    // No handler wired means no permission decision, not approval.
                    const decision = options.onPreToolUse
                        ? await options.onPreToolUse(data)
                        : {};

                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision));
                    }
                } catch (error) {
                    logger.debug('[hookServer] Error handling pre-tool-use hook:', error);
                    if (!res.headersSent && !res.writableEnded) {
                        // Fail closed: a tool we couldn't adjudicate is denied, not run.
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
                            JSON.stringify({ permissionDecision: 'deny', reason: 'Permission bridge error.' })
                        );
                    }
                }
                return;
            }

            if (req.method === 'POST' && requestPath === '/hook/agy-pre-invocation') {
                // agy's PreInvocation discovery hook was removed with the PTY
                // transport (agy is headless-only now; the conversation id comes
                // from the stream-json init envelope). Respond 200 so stale hook
                // configs (a leftover .agents/hooks.json in a workspace) never
                // block agy with a connection error.
                res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
                req.resume();
                return;
            }

            res.writeHead(404).end('not found');
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);

            resolve({
                port,
                token: hookToken,
                stop: () => {
                    for (const controller of permissionRequests) controller.abort();
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error:', err);
            reject(err);
        });
    });
}
