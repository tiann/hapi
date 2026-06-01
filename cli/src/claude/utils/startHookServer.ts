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

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID. */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
    /** Called when a Codex PermissionRequest hook asks for an approval decision. */
    onPermissionRequest?: (data: SessionHookData) => Promise<Record<string, unknown>>;
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
    const { onSessionHook, onPermissionRequest } = options;
    const hookToken = options.token || randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
        async function readJsonBody(
            req: IncomingMessage,
            res: ServerResponse,
            timeoutMs: number
        ): Promise<SessionHookData | null> {
            let timedOut = false;
            const timeout = setTimeout(() => {
                timedOut = true;
                if (!res.headersSent) {
                    logger.debug('[hookServer] Request timeout');
                    res.writeHead(408).end('timeout');
                }
                req.destroy(new Error('Request timeout'));
            }, timeoutMs);

            try {
                const chunks: Buffer[] = [];
                for await (const chunk of req) {
                    chunks.push(chunk as Buffer);
                }
                clearTimeout(timeout);

                if (timedOut || res.headersSent || res.writableEnded) {
                    return null;
                }

                const body = Buffer.concat(chunks).toString('utf-8');
                logger.debug('[hookServer] Received hook:', body);

                try {
                    const parsed = JSON.parse(body);
                    if (!parsed || typeof parsed !== 'object') {
                        logger.debug('[hookServer] Parsed hook data is not an object');
                        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
                        return null;
                    }
                    return parsed as SessionHookData;
                } catch (parseError) {
                    logger.debug('[hookServer] Failed to parse hook data as JSON:', parseError);
                    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
                    return null;
                }
            } catch (error) {
                clearTimeout(timeout);
                if (timedOut) {
                    return null;
                }
                logger.debug('[hookServer] Error reading hook request:', error);
                if (!res.headersSent && !res.writableEnded) {
                    res.writeHead(500).end('error');
                }
                return null;
            }
        }

        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const requestPath = req.url?.split('?')[0];
            if (req.method === 'POST' && (requestPath === '/hook/session-start' || requestPath === '/hook/permission-request')) {
                const providedToken = readHookToken(req);
                if (providedToken !== hookToken) {
                    logger.debug('[hookServer] Unauthorized hook request');
                    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized');
                    req.resume();
                    return;
                }

                const timeoutMs = requestPath === '/hook/permission-request' ? 10 * 60 * 1000 : 5000;
                const data = await readJsonBody(req, res, timeoutMs);
                if (!data) {
                    return;
                }

                if (requestPath === '/hook/session-start') {
                    const sessionId = data.session_id || data.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                        onSessionHook(sessionId, data);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                        res.writeHead(422, { 'Content-Type': 'text/plain' }).end('missing session_id');
                        return;
                    }

                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                    }
                    return;
                }

                if (!onPermissionRequest) {
                    logger.debug('[hookServer] Permission hook received but no handler is registered');
                    res.writeHead(503, { 'Content-Type': 'text/plain' }).end('permission handler unavailable');
                    return;
                }

                try {
                    const result = await onPermissionRequest(data);
                    if (!res.headersSent && !res.writableEnded) {
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
                    }
                } catch (error) {
                    logger.debug('[hookServer] Error handling permission hook:', error);
                    if (!res.headersSent && !res.writableEnded) {
                        const reason = error instanceof Error ? error.message : 'Permission request failed';
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                            hookSpecificOutput: {
                                hookEventName: 'PermissionRequest',
                                decision: {
                                    behavior: 'deny',
                                    message: reason
                                }
                            }
                        }));
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
