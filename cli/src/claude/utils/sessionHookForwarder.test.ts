import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
    detectHookEventName,
    buildPreToolUseStdout,
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
