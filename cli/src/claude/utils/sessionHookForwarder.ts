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

/**
 * Build the JSON written to stdout for agy's PreToolUse hook.
 * agy reads: { decision: "allow"|"deny", reason?: string, permissionOverrides?: string[] }
 * This is intentionally different from claude's hookSpecificOutput wrapper.
 */
export function buildAgyPreToolUseStdout(decision: {
    decision: 'allow' | 'deny';
    reason?: string;
    permissionOverrides?: string[];
}): string {
    return JSON.stringify(decision);
}

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
 * would make claude fall back to its own TUI prompt and stall the CLI).
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

function parseArgs(args: string[]): {
    port: number | null;
    token: string | null;
    flavor: 'claude' | 'codex' | 'agy';
    event: 'pre-tool-use' | 'pre-invocation';
    /**
     * The raw --event value as given, or undefined if the flag was omitted
     * entirely. Lets the caller distinguish "omitted" (defaults to
     * pre-tool-use) from "provided but unrecognized" (must be rejected, not
     * silently defaulted to pre-tool-use — that would route a discovery
     * payload through the permission-gate path).
     */
    eventRaw: string | undefined;
} {
    let port: number | null = null;
    let token: string | null = null;
    let flavor: 'claude' | 'codex' | 'agy' = 'claude';
    let eventRaw: string | undefined;
    let fromEnv = false;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg) {
            continue;
        }

        if (arg === '--from-env') {
            fromEnv = true;
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

        if (arg === '--flavor') {
            const next = args[i + 1];
            if (next === 'codex' || next === 'agy') flavor = next;
            i += 1;
            continue;
        }

        if (arg.startsWith('--flavor=')) {
            const val = arg.slice('--flavor='.length);
            if (val === 'codex' || val === 'agy') flavor = val;
            continue;
        }

        if (arg === '--event') {
            // `?? ''` matters: a trailing `--event` with no following value
            // must NOT collapse to the same `undefined` that means "the flag
            // was never given at all" (which legitimately defaults to
            // pre-tool-use below) — that would silently re-open the exact
            // fail-open degrade Fix 2/6 closed for every OTHER malformed
            // --event value. An empty string is neither known event name, so
            // it falls through to the explicit rejection.
            eventRaw = args[i + 1] ?? '';
            i += 1;
            continue;
        }

        if (arg.startsWith('--event=')) {
            eventRaw = arg.slice('--event='.length);
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

    if (fromEnv) {
        port = parsePort(process.env.HAPI_AGY_HOOK_PORT);
        token = process.env.HAPI_AGY_HOOK_TOKEN?.trim() || null;
    }

    const event: 'pre-tool-use' | 'pre-invocation' = eventRaw === 'pre-invocation' ? 'pre-invocation' : 'pre-tool-use';

    return { port, token, flavor, event, eventRaw };
}

export async function runSessionHookForwarder(args: string[]): Promise<void> {
    const { port, token, flavor, event, eventRaw } = parseArgs(args);
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

    // An --event value was given but is neither known event name. Silently
    // falling back to pre-tool-use here would route a discovery payload
    // (no toolCall field) down the permission-gate path — a phantom
    // approval card for an empty tool name — and would also violate the
    // pre-invocation stdout contract (always {}). Reject explicitly instead.
    if (eventRaw !== undefined && eventRaw !== 'pre-tool-use' && eventRaw !== 'pre-invocation') {
        logError(`Unknown --event value: ${eventRaw}`);
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

        // Codex hooks are lifecycle observers here, not permission gates. An
        // empty stdout means proceed; emitting Claude's permissionDecision
        // "allow" is explicitly unsupported by Codex. Route every Codex event
        // through the generic lifecycle endpoint so PreToolUse reaches the
        // same onSessionHook callback as PostToolUse and SessionStart.
        if (flavor === 'codex') {
            const response = await postHook(
                port,
                token,
                '/hook/session-start',
                body,
                SESSION_HOOK_FORWARD_TIMEOUT_MS
            );
            if (response.error || (response.statusCode && response.statusCode >= 400)) {
                if (response.statusCode && response.statusCode >= 400) {
                    logError(`Hook server responded with status ${response.statusCode}`);
                }
                process.exitCode = 1;
            }
            return;
        }

        // agy PreInvocation: discovery-ONLY bridge, fail-OPEN. Unlike
        // PreToolUse (a permission gate that must fail-closed), a dead or
        // slow bridge here must never block or degrade the model call — the
        // only thing riding on this hook is brain-UUID discovery, which has
        // a fallback (the PreToolUse hook, or the next PreInvocation call).
        // agy's own hook-side timeout (5s, see generateHookSettings.ts)
        // bounds the worst case if the POST hangs; we also apply our own
        // shorter request timeout so a hung connection can't eat that whole
        // budget. Always emit stdout `{}` (no injectSteps) regardless of the
        // POST outcome — this is a discovery signal, not a decision.
        if (flavor === 'agy' && event === 'pre-invocation') {
            await postHook(port, token, '/hook/agy-pre-invocation', body, SESSION_HOOK_FORWARD_TIMEOUT_MS);
            process.stdout.write('{}');
            return;
        }

        // agy flavor: every hook invocation is a PreToolUse (agy has no
        // SessionStart hook). The stdin format is agy's camelCase schema
        // (toolCall.name/args); the stdout format is agy's native decision shape
        // ({ decision, reason, permissionOverrides }).
        //
        // We branch on the explicit --flavor=agy flag only — not on payload shape.
        // Shape-sniffing (detectAgyHookPayload) is intentionally NOT used here as
        // the primary gate: if claude ever emits a top-level `toolCall` field in the
        // future, shape-sniff would misclassify it and stall the claude CLI session.
        // The claude hook-forwarder is always invoked with --flavor=claude, so it
        // never reaches this branch.
        if (flavor === 'agy') {
            const response = await postHook(port, token, '/hook/pre-tool-use', body);

            // Fail closed: deny the tool if the bridge is unreachable or replies
            // oddly. agy exits 0 regardless; a non-zero exit makes it fall back to
            // its TUI prompt which stalls PTY mode.
            let agydecision: { decision: 'allow' | 'deny'; reason?: string; permissionOverrides?: string[] } = {
                decision: 'deny',
                reason: 'Permission bridge unavailable.'
            };
            if (!response.error && response.statusCode === 200) {
                try {
                    // The server JSON-serializes the full handler decision, which
                    // for agy carries `permissionOverrides` (the session-allow
                    // scoping, e.g. `command(<CommandLine>)`). PreToolUseDecision
                    // is claude's shape and omits that field, so read it via an
                    // intersection and forward it — otherwise agy never receives
                    // the override and keeps re-firing the hook for an
                    // already-session-allowed command.
                    const parsed = JSON.parse(response.body) as PreToolUseDecision & { permissionOverrides?: string[] };
                    // Server returns { permissionDecision } — map to agy's { decision }.
                    if (parsed?.permissionDecision === 'allow' || parsed?.permissionDecision === 'deny') {
                        agydecision = {
                            decision: parsed.permissionDecision,
                            reason: parsed.reason,
                            permissionOverrides: parsed.permissionOverrides
                        };
                    }
                } catch (parseError) {
                    logError('Failed to parse agy pre-tool-use decision', parseError);
                }
            } else if (response.statusCode && response.statusCode >= 400) {
                logError(`Pre-tool-use hook responded with status ${response.statusCode}`);
            }

            process.stdout.write(buildAgyPreToolUseStdout(agydecision));
            return;
        }

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
