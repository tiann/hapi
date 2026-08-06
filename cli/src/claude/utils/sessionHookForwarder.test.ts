import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
    detectHookEventName,
    buildPreToolUseStdout,
    buildAgyPreToolUseStdout,
    runSessionHookForwarder
} from './sessionHookForwarder';

describe('detectHookEventName', () => {
    it('extracts the hook event name from a JSON payload', () => {
        expect(detectHookEventName(JSON.stringify({ hook_event_name: 'PreToolUse' }))).toBe('PreToolUse');
        expect(detectHookEventName(Buffer.from(JSON.stringify({ hook_event_name: 'SessionStart' })))).toBe('SessionStart');
    });

    it('returns null for non-JSON or missing event name', () => {
        expect(detectHookEventName('not json')).toBeNull();
        expect(detectHookEventName(JSON.stringify({ session_id: 'x' }))).toBeNull();
    });
});

describe('buildPreToolUseStdout', () => {
    it('wraps an allow decision in claude hookSpecificOutput shape', () => {
        const out = JSON.parse(buildPreToolUseStdout({ permissionDecision: 'allow' }));
        expect(out).toEqual({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
        });
    });

    it('includes reason and updatedInput when present', () => {
        const out = JSON.parse(
            buildPreToolUseStdout({ permissionDecision: 'deny', reason: 'no', updatedInput: { a: 1 } })
        );
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe('no');
        expect(out.hookSpecificOutput.updatedInput).toEqual({ a: 1 });
    });
});

// --- integration: drive the forwarder against a stub hook server ---

let server: Server | null = null;

afterEach(async () => {
    if (server) {
        await new Promise<void>((r) => server!.close(() => r()));
        server = null;
    }
});

function startStub(handler: (path: string, body: string) => { status: number; body: string }): Promise<number> {
    return new Promise((resolve) => {
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c as Buffer));
            req.on('end', () => {
                const { status, body } = handler(req.url || '', Buffer.concat(chunks).toString('utf-8'));
                res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
    });
}

function startDelayedStub(
    delayMs: number,
    response: { status: number; body: string }
): Promise<number> {
    return new Promise((resolve) => {
        server = createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                setTimeout(() => {
                    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(response.body);
                }, delayMs);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
    });
}

function withStdin(payload: string, fn: () => Promise<void>): Promise<void> {
    const original = process.stdin;
    // Minimal async-iterable stdin stub.
    const fake = (async function* () {
        yield Buffer.from(payload);
    })();
    Object.defineProperty(process, 'stdin', {
        value: Object.assign(fake, { resume: () => {} }),
        configurable: true
    });
    return fn().finally(() => {
        Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    });
}

function captureStdout(): { restore: () => void; get: () => string } {
    const original = process.stdout.write.bind(process.stdout);
    let captured = '';
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        captured += s;
        return true;
    };
    return { restore: () => { (process.stdout as unknown as { write: typeof original }).write = original; }, get: () => captured };
}

describe('buildAgyPreToolUseStdout', () => {
    it('wraps an allow decision in agy native shape', () => {
        const out = JSON.parse(buildAgyPreToolUseStdout({ decision: 'allow' }));
        expect(out).toEqual({ decision: 'allow' });
    });

    it('includes reason when present', () => {
        const out = JSON.parse(buildAgyPreToolUseStdout({ decision: 'deny', reason: 'blocked' }));
        expect(out.reason).toBe('blocked');
    });

    it('does NOT wrap in hookSpecificOutput (agy reads the top-level decision)', () => {
        const out = JSON.parse(buildAgyPreToolUseStdout({ decision: 'allow' }));
        expect('hookSpecificOutput' in out).toBe(false);
    });
});

