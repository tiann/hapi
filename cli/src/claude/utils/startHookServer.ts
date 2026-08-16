/**
 * Dedicated loopback HTTP server for receiving agent lifecycle hooks.
 *
 * Claude uses it for SessionStart; Codex also forwards selected tool hooks.
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
    /** Present on UserPromptSubmit/PreToolUse hooks; absent on SessionStart. */
    permission_mode?: unknown;
    [key: string]: unknown;
}

/**
 * Data received from Claude's PreToolUse hook. claude sends this
 * before every tool call so we can bridge the approval to the web.
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

/** Decision returned to claude for a PreToolUse tool call. Never 'ask' (would stall the CLI). */
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
