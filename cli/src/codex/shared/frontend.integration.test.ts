import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record } from './gateway';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { isProcessAlive, killProcessTreeByPid } from '@/utils/process';

// Test-only PTY driver, not part of the runtime. Python stdlib only; no model
// credentials or terminal scraping in the implementation.
const terminalDriver = String.raw`
import os,sys,pty,select,fcntl,termios,struct
pid,fd=pty.fork()
if pid==0: os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',42,140,0,0))
try:
    while True:
        ready,_,_=select.select([fd,0],[],[],1)
        if fd in ready:
            try: data=os.read(fd,65536)
            except OSError: break
            if not data: break
            os.write(1,data)
            for query,answer in [(b'\x1b[6n',b'\x1b[1;1R'),(b'\x1b[c',b'\x1b[?1;2c'),(b'\x1b]10;?',b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),(b'\x1b]11;?',b'\x1b]11;rgb:0000/0000/0000\x1b\\')]:
                if query in data: os.write(fd,answer)
        if 0 in ready:
            data=os.read(0,65536)
            if not data: break
            os.write(fd,data)
finally:
    os.close(fd)
    _,status=os.waitpid(pid,0)
    sys.exit(os.waitstatus_to_exitcode(status))
`;
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, description: string): Promise<T> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
        const value = await read(); if (accept(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}`);
}

function hasReply(value: Record<string, unknown>, prompt: string): boolean {
    return (Array.isArray(value.messages) ? value.messages : []).some(message => {
        const text = JSON.stringify(message); return text.includes('MOCK_DONE') && text.includes(prompt);
    });
}
// Actual CLI/Runner -> app-server + MCP + hub sockets -> actual native TUI.
// Separate from the protocol integration whose HAPI transport is mocked.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1' || process.platform === 'win32')('shared Codex full stack', () => {
    it('shares interaction, stops the primary execution, resumes through Runner and only detaches secondary terminals', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-e2e-');
        const cwd = join(home, 'work'); const ch = join(home, 'codex'); const hh = join(home, 'hapi');
        await Promise.all([cwd, ch, hh].map(path => mkdir(path)));
        const requests: Record<string, unknown>[] = [];
        const model = createServer((request, response) => {
            const chunks: Buffer[] = []; request.on('data', data => chunks.push(Buffer.from(data)));
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                const body = record(JSON.parse(Buffer.concat(chunks).toString())); requests.push(body);
                const items = Array.isArray(body.input) ? body.input.map(record) : [];
                let lastUser = -1; items.forEach((item, index) => { if (item.role === 'user') lastUser = index; });
                const prompt = JSON.stringify(items[lastUser]);
                const outputs = items.slice(lastUser + 1).filter(item => item.type === 'function_call_output');
                const id = randomUUID();
                const question = prompt.includes('ASK_SHARED') && !outputs.length;
                const environment = prompt.includes('CHECK_ROOT_ENV') && !outputs.length;
                const item = question ? { type: 'function_call', call_id: `ask_${id}`, name: 'request_user_input', arguments: JSON.stringify({
                    questions: [{ id: 'choice', header: 'Choice', question: 'Choose a shared client', options: [
                        { label: 'Terminal', description: 'Native answer' }, { label: 'Web', description: 'Web answer' }
                    ] }]
                }) } : environment ? { type: 'function_call', call_id: `env_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf "ROOT=%s\\n" "$HAPI_SESSION_ID"' }) }
                    : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: `MOCK_DONE ${prompt} ${JSON.stringify(outputs)}` }] };
                const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
        const port = (model.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.mock_provider]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        const py = join(home, 'terminal.py'); await writeFile(py, terminalDriver);
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: ch, HAPI_HOME: hh,
            HAPI_API_URL: process.env.HAPI_API_URL, CLI_API_TOKEN: process.env.CLI_API_TOKEN,
            HAPI_INVOKED_CWD: cwd, HAPI_TEST_MARKER: process.env.HAPI_HOME, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', DEBUG: '1' };
        const terminals: ChildProcessWithoutNullStreams[] = [];
        const runtimePids = new Set<number>();
        const uploadDirectories = new Set<string>();
        let runner: ChildProcessWithoutNullStreams | undefined;
        let runnerOutput = '';
        let output = '';
        let client: CodexAppServerClient | undefined;
        const eventsAbort = new AbortController();
        let eventStream: Promise<void> | undefined;
        let webEvents = '';
        const openTerminal = (args: string[]) => {
            const child = spawn('python3', [py, process.env.HAPI_BUN_EXEC!, '--cwd', resolve('.'), resolve('src/index.ts'), ...args], { cwd, env });
            child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { output += data.toString(); });
            terminals.push(child); return child;
        };
        const base = process.env.HAPI_API_URL!;
        const auth = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: env.CLI_API_TOKEN }) });
        const jwt = String(record(await auth.json()).token);
        const api = async (path: string, body?: unknown) => {
            const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
                headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const value = record(await response.json()); if (!response.ok) throw new Error(`${path}: ${JSON.stringify(value)}`); return value;
        };
        try {
            runner = spawn(process.env.HAPI_BUN_EXEC!, ['--cwd', resolve('.'), resolve('src/index.ts'), 'runner', 'start-sync'], { cwd, env });
            runner.stdout.on('data', data => { runnerOutput += data.toString(); });
            runner.stderr.on('data', data => { runnerOutput += data.toString(); });
            await eventually(async () => record(JSON.parse(await readFile(join(hh, 'runner.state.json'), 'utf8').catch(() => '{}'))), value => Boolean(value.httpPort), 'ordinary Runner startup');
            const first = openTerminal(['codex', '--no-alt-screen', '--collaboration-mode', 'plan', '--permission-mode', 'read-only', '--yolo']);
            const runtime = await eventually(async () => {
                for (const name of await readdir(join(hh, 'codex-runtimes')).catch(() => [] as string[])) {
                    if (!name.endsWith('.json')) continue;
                    const value = record(JSON.parse(await readFile(join(hh, 'codex-runtimes', name), 'utf8')));
                    if (typeof value.pid === 'number') runtimePids.add(value.pid);
                    if (Object.keys(record(value.sessions)).length && value.endpoint) return value;
                }
                return {};
            }, value => Boolean(value.endpoint), 'execution readiness');
            const sessionId = Object.keys(record(runtime.sessions))[0];
            client = new CodexAppServerClient({ endpoint: String(runtime.endpoint) }); client.setServerRequestHandler(() => {}); await initializeSharedClient(client);
            await eventually(async () => output, text => text.includes('Ask Codex') || text.includes('mock-model'), 'native TUI ready');
            const detail = () => api(`/sessions/${sessionId}`);
            await eventually(detail, value => record(value.session).active === true, 'hub active');
            const settings = record(await client.request('thread/resume', { threadId: record(record(runtime.sessions)[sessionId]).threadId }));
            expect(settings.sandbox).toMatchObject({ type: 'readOnly' });
            const send = async (text: string) => api(`/sessions/${sessionId}/messages`, { text, localId: randomUUID() });
            // Reproduce the actual surface order: first a native turn, then
            // opening Web, then Web input. Check replies, not just prompt echoes.
            first.stdin.write('HELLO_NATIVE'); await new Promise(resolve => setTimeout(resolve, 150)); first.stdin.write('\r');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => JSON.stringify(value).includes('HELLO_NATIVE'), 'native message in hub');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => JSON.stringify(value).includes('MOCK_DONE'), 'native answer in Web history');
            const eventsResponse = await fetch(`${base}/api/events?sessionId=${sessionId}`, { headers: { Authorization: `Bearer ${jwt}` }, signal: eventsAbort.signal });
            expect(eventsResponse.ok).toBe(true);
            eventStream = (async () => {
                const reader = eventsResponse.body!.getReader(); const decoder = new TextDecoder();
                for (;;) { const chunk = await reader.read(); if (chunk.done) return; webEvents += decoder.decode(chunk.value, { stream: true }); }
            })().catch(error => { if (!eventsAbort.signal.aborted) throw error; });
            await send('HELLO_SHARED');
            await eventually(async () => output, text => text.includes('HELLO_SHARED'), 'Web input in native TUI');
            const hasSharedReply = (value: string) => value.split('\n').some(line => line.includes('MOCK_DONE') && line.includes('HELLO_SHARED'));
            await eventually(async () => webEvents, hasSharedReply, 'Web answer over live SSE');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => hasReply(value, 'HELLO_SHARED'), 'Web answer persisted');
            await eventually(detail, value => !record(value.session).thinking, 'native turn idle');
            await send('ASK_SHARED');
            const pending = await eventually(detail, value => Object.keys(record(record(record(value.session).agentState).requests)).length > 0, 'Web question');
            const requestId = Object.keys(record(record(record(pending.session).agentState).requests))[0];
            expect(record(record(pending.session).agentState).steeringActive).toBe(true);
            const questionCallId = record(record(record(record(pending.session).agentState).requests)[requestId]).toolCallId;
            await api(`/sessions/${sessionId}/permissions/${encodeURIComponent(requestId)}/approve`, { answers: { choice: ['Web'] } });
            await eventually(async () => requests, value => JSON.stringify(value).includes('\\"answers\\":[\\"Web\\"]'), 'native question answer');
            await eventually(detail, value => record(record(record(record(value.session).agentState).completedRequests)[requestId]).status === 'resolved', 'neutral resolved status');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => {
                const messages = (value.messages as unknown[]).map(message => record(record(record(record(message).content).content).data));
                return messages.some(message => message.type === 'tool-call' && message.callId === questionCallId && message.name === 'request_user_input')
                    && messages.some(message => message.type === 'tool-call-result' && message.callId === questionCallId
                        && record(message.output).status === 'resolved' && !('answers' in record(message.output)));
            }, 'request-only question and neutral resolution persisted for reload');
            await eventually(detail, value => record(record(value.session).agentState).steeringActive === false, 'Steer clears at turn completion');
            const terminalQuestionOutput = output.length;
            await send('ASK_SHARED_NATIVE');
            const nativePending = await eventually(detail, value => Object.keys(record(record(record(value.session).agentState).requests)).length > 0, 'native-answer question');
            const nativeRequestId = Object.keys(record(record(record(nativePending.session).agentState).requests))[0];
            await eventually(async () => output.slice(terminalQuestionOutput), text => text.includes('Choose a shared client'), 'native question visible');
            await new Promise(resolve => setTimeout(resolve, 200)); first.stdin.write('\r');
            await eventually(async () => requests, value => JSON.stringify(value).includes('\\"answers\\":[\\"Terminal\\"]'), 'real terminal keyboard answer');
            await eventually(detail, value => record(record(record(record(value.session).agentState).completedRequests)[nativeRequestId]).status === 'resolved', 'terminal answer closes Web controls');
            await send('CHECK_ROOT_ENV');
            await eventually(async () => requests, value => JSON.stringify(value).includes(`ROOT=${sessionId}`), 'per-root shell identity');
            await eventually(async () => webEvents, value => value.includes('CodexBash') && value.includes('tool-call-result') && value.includes(`ROOT=${sessionId}`), 'tool call and result over Web SSE');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => JSON.stringify(value).includes('CodexBash'), 'tool call persisted for Web reload');
            const secondOutput = output.length;
            const second = openTerminal(['resume', sessionId]);
            await eventually(async () => output.slice(secondOutput), text => text.includes('HELLO_SHARED'), 'secondary attach to terminal-owned engine');
            second.stdin.write('/exit'); await new Promise(resolve => setTimeout(resolve, 150)); second.stdin.write('\r');
            await eventually(async () => second.exitCode, value => value !== null, 'secondary detach');
            expect(record((await detail()).session).active).toBe(true); expect(isProcessAlive(Number(runtime.serverPid))).toBe(true);
            const machineId = String(record(record((await detail()).session).metadata).machineId);
            const webCreated = await api(`/machines/${machineId}/spawn`, { directory: cwd, agent: 'codex' });
            expect(webCreated.type).toBe('success'); const webId = String(webCreated.sessionId);
            const webDetail = () => api(`/sessions/${webId}`);
            const independent = await eventually(webDetail, value => record(value.session).active === true, 'Web-created execution');
            runtimePids.add(Number(record(record(independent.session).metadata).hostPid));
            await api(`/sessions/${webId}/messages`, { text: 'HELLO_WEB_CREATED', localId: randomUUID() });
            await eventually(() => api(`/sessions/${webId}/messages`), value => hasReply(value, 'HELLO_WEB_CREATED'), 'new Web execution reply');
            const newAttachOutput = output.length;
            const newAttached = openTerminal(['resume', webId]);
            await eventually(async () => output.slice(newAttachOutput), text => text.includes('HELLO_WEB_CREATED'), 'attach to Web-created session');
            newAttached.stdin.write('/exit'); await new Promise(resolve => setTimeout(resolve, 150)); newAttached.stdin.write('\r');
            await eventually(async () => newAttached.exitCode, value => value !== null, 'detach from Web-created session');
            expect(record((await webDetail()).session).active).toBe(true);
            const suspendedSibling = await api(`/sessions/${sessionId}/clear`, {});
            first.stdin.write('/exit'); await new Promise(resolve => setTimeout(resolve, 150)); first.stdin.write('\r');
            await eventually(async () => first.exitCode, value => value !== null, 'primary terminal exit'); expect(first.exitCode).toBe(0);
            const inactive = await eventually(detail, value => record(value.session).active === false, 'primary exit becomes inactive');
            expect(record(record(inactive.session).metadata).lifecycleState).not.toBe('archived');
            const siblingInactive = await eventually(() => api(`/sessions/${suspendedSibling.sessionId}`), value => record(value.session).active === false, 'same-execution siblings suspend');
            expect(record(record(siblingInactive.session).metadata).lifecycleState).not.toBe('archived');
            expect(isProcessAlive(Number(runtime.serverPid))).toBe(false);
            expect(record((await webDetail()).session).active).toBe(true);
            await client.disconnect();
            // /clear and /new use this endpoint on all clients. Inactive clear
            // must resume through the ordinary Runner, then create a new root.
            const coldClear = await api(`/sessions/${sessionId}/clear`, {});
            expect(coldClear.sessionId).not.toBe(sessionId);
            const webResumed = await eventually(detail, value => record(value.session).active === true, 'Web resumed through Runner');
            const resumedPid = Number(record(record(webResumed.session).metadata).hostPid); runtimePids.add(resumedPid);
            expect(resumedPid).not.toBe(runtime.pid);
            expect(record(record(webResumed.session).metadata).codexSessionId).toBe(record(record(runtime.sessions)[sessionId]).threadId);
            const readRuntime = async (pid: number) => {
                for (const name of await readdir(join(hh, 'codex-runtimes'))) {
                    if (!name.endsWith('.json')) continue;
                    const value = record(JSON.parse(await readFile(join(hh, 'codex-runtimes', name), 'utf8')));
                    if (value.pid === pid) return value;
                }
                return {};
            };
            const runnerRuntime = await readRuntime(resumedPid);
            client = new CodexAppServerClient({ endpoint: String(runnerRuntime.endpoint) }); client.setServerRequestHandler(() => {}); await initializeSharedClient(client);
            await client.request('hapi/stopSession', { sessionId: coldClear.sessionId });
            await send('AFTER_WEB_RESUME');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => hasReply(value, 'AFTER_WEB_RESUME'), 'Web reply after resume');
            const attachOutput = output.length;
            const attached = openTerminal(['resume', sessionId]);
            await eventually(async () => output.slice(attachOutput), text => text.includes('AFTER_WEB_RESUME'), 'attach to Runner-created execution');
            attached.stdin.write('/exit'); await new Promise(resolve => setTimeout(resolve, 150)); attached.stdin.write('\r');
            await eventually(async () => attached.exitCode, value => value !== null, 'Runner execution terminal detach');
            expect(isProcessAlive(Number(runnerRuntime.serverPid))).toBe(true); expect(record((await detail()).session).active).toBe(true);
            await send('AFTER_ATTACH_EXIT');
            await eventually(async () => webEvents, value => value.split('\n').some(line => line.includes('MOCK_DONE') && line.includes('AFTER_ATTACH_EXIT')), 'Runner Web reply without attached terminals');
            const next = await api(`/sessions/${sessionId}/clear`, {}); expect(next.sessionId).not.toBe(sessionId);
            expect(record((await detail()).session).metadata).toMatchObject({ codexSessionId: record(record(runtime.sessions)[sessionId]).threadId });
            const nextId = String(next.sessionId);
            const nextDetail = () => api(`/sessions/${nextId}`);
            await api(`/sessions/${nextId}/messages`, { text: 'ASK_SHARED_SIBLING', localId: randomUUID() });
            const siblingPending = await eventually(nextDetail, value => Object.keys(record(record(record(value.session).agentState).requests)).length > 0, 'sibling question');
            expect(Object.keys(record(record(record((await detail()).session).agentState).requests))).toHaveLength(0);
            const nextThread = String(record(record(siblingPending.session).metadata).codexSessionId);
            const queueId = randomUUID();
            await api(`/sessions/${nextId}/messages`, { text: 'NATIVE_QUEUE_EDIT', localId: queueId });
            const queued = await eventually(async () => record(await client!.request('thread/queue/list', { threadId: nextThread })), value =>
                Array.isArray(value.data) && value.data.some(item => record(item).clientUserMessageId === queueId), 'native busy queue');
            const submission = (queued.data as unknown[]).map(record).find(item => item.clientUserMessageId === queueId)!;
            await client.request('thread/queue/update', { threadId: nextThread, queuedSubmissionId: submission.id,
                input: [{ type: 'text', text: 'NATIVE_QUEUE_EDITED', text_elements: [] }] });
            await eventually(() => api(`/sessions/${nextId}/messages`), value => JSON.stringify(value).includes('NATIVE_QUEUE_EDITED'), 'native queue edit in Web');
            await client.request('thread/queue/delete', { threadId: nextThread, queuedSubmissionId: submission.id });
            await eventually(() => api(`/sessions/${nextId}/messages`), value => !JSON.stringify(value).includes(queueId), 'confirmed queue deletion in Web');
            await eventually(detail, value => !record(value.session).thinking, 'root idle before fork');
            const fork = await api(`/sessions/${sessionId}/fork`, {});
            const forkSession = record((await api(`/sessions/${fork.sessionId}`)).session);
            expect(record(forkSession.metadata)).toMatchObject({ forkedFrom: sessionId, hostPid: resumedPid });
            await client.request('hapi/stopSession', { sessionId: fork.sessionId });
            expect(Object.keys(record(record(record((await nextDetail()).session).agentState).requests))).toHaveLength(1);
            await client.request('hapi/stopSession', { sessionId: next.sessionId });
            expect(record((await detail()).session).active).toBe(true);
            // A cold restart must reuse the HAPI/native binding, not create a
            // duplicate root or replay the previously accepted submissions.
            const interruptedInput = randomUUID();
            await api(`/sessions/${sessionId}/messages`, { text: 'ASK_SHARED_SUSPEND', localId: interruptedInput });
            await eventually(detail, value => Object.keys(record(record(record(value.session).agentState).requests)).length > 0, 'question before execution suspension');
            const suspendedInput = randomUUID();
            const upload = await api(`/sessions/${sessionId}/upload`, { filename: 'pending.txt', mimeType: 'text/plain', content: Buffer.from('pending attachment').toString('base64') });
            expect(upload.success).toBe(true); const uploadPath = String(upload.path); uploadDirectories.add(dirname(uploadPath));
            await api(`/sessions/${sessionId}/messages`, { text: 'PRESERVE_PENDING_ON_EXIT', localId: suspendedInput,
                attachments: [{ id: randomUUID(), filename: 'pending.txt', mimeType: 'text/plain', size: 18, path: uploadPath }] });
            const nativeThread = String(record(record(runtime.sessions)[sessionId]).threadId);
            await eventually(async () => record(await client!.request('thread/queue/list', { threadId: nativeThread })), value => JSON.stringify(value).includes(suspendedInput), 'pending native input before suspension');
            const nativeQueuedInput = randomUUID();
            await client.request('thread/queue/add', { threadId: nativeThread, clientUserMessageId: nativeQueuedInput,
                input: [{ type: 'text', text: 'PRESERVE_NATIVE_QUEUE_ON_EXIT', text_elements: [] }] });
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => (value.messages as unknown[]).map(record).some(message =>
                message.localId === nativeQueuedInput && message.invokedAt === null
                    && record(record(message.content).meta).isNativeQueuedMessage === true), 'terminal-origin queued prompt mirrored as replayable');
            process.kill(resumedPid, 'SIGTERM');
            const stopped = await eventually(detail, value => record(value.session).active === false, 'ordinary execution shutdown');
            expect(record(record(stopped.session).agentState).steeringActive).toBe(false);
            await eventually(async () => isProcessAlive(resumedPid), alive => !alive, 'wrapper has exited, including upload cleanup hooks');
            expect(await readFile(uploadPath, 'utf8')).toBe('pending attachment');
            await client.disconnect();
            const pendingHistory = await api(`/sessions/${sessionId}/messages`);
            expect((pendingHistory.messages as unknown[]).map(record).find(message => message.localId === suspendedInput)?.invokedAt).toBeNull();
            output = ''; openTerminal(['resume', sessionId]);
            const recovered = await eventually(async () => {
                for (const name of await readdir(join(hh, 'codex-runtimes'))) {
                    if (!name.endsWith('.json')) continue;
                    const value = record(JSON.parse(await readFile(join(hh, 'codex-runtimes', name), 'utf8')));
                    if (typeof value.pid === 'number') runtimePids.add(value.pid);
                    if (record(record(value.sessions)[sessionId]).active === true && value.endpoint) return value;
                }
                return {};
            }, value => Boolean(value.endpoint), 'cold recovery binding');
            expect(record(record(recovered.sessions)[sessionId]).threadId).toBe(record(record(runtime.sessions)[sessionId]).threadId);
            await eventually(async () => output, text => text.includes('AFTER_ATTACH_EXIT'), 'cold native history');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => (value.messages as unknown[]).map(record).some(message => message.localId === suspendedInput && typeof message.invokedAt === 'number'), 'confirmed-unexecuted pending input delivered after resume');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => hasReply(value, 'PRESERVE_PENDING_ON_EXIT'), 'pending input completes exactly once');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => hasReply(value, 'PRESERVE_NATIVE_QUEUE_ON_EXIT'), 'terminal-origin queued input resumes');
            client = new CodexAppServerClient({ endpoint: String(recovered.endpoint) }); client.setServerRequestHandler(() => {}); await initializeSharedClient(client);
            // Count authoritative accepted input, not model HTTP calls (Codex
            // also calls the model for background title generation).
            const history = record(await client.request('thread/turns/list', { threadId: nativeThread, itemsView: 'full', sortDirection: 'asc', limit: 100 }));
            const userItems = (history.data as unknown[]).map(record).flatMap(turn => (turn.items as unknown[]).map(record)).filter(item => item.type === 'userMessage');
            for (const id of [suspendedInput, interruptedInput, nativeQueuedInput]) expect(userItems.filter(item => item.clientId === id)).toHaveLength(1);
            expect(JSON.stringify(userItems.find(item => item.clientId === suspendedInput))).toContain(uploadPath);
            const recoveryDetail = record((await detail()).session);
            expect(Object.keys(record(record(recoveryDetail.agentState).requests))).toHaveLength(0);
            await send('AFTER_COLD_RESUME');
            await eventually(() => api(`/sessions/${sessionId}/messages`), value => hasReply(value, 'AFTER_COLD_RESUME'), 'Web after cold resume');
            await client.request('hapi/stopSession', { sessionId });
            await api(`/sessions/${webId}/archive`, {});
            await eventually(webDetail, value => record(value.session).active === false, 'end independent Web session');
            const reopened = await api(`/sessions/${webId}/reopen`, {});
            expect(reopened.sessionId).toBe(webId);
            const reopenedSession = record((await webDetail()).session);
            expect(record(reopenedSession.metadata).codexSessionId).toBe(record(record(independent.session).metadata).codexSessionId);
            runtimePids.add(Number(record(reopenedSession.metadata).hostPid));
            await api(`/sessions/${webId}/messages`, { text: 'AFTER_ARCHIVE_REOPEN', localId: randomUUID() });
            await eventually(() => api(`/sessions/${webId}/messages`), value => hasReply(value, 'AFTER_ARCHIVE_REOPEN'), 'Web reply after reopening archived native thread');
            expect(hasReply(await api(`/sessions/${webId}/messages`), 'HELLO_WEB_CREATED')).toBe(true);
            await api(`/sessions/${webId}/archive`, {});
            await eventually(webDetail, value => record(value.session).active === false, 'end reopened Web session');
        } catch (error) {
            await writeFile('/tmp/hapi-shared-e2e-terminal.log', output + '\nRUNNER:\n' + runnerOutput);
            throw error;
        } finally {
            eventsAbort.abort(); await eventStream;
            await client?.disconnect();
            for (const child of terminals) if (child.pid && child.exitCode === null) await killProcessTreeByPid(child.pid);
            for (const pid of runtimePids) await killProcessTreeByPid(pid);
            if (runner?.pid && runner.exitCode === null) await killProcessTreeByPid(runner.pid);
            await Promise.all([...uploadDirectories].map(path => rm(path, { recursive: true, force: true })));
            await new Promise<void>(resolve => model.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 180_000);
});