describe('runSessionHookForwarder — PreToolUse routing', () => {
    it('POSTs PreToolUse to /hook/pre-tool-use and echoes the decision on stdout', async () => {
        let hitPath = '';
        const port = await startStub((path) => {
            hitPath = path;
            return { status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) };
        });

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tc-1' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok'])
            );
        } finally {
            out.restore();
        }

        expect(hitPath).toBe('/hook/pre-tool-use');
        expect(JSON.parse(out.get())).toEqual({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
        });
    });

    it('fails closed (deny) when the bridge returns an error status', async () => {
        const port = await startStub(() => ({ status: 500, body: 'boom' }));

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tc-2' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok'])
            );
        } finally {
            out.restore();
        }

        expect(JSON.parse(out.get()).hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('does not time out a slow PreToolUse approval (waits past the 1s SessionStart cap)', async () => {
        // The web approval modal can take far longer than the 1s fire-and-forget
        // SessionStart forward cap. A forward-level timeout on the pre-tool-use
        // POST would deny every approval the user doesn't answer within one
        // second (the hook-side timeout is 3600s). Regression guard: a 1.3s
        // reply (past SESSION_HOOK_FORWARD_TIMEOUT_MS = 1s) must still allow.
        const port = await startDelayedStub(1_300, {
            status: 200,
            body: JSON.stringify({ permissionDecision: 'allow' })
        });

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tc-slow' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok'])
            );
        } finally {
            out.restore();
        }

        expect(JSON.parse(out.get()).hookSpecificOutput.permissionDecision).toBe('allow');
    }, 10_000);

    it('routes SessionStart to /hook/session-start and writes nothing to stdout', async () => {
        let hitPath = '';
        const port = await startStub((path) => {
            hitPath = path;
            return { status: 200, body: 'ok' };
        });

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok'])
            );
        } finally {
            out.restore();
        }

        expect(hitPath).toBe('/hook/session-start');
        expect(out.get()).toBe('');
    });
});

describe('runSessionHookForwarder — codex flavor', () => {
    it('forwards PreToolUse as a lifecycle event without writing a permission decision', async () => {
        let hitPath = '';
        const port = await startStub((path) => {
            hitPath = path;
            return { status: 200, body: 'ok' };
        });

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'exec-1' }),
                () => runSessionHookForwarder([
                    '--port', String(port), '--token', 'tok', '--flavor', 'codex'
                ])
            );
        } finally {
            out.restore();
        }

        expect(hitPath).toBe('/hook/session-start');
        expect(out.get()).toBe('');
    });
});

