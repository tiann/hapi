import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ApiClient } from '@/api/api';
import { readRunnerState } from '@/persistence';
import { isProcessAlive, killProcessByChildProcess } from '@/utils/process';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { CodexAppServerClient } from '../codexAppServerClient';
import { findRuntime, runtimeAlive, type CodexRuntimeRecord } from './registry';
import { initializeSharedClient, sharedLaunchConfig, SharedLaunchSchema, type SharedLaunchOptions } from './launch';
import { runSharedRuntime, type RuntimeReady } from './runtime';

export async function runtimeControl(runtime: CodexRuntimeRecord, method: string, sessionId: string): Promise<unknown> {
    if (!runtimeAlive(runtime)) throw new Error('Shared runtime is not alive');
    const client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
    client.setServerRequestHandler(() => {});
    try { await initializeSharedClient(client); return await client.request(method, { sessionId }); }
    finally { await client.disconnect(); }
}

export async function attachSharedSession(runtime: CodexRuntimeRecord, sessionId: string, args: string[] = [], signal?: AbortSignal): Promise<void> {
    const session = await (await ApiClient.create()).getSession(sessionId);
    if (runtime.sessions[sessionId]?.namespace !== session.namespace) throw new Error('Shared runtime namespace mismatch');
    const { threadId } = z.object({ threadId: z.string() }).parse(await runtimeControl(runtime, 'hapi/attach', sessionId));
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Native Codex attachment needs a terminal: ${sessionId}`);
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: runtime.codexHome };
    const authEnv = 'HAPI_CODEX_REMOTE_TOKEN';
    if (runtime.token) env[authEnv] = runtime.token;
    // The same executable that owns this runtime; never resolve PATH again at attach.
    const child = spawn(runtime.command, [...runtime.args, '--remote', runtime.endpoint,
        ...(runtime.token ? ['--remote-auth-token-env', authEnv] : []), 'resume', threadId, ...args],
        { stdio: 'inherit', env, cwd: session.metadata?.path ?? process.cwd(), windowsHide: false });
    let cleanup: Promise<unknown> | undefined;
    const stop = () => { cleanup ??= killProcessByChildProcess(child); };
    try {
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => code && code !== 130 && !signal?.aborted
                ? reject(new Error(`Codex terminal exited (${code})`)) : resolve());
            signal?.addEventListener('abort', stop, { once: true });
            process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
            if (signal?.aborted) stop();
        });
    } finally {
        signal?.removeEventListener('abort', stop);
        process.off('SIGTERM', stop); process.off('SIGINT', stop); process.off('SIGHUP', stop);
        await cleanup;
    }
}

export async function runSharedCodex(raw: SharedLaunchOptions): Promise<void> {
    const options = SharedLaunchSchema.parse({ ...raw, workingDirectory: raw.workingDirectory ?? getInvokedCwd() });
    if (options.existingSessionId) {
        const api = await ApiClient.create();
        const session = await api.getSession(options.existingSessionId);
        const runtime = await findRuntime(session.id);
        if (runtime) {
            if (options.startedBy === 'runner') throw new Error('Shared session is already running; attach instead of spawning another execution');
            return attachSharedSession(runtime, session.id);
        }
        if (session.active) throw new Error('Existing session is active in another or legacy runtime. Stop it explicitly before cold resume; no hot migration.');
        options.resumeSessionId ??= session.metadata?.codexSessionId;
        if (!options.resumeSessionId) throw new Error('Existing HAPI session has no Codex thread binding');
    }
    const runner = await readRunnerState();
    if (runner && isProcessAlive(runner.pid) && !runner.sharedCodexRuntime) {
        throw new Error('Running HAPI runner predates shared Codex sessions. Upgrade/restart the runner first; existing sessions are not migrated or stopped automatically.');
    }
    const launch = sharedLaunchConfig(options, options.workingDirectory!);
    if (options.startedBy === 'runner') return runSharedRuntime(options);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Native Codex launch needs a terminal');
    // Normal CLI ownership: no detached worker, inherited IPC or adoption loop.
    // A terminal attaching above never enters this owner's lifecycle.
    const stop = new AbortController();
    let ready!: (value: RuntimeReady) => void;
    const readiness = new Promise<RuntimeReady>(resolve => { ready = resolve; });
    const running = runSharedRuntime(options, ready, stop.signal);
    let attachment: Promise<void> | undefined;
    try {
        const runtime = await Promise.race([readiness, running.then(() => { throw new Error('Codex stopped before startup completed'); })]);
        attachment = attachSharedSession(runtime.runtime, runtime.sessionId, launch.tuiArgs, stop.signal);
        await Promise.race([attachment, running]);
    } finally {
        stop.abort();
        await Promise.allSettled([running, ...(attachment ? [attachment] : [])]);
    }
}
