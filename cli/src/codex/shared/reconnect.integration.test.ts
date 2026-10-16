import { describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { createServer as createPortReservation } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import type { ApiSessionClient } from '@/api/apiSession';
import { updateSettings, readRunnerState } from '@/persistence';
import { notifyRunnerSessionStarted } from '@/runner/controlClient';
import { buildTestChildEnv } from '@/test/integrationEnv';
import { trackChildProcess } from '@/test/processRegistry';
import { killProcessByChildProcess } from '@/utils/process';
import { configuration } from '@/configuration';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';
import { runSharedRuntime, type RuntimeReady } from './runtime';

// Capture real clients at bootstrap; no Hub, native engine, queue or transport mocks.
const captured = vi.hoisted(() => ({ sessions: new Map<string, ApiSessionClient>() }));
vi.mock('@/agent/sessionFactory', async importOriginal => {
    const original = await importOriginal<typeof import('@/agent/sessionFactory')>();
    return { ...original, bootstrapSession: async (options: Parameters<typeof original.bootstrapSession>[0]) => {
        const result = await original.bootstrapSession(options);
        captured.sessions.set(result.session.sessionId, result.session);
        return result;
    } };
});

async function eventually(check: () => Promise<boolean>, description: string, timeout = 15_000): Promise<void> {
    await vi.waitFor(async () => { if (!await check()) throw new Error(description); }, { timeout, interval: 100 });
}

// Explicit opt-in. Installed Codex, an isolated native store and local fake model;
// disposable auth comes from CLI setup; this test owns a restartable private Hub.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('Runner shared-session reconnect', () => {
    it('recovers the same live execution and preserves its in-flight turn and sibling', async () => {
        const home = await mkdtemp('/tmp/hapi-reconnect-');
        const nativeHome = join(home, 'codex');
        const requests: string[] = [];
        const runners: ChildProcess[] = [];
        const hubs: ChildProcess[] = [];
        const originalApiUrl = configuration.apiUrl;
        const stop = new AbortController();
        let running: Promise<void> | undefined;
        let native: CodexAppServerClient | undefined;
        let held: { response: ServerResponse; prompt: string } | undefined;
        const reply = (response: ServerResponse, prompt: string) => {
            const id = randomUUID();
            const events = [
                { type: 'response.created', response: { id } },
                { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`,
                    content: [{ type: 'output_text', text: `MOCK_DONE ${prompt}` }] } },
                { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
            ];
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        };
        const model = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                const body = record(JSON.parse(Buffer.concat(chunks).toString()));
                const input = Array.isArray(body.input) ? body.input.map(record) : [];
                const prompt = JSON.stringify(input.filter(item => item.role === 'user').at(-1));
                requests.push(prompt);
                if (prompt.includes('HELD_TURN')) held = { response, prompt };
                else reply(response, prompt);
            });
        });
        try {
            await mkdir(nativeHome);
            const reservation = createPortReservation();
            const hubPort = await new Promise<number>((resolve, reject) => {
                reservation.once('error', reject);
                reservation.listen(0, '127.0.0.1', () => {
                    const address = reservation.address();
                    const port = typeof address === 'object' && address ? address.port : 0;
                    reservation.close(error => error ? reject(error) : resolve(port));
                });
            });
            const hubHome = join(home, 'hub');
            await mkdir(hubHome);
            const base = `http://127.0.0.1:${hubPort}`;
            vi.stubEnv('HAPI_API_URL', base);
            configuration._setApiUrl(base);
            const startHub = async () => {
                // Explicit whitelist: never inherit a production DB or notifier.
                const child = spawn(process.env.HAPI_BUN_EXEC!, ['run', resolve('../hub/src/index.ts')], {
                    env: {
                        PATH: process.env.PATH, HOME: process.env.HOME,
                        TMPDIR: process.env.TMPDIR, BUN_INSTALL: process.env.BUN_INSTALL,
                        HAPI_HOME: hubHome, DB_PATH: join(hubHome, 'hapi.db'),
                        HAPI_LISTEN_PORT: String(hubPort), HAPI_LISTEN_HOST: '127.0.0.1',
                        HAPI_PUBLIC_URL: base, CLI_API_TOKEN: process.env.CLI_API_TOKEN,
                        HAPI_TEST_MARKER: process.env.HAPI_HOME,
                        TELEGRAM_NOTIFICATION: 'false', SERVERCHAN_NOTIFICATION: 'false',
                    }, stdio: 'ignore'
                });
                trackChildProcess(child, 'reconnect-private-hub');
                hubs.push(child);
                await eventually(async () => {
                    try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
                    catch { return false; }
                }, 'private Hub starts');
                return child;
            };
            const firstHub = await startHub();
            await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
            const port = (model.address() as { port: number }).port;
            await writeFile(join(nativeHome, 'config.toml'), `model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.mock]
name = "Local reconnect test"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
[feedback]
enabled = false
            `);
            vi.stubEnv('CODEX_HOME', nativeHome);
            await updateSettings(settings => ({ ...settings, machineId: settings.machineId ?? randomUUID() }));
            const auth = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken: process.env.CLI_API_TOKEN }) });
            const token = String(record(await auth.json()).token);
            const api = async (path: string, body?: unknown) => {
                const response = await fetch(`${base}/api${path}`, {
                    method: body === undefined ? 'GET' : 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) })
                });
                const value = record(await response.json());
                if (!response.ok) throw new Error(`${path}: ${JSON.stringify(value)}`);
                return value;
            };
            let ready!: (value: RuntimeReady) => void;
            const readiness = new Promise<RuntimeReady>(resolve => { ready = resolve; });
            running = runSharedRuntime({ workingDirectory: home, startedBy: 'runner' }, ready, stop.signal);
            const startRunner = async (codexAvailable = true) => {
                const child = spawn(process.env.HAPI_BUN_EXEC!, ['run', resolve('src/index.ts'), 'runner', 'start-sync'], {
                    env: {
                        ...buildTestChildEnv(), HAPI_RUNNER_SUPERVISED: '1',
                        ...(codexAvailable ? {} : { HAPI_CODEX_APP_SERVER_BIN: join(home, 'missing-codex') }),
                    }, stdio: 'ignore'
                });
                trackChildProcess(child, 'reconnect-runner');
                runners.push(child);
                await eventually(async () => {
                    const state = await readRunnerState();
                    return state?.pid === child.pid && Boolean(state?.httpPort);
                }, 'isolated Runner starts');
                await eventually(async () => {
                    const machines = (await api('/machines')).machines;
                    return Array.isArray(machines) && machines.some(machine => record(machine).active === true);
                }, 'Runner registered with Hub');
                return child;
            };
            const owner = await Promise.race([readiness, running.then(() => { throw new Error('Runtime ended before readiness'); })]);
            const primary = captured.sessions.get(owner.sessionId)!;
            native = new CodexAppServerClient({ endpoint: owner.runtime.endpoint, token: owner.runtime.token });
            native.setServerRequestHandler(() => {});
            await initializeSharedClient(native);
            await native.request('thread/start', { cwd: home });
            const sibling = [...captured.sessions.values()].find(session => session.sessionId !== owner.sessionId)!;
            expect(sibling).toBeDefined();
            const primarySocket = (primary as unknown as { socket: Socket }).socket;
            const siblingSocket = (sibling as unknown as { socket: Socket }).socket;
            const siblingConnection = siblingSocket.id;
            const firstRunner = await startRunner();
            expect(await notifyRunnerSessionStarted(primary.sessionId, primary.getMetadata()!)).not.toHaveProperty('error');
            expect(await killProcessByChildProcess(firstRunner)).toBe(true);
            // A real replacement Runner must load the durable live PID record.
            // Losing launch availability cannot prevent reconnecting the
            // already-running runtime, including uncached native /new roots.
            const recoveryRunner = await startRunner(false);
            const send = (sid: string, text: string) => api(`/sessions/${sid}/messages`, { text, localId: randomUUID() });
            const answered = async (sid: string, text: string) => {
                const history = await api(`/sessions/${sid}/messages`);
                return (Array.isArray(history.messages) ? history.messages : []).some(message => {
                    const content = JSON.stringify(message);
                    return content.includes('MOCK_DONE') && content.includes(text);
                });
            };
            await eventually(async () => record((await api(`/sessions/${primary.sessionId}`)).session).active === true, 'primary active');
            await send(primary.sessionId, 'HELD_TURN');
            await eventually(async () => Boolean(held), 'native turn waiting on local model');
            primarySocket.disconnect();
            // Hub liveness expires after 30 seconds; no synthetic active flag.
            await eventually(async () => record((await api(`/sessions/${primary.sessionId}`)).session).active === false, 'Hub observes disconnected CLI', 40_000);
            const [first, concurrent] = await Promise.all([
                api(`/sessions/${primary.sessionId}/resume`, {}),
                api(`/sessions/${primary.sessionId}/resume`, {})
            ]);
            expect(first.sessionId).toBe(primary.sessionId);
            expect(concurrent.sessionId).toBe(primary.sessionId);
            await eventually(async () => record((await api(`/sessions/${primary.sessionId}`)).session).active === true, 'same session reconnected');
            expect(record(record((await api(`/sessions/${primary.sessionId}`)).session).metadata).hostPid).toBe(process.pid);
            expect(siblingSocket.connected).toBe(true);
            expect(siblingSocket.id).toBe(siblingConnection);
            expect(owner.runtime.sessions[primary.sessionId].active).toBe(true);
            reply(held!.response, held!.prompt);
            held = undefined;
            await eventually(() => answered(primary.sessionId, 'HELD_TURN'), 'in-flight turn completes after reconnect');
            expect(requests.filter(prompt => prompt.includes('HELD_TURN'))).toHaveLength(1);
            await send(primary.sessionId, 'AFTER_RECONNECT');
            await send(sibling.sessionId, 'SIBLING_CONTINUES');
            await eventually(() => answered(primary.sessionId, 'AFTER_RECONNECT'), 'same old conversation accepts next message');
            await eventually(() => answered(sibling.sessionId, 'SIBLING_CONTINUES'), 'sibling continues');
            expect(siblingSocket.id).toBe(siblingConnection);

            // /new roots have no separate child PID or recovered spawn entry.
            const primaryConnection = primarySocket.id;
            siblingSocket.disconnect();
            await eventually(async () => record((await api(`/sessions/${sibling.sessionId}`)).session).active === false, 'Hub observes disconnected sibling', 40_000);
            expect((await api(`/sessions/${sibling.sessionId}/resume`, {})).sessionId).toBe(sibling.sessionId);
            await send(sibling.sessionId, 'SIBLING_RECONNECTED');
            await eventually(() => answered(sibling.sessionId, 'SIBLING_RECONNECTED'), 'uncached sibling resumes through Runner');
            expect(primarySocket.id).toBe(primaryConnection);
            expect(record(record((await api(`/sessions/${sibling.sessionId}`)).session).metadata).hostPid).toBe(process.pid);

            // Restart the actual Hub over the same database while native work
            // is waiting on the local model. Neither wrapper nor roots restart.
            await send(primary.sessionId, 'HELD_TURN_HUB_RESTART');
            await eventually(async () => Boolean(held), 'native turn held before Hub restart');
            expect(await killProcessByChildProcess(firstHub)).toBe(true);
            await eventually(async () => !primarySocket.connected && !siblingSocket.connected, 'both roots observe Hub shutdown');
            await startHub();
            await eventually(async () => record((await api(`/sessions/${primary.sessionId}`)).session).active === true, 'primary rejoins restarted Hub');
            await eventually(async () => record((await api(`/sessions/${sibling.sessionId}`)).session).active === true, 'sibling rejoins restarted Hub');
            reply(held!.response, held!.prompt);
            held = undefined;
            await eventually(() => answered(primary.sessionId, 'HELD_TURN_HUB_RESTART'), 'in-flight reply reaches restarted Hub');
            expect(requests.filter(prompt => prompt.includes('HELD_TURN_HUB_RESTART'))).toHaveLength(1);
            expect(await answered(primary.sessionId, 'AFTER_RECONNECT')).toBe(true);
            await send(sibling.sessionId, 'AFTER_HUB_RESTART');
            await eventually(() => answered(sibling.sessionId, 'AFTER_HUB_RESTART'), 'old sibling accepts new messages after Hub restart');
            expect(record(record((await api(`/sessions/${primary.sessionId}`)).session).metadata).hostPid).toBe(process.pid);

            // Ending one root must release its resume ownership even though
            // the wrapper remains alive for the sibling.
            await api(`/sessions/${primary.sessionId}/archive`, {});
            // Once cold, this root really needs an executable. Recovery must
            // not bypass launch preflight for new native executions.
            await expect(api(`/sessions/${primary.sessionId}/resume`, {})).rejects.toThrow('codex has invalid runner configuration');
            expect(await killProcessByChildProcess(recoveryRunner)).toBe(true);
            await startRunner();
            expect((await api(`/sessions/${primary.sessionId}/resume`, {})).sessionId).toBe(primary.sessionId);
            await send(primary.sessionId, 'AFTER_ARCHIVE_REOPEN');
            await eventually(() => answered(primary.sessionId, 'AFTER_ARCHIVE_REOPEN'), 'archived root cold-resumes without waiting for sibling wrapper exit');
            expect(siblingSocket.connected).toBe(true);
            const durable = JSON.parse(await readFile(`${configuration.runnerStateFile}.resume-processes.json`, 'utf8')) as unknown[];
            const primaryOwners = durable.map(record).filter(owner => owner.requestedSessionId === primary.sessionId);
            expect(primaryOwners, JSON.stringify(primaryOwners)).toHaveLength(1);
            expect(primaryOwners[0].pid).not.toBe(process.pid);
        } finally {
            held?.response.destroy();
            stop.abort();
            const cleanup = await Promise.allSettled([
                native?.disconnect(), running,
                ...runners.map(async child => {
                    if (child.exitCode === null && child.signalCode === null && !await killProcessByChildProcess(child)) {
                        throw new Error('Test Runner survived cleanup');
                    }
                })
            ]);
            const hubCleanup = await Promise.allSettled(hubs.map(async child => {
                if (child.exitCode === null && child.signalCode === null && !await killProcessByChildProcess(child)) {
                    throw new Error('Test Hub survived cleanup');
                }
            }));
            model.closeAllConnections();
            await new Promise<void>(resolve => model.close(() => resolve()));
            vi.unstubAllEnvs();
            configuration._setApiUrl(originalApiUrl);
            captured.sessions.clear();
            await rm(home, { recursive: true, force: true });
            const failed = [...cleanup, ...hubCleanup].find(result => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        }
    }, 120_000);
});