describe('runSessionHookForwarder — agy flavor', () => {
    it('reads the agy hook endpoint from env without embedding secrets in hooks.json', async () => {
        const port = await startStub(() => ({ status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) }));
        const payload = JSON.stringify({ toolCall: { name: 'run_command', args: {} } });
        const out = captureStdout();
        const previousPort = process.env.HAPI_AGY_HOOK_PORT;
        const previousToken = process.env.HAPI_AGY_HOOK_TOKEN;
        process.env.HAPI_AGY_HOOK_PORT = String(port);
        process.env.HAPI_AGY_HOOK_TOKEN = 'tok';
        try {
            await withStdin(payload, () => runSessionHookForwarder(['--from-env', '--flavor', 'agy']));
            expect(JSON.parse(out.get())).toMatchObject({ decision: 'allow' });
        } finally {
            out.restore();
            if (previousPort === undefined) delete process.env.HAPI_AGY_HOOK_PORT;
            else process.env.HAPI_AGY_HOOK_PORT = previousPort;
            if (previousToken === undefined) delete process.env.HAPI_AGY_HOOK_TOKEN;
            else process.env.HAPI_AGY_HOOK_TOKEN = previousToken;
        }
    });
    it('POSTs agy PreToolUse to /hook/pre-tool-use and echoes agy-native decision on stdout', async () => {
        let hitPath = '';
        const port = await startStub((path) => {
            hitPath = path;
            // server returns permissionDecision; forwarder maps to agy decision
            return { status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) };
        });

        const agyPayload = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } }, conversationId: 'c-1', stepIdx: 1 });

        const out = captureStdout();
        try {
            await withStdin(agyPayload, () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy']));
        } finally {
            out.restore();
        }

        expect(hitPath).toBe('/hook/pre-tool-use');
        const response = JSON.parse(out.get());
        // agy reads top-level { decision }, not { hookSpecificOutput }
        expect(response.decision).toBe('allow');
        expect('hookSpecificOutput' in response).toBe(false);
    });

    it('forwards permissionOverrides (session-allow scoping) through to agy stdout', async () => {
        // The server JSON-serializes the full handler decision, which carries
        // permissionOverrides for session-allows (e.g. command(<CommandLine>)).
        // The forwarder must pass it through — otherwise agy never receives the
        // override and re-fires the hook for an already-session-allowed command.
        const port = await startStub(() => ({
            status: 200,
            body: JSON.stringify({ permissionDecision: 'allow', permissionOverrides: ['command(echo hi)'] })
        }));

        const agyPayload = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } }, conversationId: 'c-3', stepIdx: 1 });

        const out = captureStdout();
        try {
            await withStdin(agyPayload, () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy']));
        } finally {
            out.restore();
        }

        const response = JSON.parse(out.get());
        expect(response.decision).toBe('allow');
        expect(response.permissionOverrides).toEqual(['command(echo hi)']);
    });

    it('requires --flavor=agy flag; without it, agy-shaped payload falls through to claude path', async () => {
        // Shape-sniffing was removed to prevent future misclassification if claude
        // ever emits a top-level `toolCall` field. The --flavor flag is the only
        // reliable discriminator. Without --flavor=agy, the forwarder uses the
        // claude path (hook_event_name-based routing).
        const port = await startStub(() => ({ status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) }));

        // An agy-shaped payload without --flavor=agy: no hook_event_name, so it
        // falls through to the session-start path (not agy path).
        const agyPayload = JSON.stringify({ toolCall: { name: 'write_to_file', args: {} }, conversationId: 'c-2', stepIdx: 2 });

        const out = captureStdout();
        try {
            await withStdin(agyPayload, () => runSessionHookForwarder(['--port', String(port), '--token', 'tok']));
        } finally {
            out.restore();
        }

        // No stdout from session-start path (fire-and-forget).
        // The agy-native { decision } shape must NOT appear — it went through
        // the session-start branch instead.
        expect(out.get()).toBe('');
    });

    it('fails closed (deny) in agy format when bridge returns an error', async () => {
        const port = await startStub(() => ({ status: 500, body: 'error' }));

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ toolCall: { name: 'run_command', args: {} } }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy'])
            );
        } finally {
            out.restore();
        }

        const response = JSON.parse(out.get());
        expect(response.decision).toBe('deny');
        expect('hookSpecificOutput' in response).toBe(false);
    });
});

