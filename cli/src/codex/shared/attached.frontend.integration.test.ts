import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';

// Real CLI worker -> native externally owned server + real isolated Hub.
// No desktop UI automation, account tokens, or real model requests.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1' || process.platform !== 'darwin')('external attachment full stack', () => {
    it.each(['manual', 'automatic'] as const)('%s: exchanges mobile/native input, detaches without engine shutdown and reuses the Hub row', async mode => {
        const home = await mkdtemp('/tmp/hapi-attached-e2e-'); await chmod(home, 0o700);
        const cwd = join(home, 'work'); const ch = join(home, 'codex'); const hh = join(home, 'hapi');
        await Promise.all([cwd, ch, hh].map(path => mkdir(path)));
        const endpoint = `unix://${join(home, 'engine.sock')}`;
        const requests: Record<string, unknown>[] = [];
        const model = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                requests.push(record(JSON.parse(Buffer.concat(chunks).toString())));
                const id = randomUUID();
                const item = { type: 'message', role: 'assistant', id: randomUUID(), content: [{ type: 'output_text', text: `MOCK_RESPONSE_${requests.length}` }] };
                const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
        const port = (model.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"
model_provider = "isolated"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.isolated]
name = "Isolated mock"
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
[projects."${cwd}"]
trust_level = "trusted"
`);
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: ch, HAPI_HOME: hh,
            HAPI_API_URL: process.env.HAPI_API_URL, CLI_API_TOKEN: process.env.CLI_API_TOKEN, HAPI_INVOKED_CWD: cwd,
            LANG: 'en_US.UTF-8', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', DEBUG: '1' };
        let logs = '';
        const children: ChildProcess[] = [];
        const track = (child: ChildProcess) => {
            children.push(child); child.stdout?.on('data', data => { logs += data.toString(); }); child.stderr?.on('data', data => { logs += data.toString(); });
            return child;
        };
        const engine = track(spawn(process.env.HAPI_CODEX_APP_SERVER_BIN ?? 'codex', ['app-server', '--listen', endpoint], { cwd, env }));
        const cli = (args: string[]) => track(spawn(process.env.HAPI_BUN_EXEC!, ['--cwd', resolve('.'), resolve('src/index.ts'), ...args], { cwd, env }));
        const client = new CodexAppServerClient({ endpoint }); client.setServerRequestHandler(() => {});
        const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> => {
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
                const value = await read(); if (accept(value)) return value;
                await new Promise(resolve => setTimeout(resolve, 60));
            }
            throw new Error(`External full-stack timeout\n${logs}`);
        };
        const base = env.HAPI_API_URL!;
        const auth = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: env.CLI_API_TOKEN }) });
        const jwt = String(record(await auth.json()).token);
        const api = async (path: string, body?: unknown): Promise<Record<string, unknown> & { status: number }> => {
            const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
                headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: response.status, ...record(await response.json()) };
        };
        try {
            if (mode === 'automatic') {
                const control = join(ch, 'app-server-control');
                await mkdir(control, { mode: 0o700 });
                await symlink(join(home, 'engine.sock'), join(control, 'app-server-control.sock'));
                await writeFile(join(hh, 'settings.json'), JSON.stringify({ apiUrl: base, cliApiToken: env.CLI_API_TOKEN }), { mode: 0o600 });
            }
            await eventually(() => readFile(join(ch, 'config.toml'), 'utf8').then(async () => readdir(home)), names => names.includes('engine.sock'));
            await initializeSharedClient(client);
            const newThread = async () => {
                const started = record(await client.request('thread/start', { cwd, developerInstructions: 'EXTERNAL_OWNER_SENTINEL' }));
                const threadId = String(record(started.thread).id);
                await client.request('thread/metadata/update', { threadId, gitInfo: { sha: null } });
                return threadId;
            };
            const threadId = await newThread();
            const launch = () => cli(mode === 'automatic' ? ['codex-desktop', '_sync'] : ['attach', threadId, '--socket', endpoint]);
            const worker = launch();
            const readRuntime = (thread: string) => eventually(async () => {
                for (const name of await readdir(join(hh, 'codex-runtimes')).catch(() => [] as string[])) {
                    if (!name.endsWith('.json')) continue;
                    const value = record(JSON.parse(await readFile(join(hh, 'codex-runtimes', name), 'utf8')));
                    if (Object.values(record(value.sessions)).some(binding => record(binding).active && record(binding).threadId === thread)) return value;
                }
                return {};
            }, value => Boolean(value.id));
            const runtime = await readRuntime(threadId);
            expect(runtime.kind).toBe('attached'); expect(runtime.serverPid).toBeUndefined();
            const sessionId = Object.keys(record(runtime.sessions))[0]; const detail = () => api(`/sessions/${sessionId}`);
            await eventually(detail, value => record(value.session).active === true);
            expect(record(record((await detail()).session).metadata).codexRuntime).toMatchObject({ kind: 'attached' });
            let sibling: typeof detail | undefined;
            if (mode === 'automatic') {
                const siblingRuntime = await readRuntime(await newThread());
                const siblingId = Object.keys(record(siblingRuntime.sessions))[0];
                expect(siblingId).not.toBe(sessionId);
                sibling = () => api(`/sessions/${siblingId}`);
                await eventually(sibling, value => record(value.session).active === true);
                await eventually(() => api('/sessions?active=true'), value => {
                    const ids = Array.isArray(value.sessions) ? value.sessions.map(item => record(item).id) : [];
                    return ids.includes(sessionId) && ids.includes(siblingId);
                });
            }
            await api(`/sessions/${sessionId}/messages`, { text: 'FROM_MOBILE', localId: randomUUID() });
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => JSON.stringify(value).includes('MOCK_RESPONSE_1'));
            expect(JSON.stringify(requests[0])).toContain('FROM_MOBILE');
            expect(JSON.stringify(requests[0])).toContain('EXTERNAL_OWNER_SENTINEL');
            expect(JSON.stringify(requests[0])).not.toContain('mcp__hapi');
            await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'FROM_DESKTOP_PROTOCOL' }] });
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => JSON.stringify(value).includes('MOCK_RESPONSE_2'));
            const detach = cli(['detach', sessionId]);
            await eventually(async () => detach.exitCode, code => code !== null); expect(detach.exitCode).toBe(0);
            await eventually(detail, value => record(value.session).active === false);
            if (sibling) {
                expect(worker.exitCode).toBeNull();
                expect(record((await sibling()).session).active).toBe(true);
                worker.kill('SIGTERM');
                await eventually(sibling, value => record(value.session).active === false);
            }
            await eventually(async () => worker.exitCode, code => code !== null); expect(worker.exitCode).toBe(0);
            expect(engine.exitCode).toBeNull();
            expect(record(await client.request('thread/loaded/list', {})).data).toContain(threadId);
            const refused = await api(`/sessions/${sessionId}/resume`, {});
            expect(refused.status).toBeGreaterThanOrEqual(400);
            const second = launch();
            await eventually(detail, value => record(value.session).active === true);
            if (sibling) await eventually(sibling, value => record(value.session).active === true);
            else await eventually(async () => logs, value => value.split('Attached HAPI session:').length === 3);
            second.kill('SIGTERM');
            await eventually(async () => second.exitCode, code => code !== null); expect(second.exitCode).toBe(0);
            expect(engine.exitCode).toBeNull();
            expect(requests).toHaveLength(2);
        } finally {
            await client.disconnect();
            // Fixture cleanup only: production attach never owns these PIDs.
            for (const child of children.reverse()) {
                if (child.exitCode !== null || child.signalCode !== null) continue;
                child.kill('SIGTERM');
                await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
            model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 90_000);
});
