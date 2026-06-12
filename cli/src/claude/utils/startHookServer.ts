/**
 * Dedicated HTTP server for receiving Claude session hooks.
 *
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { logger } from '@/ui/logger';

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
    [key: string]: unknown;
}

/**
 * Data received from Claude's PreToolUse hook (PTY mode only). claude sends this
 * before every tool call so we can bridge the approval to the web.
 */
export interface PreToolUseHookData {
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    permission_mode?: string;
    cwd?: string;
    hook_event_name?: string;
    [key: string]: unknown;
}

/** Decision returned to claude for a PreToolUse tool call. Never 'ask' (would stall the PTY). */
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
     * omitted, tool calls are allowed (no-op), matching --yolo behavior.
     */
    onPreToolUse?: (data: PreToolUseHookData) => Promise<PreToolUseDecision>;
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
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const requestPath = req.url?.split('?')[0];
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
                    logger.debug('[hookServer] Received session hook:', body);

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

                    const sessionId = data.session_id || data.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                        res.writeHead(422, { 'Content-Type': 'text/plain' }).end('missing session_id');
                        return;
                    }

                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                    }
                    setImmediate(() => {
                        try {
                            onSessionHook(sessionId, data);
                        } catch (error) {
                            logger.debug('[hookServer] Error dispatching session hook:', error);
                        }
                    });
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

                    // No handler wired → allow (matches --yolo no-op behavior).
                    const decision: PreToolUseDecision = options.onPreToolUse
                        ? await options.onPreToolUse(data)
                        : { permissionDecision: 'allow' };

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