describe('runSessionHookForwarder — agy PreInvocation (discovery, fail-open)', () => {
    it('POSTs to /hook/agy-pre-invocation and always writes {} + exit 0 on stdout', async () => {
        let hitPath = '';
        let hitBody = '';
        const port = await startStub((path, body) => {
            hitPath = path;
            hitBody = body;
            return { status: 200, body: '{}' };
        });

        const payload = JSON.stringify({ conversationId: 'brain-1', invocationNum: 0 });
        const out = captureStdout();
        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withStdin(payload, () =>
                runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy', '--event', 'pre-invocation'])
            );
            expect(process.exitCode).toBeUndefined();
        } finally {
            out.restore();
            process.exitCode = originalExitCode;
        }

        expect(hitPath).toBe('/hook/agy-pre-invocation');
        expect(JSON.parse(hitBody).conversationId).toBe('brain-1');
        expect(out.get()).toBe('{}');
    });

    it('fails OPEN (still writes {} + exit 0) when the bridge is unreachable', async () => {
        // Port 1 is a well-known low port nothing listens on in this test
        // environment — connecting refuses immediately without needing a
        // real (and then torn-down) stub server.
        const out = captureStdout();
        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withStdin(
                JSON.stringify({ conversationId: 'brain-2' }),
                () => runSessionHookForwarder(['--port', '1', '--token', 'tok', '--flavor', 'agy', '--event', 'pre-invocation'])
            );
            expect(process.exitCode).toBeUndefined();
        } finally {
            out.restore();
            process.exitCode = originalExitCode;
        }

        expect(out.get()).toBe('{}');
    }, 10_000);

    it('fails OPEN (still writes {} + exit 0) even when the bridge replies with an error status', async () => {
        const port = await startStub(() => ({ status: 500, body: 'boom' }));

        const out = captureStdout();
        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withStdin(
                JSON.stringify({ conversationId: 'brain-3' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy', '--event', 'pre-invocation'])
            );
            expect(process.exitCode).toBeUndefined();
        } finally {
            out.restore();
            process.exitCode = originalExitCode;
        }

        expect(out.get()).toBe('{}');
    });

    it('defaults to pre-tool-use when --event is omitted (existing agy callers keep working)', async () => {
        let hitPath = '';
        const port = await startStub((path) => {
            hitPath = path;
            return { status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) };
        });

        const out = captureStdout();
        try {
            await withStdin(
                JSON.stringify({ toolCall: { name: 'run_command', args: {} }, conversationId: 'brain-4' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy'])
            );
        } finally {
            out.restore();
        }

        expect(hitPath).toBe('/hook/pre-tool-use');
        expect(JSON.parse(out.get()).decision).toBe('allow');
    });

    it('rejects an unrecognized --event value instead of silently degrading to pre-tool-use', async () => {
        // A discovery payload (no toolCall field) routed down the
        // permission-gate path would produce a phantom approval card with an
        // empty tool name and violate the pre-invocation {} stdout contract.
        // An unknown --event (typo, future value) must fail loudly instead.
        let serverHit = false;
        const port = await startStub(() => {
            serverHit = true;
            return { status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) };
        });

        const out = captureStdout();
        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withStdin(
                JSON.stringify({ conversationId: 'brain-5' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy', '--event', 'pre-invocaiton'])
            );
            expect(process.exitCode).toBe(1);
        } finally {
            out.restore();
            process.exitCode = originalExitCode;
        }

        expect(serverHit).toBe(false);
        expect(out.get()).toBe('');
    });

    it('rejects an unrecognized --event=value form the same way', async () => {
        const port = await startStub(() => ({ status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) }));

        const out = captureStdout();
        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withStdin(
                JSON.stringify({ conversationId: 'brain-6' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy', '--event=bogus'])
            );
            expect(process.exitCode).toBe(1);
        } finally {
            out.restore();
            process.exitCode = originalExitCode;
        }

        expect(out.get()).toBe('');
    });

    it('rejects a trailing --event with no value instead of silently defaulting to pre-tool-use', async () => {
        // args[i+1] is undefined when --event is the last argument — that must
        // NOT collapse to the same "flag omitted" undefined that legitimately
        // defaults to pre-tool-use, or a malformed invocation missing only the
        // value would silently reopen the fail-open degrade this whole guard
        // exists to close.
        let serverHit = false;
        const port = await startStub(() => {
            serverHit = true;
            return { status: 200, body: JSON.stringify({ permissionDecision: 'allow' }) };
        });

        const out = captureStdout();
        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withStdin(
                JSON.stringify({ conversationId: 'brain-7' }),
                () => runSessionHookForwarder(['--port', String(port), '--token', 'tok', '--flavor', 'agy', '--event'])
            );
            expect(process.exitCode).toBe(1);
        } finally {
            out.restore();
            process.exitCode = originalExitCode;
        }

        expect(serverHit).toBe(false);
        expect(out.get()).toBe('');
    });
});
