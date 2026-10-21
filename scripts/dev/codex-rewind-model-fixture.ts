/** Local Responses fixture for the opt-in shared Codex Rewind browser test.
 * Run with an explicit HAPI_REWIND_MODEL_PORT and point an isolated Codex
 * provider at http://127.0.0.1:<port>/v1. No model credentials are needed. */
import { appendFile } from 'node:fs/promises';

const port = Number(process.env.HAPI_REWIND_MODEL_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set HAPI_REWIND_MODEL_PORT to an isolated test port');
const log = process.env.HAPI_REWIND_MODEL_LOG;
let count = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/shutdown') {
        setTimeout(() => { server.stop(true); process.exit(0); }, 50);
        return new Response('stopping');
    }
    if (url.pathname === '/health') return Response.json({ ready: true, count });
    if (!url.pathname.endsWith('/responses')) return new Response('missing', { status: 404 });
    const body = await request.json() as { input?: Array<Record<string, unknown>>; tools?: Array<{ name?: string }> };
    if (log) await appendFile(log, JSON.stringify(body) + '\n');
    count++;
    const input = body.input ?? [];
    const lastUser = JSON.stringify(input.filter(item => item.role === 'user').at(-1) ?? '');
    const id = `fixture-${count}`;
    let output: unknown;
    if (lastUser.includes('MAKE_FILE_SENTINEL_8F4C') && !input.some(item =>
        item.type === 'function_call_output' && String(item.call_id).startsWith('write-fixture'))) {
        const tool = body.tools?.find(tool => /^(exec_command|shell_command|shell)$/.test(tool.name ?? ''));
        if (!tool) return new Response('No native shell tool in the model request', { status: 400 });
        const command = process.platform === 'win32'
            ? "Set-Content -LiteralPath 'generated.txt' -Value 'GENERATED_8F4C'; Add-Content -LiteralPath 'existing.txt' -Value 'MODIFIED_8F4C'"
            : "printf '%s\\n' 'GENERATED_8F4C' > generated.txt; printf '%s\\n' 'MODIFIED_8F4C' >> existing.txt";
        output = { type: 'function_call', id: `fc_${count}`, call_id: `write-fixture-${count}`, name: tool.name,
            arguments: JSON.stringify(tool.name === 'exec_command' ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 500 } : { command }) };
    } else {
        const text = lastUser.includes('PROBE_CONTEXT')
            ? (JSON.stringify(input).includes('MAKE_FILE_SENTINEL_8F4C') ? 'CONTEXT_STILL_HAS_SENTINEL' : 'CONTEXT_CLEAN')
            : lastUser.includes('MAKE_FILE_SENTINEL_8F4C') ? 'FILES_CREATED' : 'FIXTURE_READY';
        output = { type: 'message', role: 'assistant', id: `msg_${count}`, content: [{ type: 'output_text', text }] };
    }
    const events = [{ type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: output },
        { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } });
} });
console.log(`Isolated Codex Rewind model fixture listening on ${server.url}`);
