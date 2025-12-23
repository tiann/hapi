/**
 * Dedicated HTTP server for receiving Claude session hooks.
 *
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
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
}

export interface HookServer {
    /** The port the server is listening on. */
    port: number;
    /** Stop the server. */
    stop: () => void;
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks.
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook } = options;

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            if (req.method === 'POST' && req.url === '/hook/session-start') {
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
                        onSessionHook(sessionId, data);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                        res.writeHead(422, { 'Content-Type': 'text/plain' }).end('missing session_id');
                        return;
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
