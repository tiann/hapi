import { request } from 'node:http';

export const SESSION_HOOK_FORWARD_TIMEOUT_MS = 1_000;

function logError(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : (error ? String(error) : '');
    const suffix = detail ? `: ${detail}` : '';
    process.stderr.write(`[hook-forwarder] ${message}${suffix}\n`);
}

export type PreToolUseDecision = {
    permissionDecision: 'allow' | 'deny';
    reason?: string;
    updatedInput?: Record<string, unknown>;
};

/** Read the hook event name from a hook stdin payload, or null if unparseable. */
export function detectHookEventName(body: Buffer | string): string | null {
    try {
        const parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf-8'));
        if (parsed && typeof parsed === 'object' && typeof parsed.hook_event_name === 'string') {
            return parsed.hook_event_name;
        }
    } catch {
        // Not JSON / no event name — caller falls back to the session-start path.
    }
    return null;
}

/**
 * Wrap a permission decision in the JSON shape claude's PreToolUse hook reads
 * from stdout. `permissionDecision` is always allow/deny — never `ask` (which
 * would make claude fall back to its own TUI prompt and stall the PTY).
 */
export function buildPreToolUseStdout(decision: PreToolUseDecision): string {
    const hookSpecificOutput: Record<string, unknown> = {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.permissionDecision
    };
    if (decision.reason) {
        hookSpecificOutput.permissionDecisionReason = decision.reason;
    }
    if (decision.updatedInput) {
        hookSpecificOutput.updatedInput = decision.updatedInput;
    }
    return JSON.stringify({ hookSpecificOutput });
}

function postHook(
    port: number,
    token: string,
    path: string,
    body: Buffer,
    // Optional request timeout. Only the fire-and-forget SessionStart forward
    // sets this (so a dead hub can't stall startup); the PreToolUse bridge must
    // NOT time out here — it waits on the web approval modal, whose own hook-side
    // timeout is 3600s (generateHookSettings). Applying the 1s cap here would
    // deny every approval the user doesn't answer within one second.
    timeoutMs?: number
): Promise<{ statusCode?: number; body: string; error: boolean }> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let settled = false;
        let timedOut = false;
        const finish = (result: { statusCode?: number; body: string; error: boolean }) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const req = request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    'x-hapi-hook-token': token
                }
            },
            (res) => {
                res.on('data', (chunk) => chunks.push(chunk as Buffer));
                res.on('error', (error) => {
                    logError('Error reading hook server response', error);
                    finish({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8'), error: true });
                });
                res.on('end', () =>
                    finish({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8'), error: false })
                );
            }
        );

        req.on('error', (error) => {
            if (!timedOut) {
                logError('Failed to send hook request', error);
            }
            finish({ body: '', error: true });
        });
        if (timeoutMs !== undefined) {
            req.setTimeout(timeoutMs, () => {
                timedOut = true;
                logError(`Hook request timed out after ${timeoutMs}ms`);
                req.destroy();
                finish({ body: '', error: true });
            });
        }
        req.end(body);
    });
}

function parsePort(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }

    return port;
}

function parseArgs(args: string[]): { port: number | null; token: string | null } {
    let port: number | null = null;
    let token: string | null = null;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg) {
            continue;
        }

        if (arg === '--port' || arg === '-p') {
            port = parsePort(args[i + 1]);
            i += 1;
            continue;
        }

        if (arg.startsWith('--port=')) {
            port = parsePort(arg.slice('--port='.length));
            continue;
        }

        if (arg === '--token' || arg === '-t') {
            token = args[i + 1] ?? null;
            i += 1;
            continue;
        }

        if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length);
            continue;
        }

        if (!port) {
            port = parsePort(arg);
            continue;
        }

        if (!token) {
            token = arg;
        }
    }

    return { port, token };
}

export async function runSessionHookForwarder(args: string[]): Promise<void> {
    const { port, token } = parseArgs(args);
    if (!port) {
        logError('Invalid or missing port argument');
        process.exitCode = 1;
        return;
    }

    if (!token) {
        logError('Missing hook token');
        process.exitCode = 1;
        return;
    }

    try {
        const chunks: Buffer[] = [];
        process.stdin.resume();
        for await (const chunk of process.stdin) {
            if (typeof chunk === 'string') {
                chunks.push(Buffer.from(chunk));
            } else {
                chunks.push(chunk as Buffer);
            }
        }

        const body = Buffer.concat(chunks);

        // PTY-mode permission bridge: a PreToolUse hook must wait for the web
        // decision and echo it on stdout (allow/deny). Everything else (chiefly
        // SessionStart) keeps the original fire-and-forget behavior.
        if (detectHookEventName(body) === 'PreToolUse') {
            const response = await postHook(port, token, '/hook/pre-tool-use', body);

            // Fail closed: if the bridge is unreachable or replies oddly, deny the
            // tool rather than silently letting it run. Always exit 0 with valid
            // stdout so claude honors the decision instead of treating the hook as
            // failed (which would fall back to its own TUI prompt).
            let decision: PreToolUseDecision = {
                permissionDecision: 'deny',
                reason: 'Permission bridge unavailable.'
            };
            if (!response.error && response.statusCode === 200) {
                try {
                    const parsed = JSON.parse(response.body);
                    if (parsed?.permissionDecision === 'allow' || parsed?.permissionDecision === 'deny') {
                        decision = parsed as PreToolUseDecision;
                    }
                } catch (parseError) {
                    logError('Failed to parse pre-tool-use decision', parseError);
                }
            } else if (response.statusCode && response.statusCode >= 400) {
                logError(`Pre-tool-use hook responded with status ${response.statusCode}`);
            }

            process.stdout.write(buildPreToolUseStdout(decision));
            return;
        }

        const response = await postHook(port, token, '/hook/session-start', body, SESSION_HOOK_FORWARD_TIMEOUT_MS);
        if (response.error || (response.statusCode && response.statusCode >= 400)) {
            if (response.statusCode && response.statusCode >= 400) {
                logError(`Hook server responded with status ${response.statusCode}`);
            }
            process.exitCode = 1;
        }
    } catch (error) {
        logError('Failed to forward session hook', error);
        process.exitCode = 1;
    }
}
