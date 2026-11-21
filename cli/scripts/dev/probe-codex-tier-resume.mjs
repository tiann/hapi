import { inheritedResumeTier, resumeTierContext } from '../../src/codex/utils/serviceTier.ts';
// Optional native persistence probe. No real profile, credentials or remote model backend.
// A fixture turn materializes native settings; its output is not the subject of this probe.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const executable = process.argv[2];
if (!executable)
    throw Error('Pass a Codex >= 0.170 executable; this probe uses only an isolated profile and local fixture backend.');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hapi-tier-inheritance-'));
const work = path.join(home, 'work');
await fs.mkdir(work);
let modelRequests = 0, finished;
const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [] }));
            return;
        }
        modelRequests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE DONE' }] };
        for (const event of [{ type: 'response.created', response: { id: 'resp_fixture' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } }])
            res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
        res.end();
    });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
let child, childDone, sequence = 0;
const pending = new Map();
function rejectPending(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    finished?.reject(error);
}
async function start(tier) {
    await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-6-astra"\nmodel_provider = "${tier === 'priority' ? 'openai' : 'fixture'}"\nservice_tier = "${tier}"\n[features]\nultrafast_mode = true\nfast_mode = true\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "${endpoint}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    child = spawn(executable, ['app-server'], { env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: endpoint }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const proc = child;
    childDone = new Promise(resolve => proc.once('close', resolve));
    proc.once('exit', (code, signal) => rejectPending(Error('Codex probe child exited: ' + (signal ?? code))));
    proc.once('error', rejectPending);
    proc.stdin.on('error', rejectPending);
    child.stderr.resume();
    let buffer = '';
    child.stdout.on('data', b => { buffer += b.toString(); for (;;) {
        let i = buffer.indexOf('\n');
        if (i < 0)
            break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
            const v = JSON.parse(line);
            if (v.method === 'turn/completed')
                finished?.resolve();
            const done = pending.get(v.id);
            if (done) {
                pending.delete(v.id);
                v.error ? done.reject(new Error(JSON.stringify(v.error))) : done.resolve(v.result);
            }
        }
        catch { }
    } });
    const initialized = await request('initialize', { clientInfo: { name: 'hapi', version: '0.36.5' }, capabilities: { experimentalApi: true } });
    console.log(JSON.stringify({ nativeVersion: initialized.userAgent.match(/[A-Za-z_-]+\/\d+\.\d+\.\d+/)?.[0] }));
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
}
function request(method, params) {
    return new Promise((resolve, reject) => {
        if (!child?.stdin.writable) return reject(Error('Codex probe child is no longer running'));
        const id = ++sequence;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('Native probe timed out: ' + method));
        }, 15000);
        pending.set(id, {
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
}
async function stop() {
    if (!child) return;
    const proc = child;
    child = undefined;
    const timer = setTimeout(() => proc.kill(), 3000);
    try {
        if (proc.stdin.writable) proc.stdin.end();
        await childDone;
    } finally {
        clearTimeout(timer);
    }
}
try {
    await start('priority');
    const cfg = await request('config/read', { includeLayers: false });
    console.log(JSON.stringify({ configuredTier: cfg.config.service_tier, provider: cfg.config.model_provider }));
    const initial = await request('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    if (initial.serviceTier !== 'priority')
        throw Error('Initial tier not inherited: ' + initial.serviceTier);
    const thread = initial.thread.id;
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => finished?.reject(Error('Mock turn timed out')), 20000);
        finished = {
            resolve: () => { clearTimeout(timer); finished = undefined; resolve(); },
            reject: error => { clearTimeout(timer); finished = undefined; reject(error); }
        };
    });
    void done.catch(() => {}); // Child exit can reject both the request and completion.
    await request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'fixture' }] });
    await done;
    await request('thread/metadata/update', { threadId: thread, gitInfo: { sha: null, branch: null, originUrl: null } });
    await request('thread/settings/update', { threadId: thread, model: 'gpt-6-astra' });
    await new Promise(r => setTimeout(r, 500));
    const loaded = await request('thread/resume', { threadId: thread, excludeTurns: true, serviceTier: null });
    if (loaded.serviceTier !== 'priority')
        throw Error('Loaded resume unexpectedly changed settings; update the gateway protocol assumption');
    console.log(JSON.stringify({ loadedResumeOverride: 'ignored', tier: loaded.serviceTier }));
    await stop();
    await start('default');
    const resumed = await request('thread/resume', { threadId: thread, excludeTurns: true, model: 'gpt-6-astra' });
    if (resumed.serviceTier !== 'priority' || resumed.modelProvider !== 'openai')
        throw Error('Saved native tier/provider regression was not reproduced');
    console.log(JSON.stringify({ withoutOverride: resumed.serviceTier, retainedProvider: resumed.modelProvider }));
    await stop();
    await start('default');
    const params = await inheritedResumeTier({ readConfig: params => request('config/read', params) }, { model: 'gpt-6-astra' }, false, work);
    const context = resumeTierContext({ model: 'gpt-6-astra' }, initial.thread, true);
    if (context.modelProvider !== 'openai')
        throw Error('HAPI lost the saved provider');
    const restored = await request('thread/resume', { ...params, threadId: thread, excludeTurns: true });
    if (restored.serviceTier !== 'default')
        throw Error('Explicit current default was not applied: ' + restored.serviceTier);
    console.log(JSON.stringify({ codex: '0.170.0', initial: initial.serviceTier, resumed: restored.serviceTier, modelRequests, paidModelRequests: 0, isolatedHome: true }));
}
finally {
    await stop();
    await new Promise(r => server.close(r));
    if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep + 'hapi-tier-inheritance-'))
        throw Error('Unsafe fixture path');
    await fs.rm(home, { recursive: true, force: true });
}
