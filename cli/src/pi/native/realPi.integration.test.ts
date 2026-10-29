import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Opt in: HAPI_PI_NATIVE_INTEGRATION=1 bun run --cwd cli test src/pi/native/realPi.integration.test.ts
// Requires installed Pi, Bun, uv, and POSIX PTYs. No user config or real model API is used.
const enabled = process.env.HAPI_PI_NATIVE_INTEGRATION === '1' && process.platform !== 'win32';
const available = enabled && ['pi', 'bun', 'uv'].every(command => spawnSync(command, ['--version']).status === 0);
type Frame = Record<string, any>;

describe.skipIf(!available)('installed Pi native terminal bridge', () => {
    it('shares terminal and remote prompts, real tool execution, and /new session changes', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-real-pi-'));
        const agent = join(home, 'agent');
        const cwd = join(home, 'work');
        await mkdir(agent); await mkdir(cwd);
        await writeFile(join(cwd, 'proof.txt'), 'REAL PI TOOL RESULT\n');
        const frames: Frame[] = [];
        const requests: Frame[] = [];
        const httpErrors: string[] = [];
        const generations = new Map<string, number>();
        const token = randomUUID();
        let control: Socket | undefined;
        let output = '';
        const waitFor = async (predicate: () => boolean, label: string, timeout = 15_000) => {
            const deadline = Date.now() + timeout;
            while (!predicate()) {
                if (Date.now() > deadline) throw new Error(`Timed out: ${label}\nFrames: ${JSON.stringify(frames).slice(-5000)}\nTerminal: ${output.slice(-3000)}`);
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        };
        const controlServer = createServer(socket => {
            createInterface({ input: socket }).on('line', line => {
                const frame = JSON.parse(line) as Frame;
                if (!control) {
                    if (frame.type !== 'hello' || frame.token !== token) { socket.destroy(); return; }
                    control = socket;
                    // Do not retain the ephemeral authentication token in diagnostic output.
                    delete frame.token;
                }
                if (socket !== control) { socket.destroy(); return; }
                if (frame.type === 'event' && typeof frame.event.state?.sessionGeneration === 'number') {
                    generations.set(frame.sessionId, frame.event.state.sessionGeneration);
                }
                frames.push(frame);
            });
        });
        const http = createHttpServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                try {
                    if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected API path: ${request.url}`);
                    const body = JSON.parse(Buffer.concat(chunks).toString()) as Frame;
                    requests.push(body);
                    const last = body.messages.at(-1) as Frame;
                    const toolResult = last.role === 'tool';
                    const remote = JSON.stringify(last.content).includes('REMOTE PROMPT');
                    const delta = remote
                        ? { tool_calls: [{ index: 0, id: 'native_read', type: 'function', function: { name: 'read', arguments: '{"path":"proof.txt"}' } }] }
                        : { content: toolResult ? 'REMOTE ANSWER' : 'LOCAL ANSWER' };
                    const chunk = (part: Frame, finish: string | null = null) => ({ id: `mock-${requests.length}`, object: 'chat.completion.chunk',
                        created: 0, model: 'mock-native', choices: [{ index: 0, delta: part, finish_reason: finish }] });
                    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n\n`);
                    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
                    response.end(`data: ${JSON.stringify(chunk({}, remote ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
                } catch (error) {
                    httpErrors.push(String(error));
                    response.writeHead(500).end('Invalid isolated test request');
                }
            });
        });
        await new Promise<void>(resolve => controlServer.listen(0, '127.0.0.1', resolve));
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const modelPort = (http.address() as { port: number }).port;
        await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'hapi-test': {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'isolated-test-key',
            models: [{ id: 'mock-native', name: 'Isolated native bridge test', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
        } } }));
        await writeFile(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, showChangelog: false }));
        const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
        const child = spawn('uv', ['run', '--offline', '--no-project', 'python', join(fixture, 'realPiPty.py'), 'bun', join(fixture, 'realPiDriver.ts')], {
            cwd,
            // Deliberate allowlist: the real Pi child cannot inherit provider keys or user configuration.
            env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8',
                PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
                HAPI_TEST_PI_COMMAND: 'pi', HAPI_TEST_WORKDIR: cwd,
                HAPI_TEST_CONTROL_PORT: String((controlServer.address() as { port: number }).port), HAPI_TEST_CONTROL_TOKEN: token },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-100_000); });
        child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-100_000); });
        child.on('error', error => frames.push({ type: 'error', error: error.message }));
        const request = async (command: Frame, sessionId?: string) => {
            const id = randomUUID();
            if (sessionId && command.sessionGeneration === undefined) command = { ...command, sessionGeneration: generations.get(sessionId) };
            control!.write(JSON.stringify({ id, command, sessionId }) + '\n');
            await waitFor(() => frames.some(frame => frame.type === 'response' && frame.id === id), command.type);
            const response = frames.find(frame => frame.type === 'response' && frame.id === id)!;
            if (response.error) throw new Error(response.error);
            return response.data as Frame;
        };
        const events = (type: string, sessionId?: string) => frames.filter(frame => frame.type === 'event' && frame.event.type === type && (!sessionId || frame.sessionId === sessionId));
        try {
            await waitFor(() => frames.some(frame => frame.type === 'ready'), 'authenticated bridge startup');
            expect(frames[0]).toMatchObject({ type: 'hello', stdinTTY: true, stdoutTTY: true });
            expect(requests).toHaveLength(0);
            const initial = events('session_start')[0].sessionId as string;
            expect(Number.isInteger(generations.get(initial))).toBe(true);
            expect(await request({ type: 'get_state' })).toMatchObject({ sessionId: initial, model: { id: 'mock-native', provider: 'hapi-test' }, isStreaming: false });
            // Input goes to the native editor through the PTY, never through the bridge.
            child.stdin.write('LOCAL PROMPT\r');
            await waitFor(() => events('agent_end', initial).length === 1, 'terminal model turn');
            expect(events('input', initial).some(frame => frame.event.text === 'LOCAL PROMPT' && frame.event.source === 'interactive')).toBe(true);
            const remote = await request({ type: 'prompt', message: 'REMOTE PROMPT' }, initial);
            expect(remote).toMatchObject({ submitted: true });
            await waitFor(() => events('agent_end', initial).length === 2, 'remote model and tool turn');
            expect(events('input', initial).some(frame => frame.event.text === 'REMOTE PROMPT' && frame.event.source === 'extension')).toBe(true);
            expect(events('tool_execution_start', initial)).toHaveLength(1);
            expect(events('tool_execution_start', initial)[0].event).toMatchObject({ toolName: 'read', args: { path: 'proof.txt' } });
            expect(events('tool_execution_end', initial)[0].event).toMatchObject({ toolName: 'read', isError: false });
            expect(JSON.stringify(events('tool_execution_end', initial))).toContain('REAL PI TOOL RESULT');
            const entries = await request({ type: 'get_entries' }, initial);
            expect(JSON.stringify(entries)).toContain('LOCAL PROMPT');
            expect(JSON.stringify(entries)).toContain('REMOTE PROMPT');
            expect(JSON.stringify(entries)).toContain('LOCAL ANSWER');
            expect(JSON.stringify(entries)).toContain('REMOTE ANSWER');
            expect(requests).toHaveLength(3);
            expect(JSON.stringify(requests[1].messages)).toContain('LOCAL ANSWER');
            expect(JSON.stringify(requests[2].messages)).toContain('REAL PI TOOL RESULT');
            expect(requests.every(body => body.model === 'mock-native')).toBe(true);
            expect(httpErrors).toEqual([]);
            // Native slash commands must rotate the bridge identity without replacing the TUI process.
            child.stdin.write('/new\r');
            await waitFor(() => events('session_start').some(frame => frame.sessionId !== initial), 'terminal /new');
            const next = events('session_start').at(-1)!.sessionId as string;
            expect(next).not.toBe(initial);
            expect(await request({ type: 'get_state' }, next)).toMatchObject({ sessionId: next, isStreaming: false });
            expect((await request({ type: 'get_entries' }, next)).entries.some((entry: Frame) => entry.type === 'message')).toBe(false);
            await expect(request({ type: 'prompt', message: 'STALE MUST NOT RUN' }, initial)).rejects.toThrow('Stale Pi native session');
            const beforeReload = generations.get(next)!;
            child.stdin.write('/reload\r');
            await waitFor(() => generations.has(next) && generations.get(next) !== beforeReload, 'terminal /reload generation');
            expect(events('session_start').at(-1)!.sessionId).toBe(next);
            await expect(request({ type: 'prompt', message: 'STALE EPOCH MUST NOT RUN', sessionGeneration: beforeReload }, next))
                .rejects.toThrow('Stale Pi native session generation');
            expect(await request({ type: 'get_state' }, next)).toMatchObject({ sessionId: next, sessionGeneration: generations.get(next) });
            expect(requests).toHaveLength(3);
            expect(frames.filter(frame => frame.type === 'close' || frame.type === 'error')).toEqual([]);
            expect(output).toContain('LOCAL ANSWER');
            expect(output).toContain('REMOTE ANSWER');
        } finally {
            control?.write(JSON.stringify({ id: 'stop', stop: true }) + '\n');
            child.stdin.end();
            child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
            await closed;
            clearTimeout(timer);
            control?.destroy();
            await Promise.all([
                new Promise<void>(resolve => controlServer.close(() => resolve())),
                new Promise<void>(resolve => http.close(() => resolve()))
            ]);
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
});
