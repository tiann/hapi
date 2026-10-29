import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { PiNativeTransport } from '../transport';
import { materializePiTitleExtension } from '../../titleExtension';
import { join } from 'node:path';

// This process runs inside the PTY. Its control socket never carries terminal IO.
const titleExtension = await materializePiTitleExtension(join(process.env.PI_CODING_AGENT_DIR!, 'hapi-runtime'));
const socket = connect({ host: '127.0.0.1', port: Number(process.env.HAPI_TEST_CONTROL_PORT) });
const send = (frame: unknown) => socket.write(JSON.stringify(frame) + '\n');
const transport = new PiNativeTransport({
    command: process.env.HAPI_TEST_PI_COMMAND!,
    args: ['--extension', titleExtension,
        '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates',
        '--no-themes', '--no-context-files', '--no-approve', '--provider', 'hapi-test',
        '--model', 'mock-native', '--thinking', 'off', '--tools', 'read'],
    cwd: process.env.HAPI_TEST_WORKDIR!,
    startupTimeoutMs: 15_000,
    requestTimeoutMs: 10_000
});
transport.onEvent((event) => send({ type: 'event', ...event }));
transport.onError((error) => send({ type: 'error', error: error.message }));
transport.onClose((code, signal) => send({ type: 'close', code, signal }));
socket.on('connect', async () => {
    send({ type: 'hello', token: process.env.HAPI_TEST_CONTROL_TOKEN,
        stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true });
    try {
        await transport.start();
        send({ type: 'ready' });
    } catch (error) {
        send({ type: 'error', error: String(error) });
    }
});
const lines = createInterface({ input: socket });
lines.on('line', async (line) => {
    const frame = JSON.parse(line) as { id: string; command?: Record<string, unknown>; sessionId?: string; stop?: boolean };
    if (frame.stop) {
        transport.kill();
        socket.end();
        setTimeout(() => process.exit(0), 200);
        return;
    }
    try {
        const data = await transport.request(frame.command!, frame.sessionId);
        send({ type: 'response', id: frame.id, data });
    } catch (error) {
        send({ type: 'response', id: frame.id, error: error instanceof Error ? error.message : String(error) });
    }
});
socket.on('close', () => { transport.kill(); process.exit(0); });
socket.on('error', () => { transport.kill(); process.exit(1); });
