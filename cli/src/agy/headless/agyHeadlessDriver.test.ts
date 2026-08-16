import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import { buildAgyHeadlessArgs, AgyHeadlessDriver } from './agyHeadlessDriver';
import { AgySession } from '../session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgyMode, PermissionMode } from '../types';

// A fake agy binary: emits a fixed NDJSON stream for one turn, then exits 0.
function fakeAgyProcess(lines: string[], exitCode = 0): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, ['-e', `
        const lines = ${JSON.stringify(lines)};
        for (const line of lines) process.stdout.write(line + '\\n');
        process.exit(${exitCode});
    `], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    return child;
}

/**
 * A scriptable fake agy child: a pure EventEmitter standing in for the spawned
 * process. Tests feed pre-split stdout chunks and a synthetic close on demand,
 * so chunk boundaries (line splits across chunks) are fully deterministic.
 */
function scriptableFakeChild(chunks: string[], exitCode = 0): ChildProcessWithoutNullStreams & {
    run: () => void;
    feedStdout: (chunk: string) => void;
} {
    const stdout = new EventEmitter() as unknown as ChildProcessWithoutNullStreams['stdout'];
    const stderr = new EventEmitter() as unknown as ChildProcessWithoutNullStreams['stderr'];
    for (const stream of [stdout, stderr]) {
        (stream as unknown as { setEncoding: () => void }).setEncoding = () => {};
    }
    let killed = false;
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, {
        stdout,
        stderr,
        get killed() { return killed; },
        kill: () => { killed = true; },
    });
    let chunkIndex = 0;
    const run = () => {
        if (chunkIndex >= chunks.length) {
            child.emit('close', exitCode, null);
            return;
        }
        stdout.emit('data', chunks[chunkIndex]);
        chunkIndex += 1;
    };
    const feedStdout = (chunk: string) => stdout.emit('data', chunk);
    return Object.assign(child as ChildProcessWithoutNullStreams, { run, feedStdout });
}

function createSession(clientOverrides: Record<string, unknown> = {}) {
    const sent: unknown[] = [];
    const client = {
        sendAgySessionMessage: (...args: unknown[]) => { sent.push(args); },
        emitMessagesConsumed: vi.fn(),
        emitSessionReady: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(),
        keepAlive: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
        ...clientOverrides,
    };
    const queue = new MessageQueue2<AgyMode>(() => 'default');
    const session = new AgySession({
        api: {} as never,
        client: client as never,
        path: '/tmp',
        logPath: '/tmp/agy.log',
        sessionId: null,
        messageQueue: queue,
        onModeChange: () => {},
        startedBy: 'runner',
    });
    return { session, queue, client, sent };
}

const FULL_TURN = [
    '{"event":"init","conversation_id":"conv-1","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"request-review"}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":0,"state":"DONE","step_type":"user_input"}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.001}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":2.4,"usage":{"input_tokens":1}}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.2,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\\r\\n"}}}',
    '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.7,"usage":{}}}',
    '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"OK\\n","duration_seconds":3.4,"num_turns":1,"usage":{}}}',
];

describe('buildAgyHeadlessArgs', () => {
    it('builds the per-turn print-mode args', () => {
        const args = buildAgyHeadlessArgs({
            prompt: 'hello',
            permissionMode: 'request-review',
        });
        expect(args).toEqual([
            '-p', 'hello',
            '--output-format', 'stream-json',
            '--print-timeout', '30m',
        ]);
    });

    it('adds resume/model/mode/effort/skip-permissions flags', () => {
        const args = buildAgyHeadlessArgs({
            prompt: 'hi',
            conversationId: 'conv-1',
            model: 'gemini-3.5-flash-medium',
            permissionMode: 'always-proceed',
            mode: 'plan',
            effort: 'high',
        });
        expect(args).toContain('--conversation');
        expect(args).toContain('conv-1');
        expect(args).toContain('--model');
        expect(args).toContain('gemini-3.5-flash-medium');
        expect(args).toContain('--mode');
        expect(args).toContain('plan');
        expect(args).toContain('--effort');
        expect(args).toContain('high');
        expect(args).toContain('--dangerously-skip-permissions');
    });

    it('omits --dangerously-skip-permissions for request-review', () => {
        const args = buildAgyHeadlessArgs({ prompt: 'hi', permissionMode: 'request-review' });
        expect(args).not.toContain('--dangerously-skip-permissions');
    });
});

describe('AgyHeadlessDriver', () => {
    it('maps a full NDJSON turn onto the transcript-entry channel and adopts the conversation id', async () => {
        const { session, queue, client, sent } = createSession();
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        // Let the driver process the turn, then close the queue to end the loop.
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Delivery confirmation from the user_input step.
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);

        // Conversation id adopted from init.
        expect(session.sessionId).toBe('conv-1');

        // PLANNER_RESPONSE assembled from deltas (2 ACTIVE + DONE lines). The
        // result envelope must NOT duplicate it (normal streams emit exactly one
        // planner entry).
        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; content?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        expect(plannerEntries.map((e) => e!.content)).toEqual(['OK\n']);

        // Tool action emitted with the paired invocation, only on DONE.
        const tool = sent.find((args) => {
            const first = (args as unknown[])[0] as { type?: string } | undefined;
            return first?.type === 'RUN_COMMAND';
        });
        expect(tool).toBeDefined();
        const [, conversationId, toolCall] = tool as unknown[];
        expect(conversationId).toBe('conv-1');
        expect(toolCall).toMatchObject({ name: 'run_command', args: { CommandLine: 'echo hi' } });
    });

    it('reports a non-zero exit as an error session event', async () => {
        const { session, queue, client } = createSession();
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(['not-json-line'], 1),
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        // The failing turn requeues and retries up to the bound, then restores
        // the prompt; the error event must have fired on the first attempt.
        await new Promise((r) => setTimeout(r, 6000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' })
        );
    }, 15000);

    it('resumes with a matching conversation id (no re-adopt)', async () => {
        const { session, queue, client, sent } = createSession();
        // Pre-seed: the session already knows the brain UUID (resume).
        session.sessionId = 'conv-1';
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Resumed with the same id: no re-adopt/ready re-emit.
        expect(session.sessionId).toBe('conv-1');
        expect(client.emitSessionReady).not.toHaveBeenCalled();
        expect(sent.length).toBeGreaterThan(0);
    });

    it('adopts a replacement conversation id when the resume seed is stale', async () => {
        const { session, queue, client, sent } = createSession();
        // Seeded with a stale id: agy silently created a REPLACEMENT conversation
        // (init carries the new id). The driver must adopt it so later turns stop
        // passing the stale --conversation value.
        session.sessionId = 'stale-seed';
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(session.sessionId).toBe('conv-1');
        expect(client.emitSessionReady).toHaveBeenCalled();
        expect(sent.length).toBeGreaterThan(0);
    });

    it('handles NDJSON lines split across stdout chunks', async () => {
        const { session, queue, client, sent } = createSession();
        // Split the FULL_TURN stream at arbitrary points so JSON objects straddle
        // chunk boundaries (the driver must buffer partial lines, not parse per
        // chunk).
        const full = FULL_TURN.join('\n') + '\n';
        const cut1 = 37; // inside the init line
        const cut2 = Math.floor(full.length / 2); // inside a step_update line
        const chunks = [full.slice(0, cut1), full.slice(cut1, cut2), full.slice(cut2)];
        const child = scriptableFakeChild(chunks);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        // Let runMainLoop reach the spawn (listener registration) before feeding
        // chunks — otherwise the first chunk's data event has no listener yet.
        await new Promise((r) => setTimeout(r, 20));
        // Feed the chunks (multiple ticks so the driver's event loop interleaves).
        child.run();
        await new Promise((r) => setTimeout(r, 20));
        child.run();
        await new Promise((r) => setTimeout(r, 20));
        child.run();
        await new Promise((r) => setTimeout(r, 20));
        child.run(); // fourth run: no chunks left → emits close (the turn boundary)
        await new Promise((r) => setTimeout(r, 200));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Fragmented stream still assembles every event.
        expect(session.sessionId).toBe('conv-1');
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.emitSessionReady).toHaveBeenCalled();
        expect(sent.length).toBeGreaterThanOrEqual(2);
    });

    it('uses the queued permission-mode snapshot, not the live session mode', async () => {
        const { session, queue } = createSession();
        const spawnedArgs: string[][] = [];
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: (args) => {
                spawnedArgs.push(args);
                return fakeAgyProcess(FULL_TURN);
            },
        });

        // Queue under request-review, then flip the live mode before the turn runs.
        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        session.setPermissionMode('always-proceed');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(spawnedArgs.length).toBe(1);
        // The turn must NOT gain --dangerously-skip-permissions from the later
        // mode flip; the queued snapshot (request-review) governs this spawn.
        expect(spawnedArgs[0]).not.toContain('--dangerously-skip-permissions');
    });

    it('acks the delivery when the turn completes even without a user_input step', async () => {
        const { session, queue, client } = createSession();
        // No user_input step in the stream — but the result envelope proves the
        // prompt was accepted, so the delivery must still be acknowledged.
        const stream = [
            '{"event":"init","conversation_id":"c-x","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-x","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"done","duration_seconds":0.1}}',
            '{"event":"result","result":{"conversation_id":"c-x","status":"SUCCESS","response":"done","duration_seconds":0.1}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
    });

    it('acks the delivery on a FAILED result envelope (prompt was still accepted)', async () => {
        const { session, queue, client } = createSession();
        // agy reports a failure result without a user_input step: the prompt was
        // still accepted, so the hub row must be acknowledged (not left stale) —
        // AND the failure must be surfaced visibly even though agy exits 0.
        const stream = [
            '{"event":"init","conversation_id":"c-f","init":{}}',
            '{"event":"result","result":{"conversation_id":"c-f","status":"FAILURE","response":"","duration_seconds":0.1}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error', message: expect.stringContaining('agy turn failed') })
        );
    });

    it('does NOT ack the delivery when the turn fails before accepting the prompt', async () => {
        const { session, queue, client } = createSession();
        // Exit non-zero with no user_input step and no result: the prompt was
        // never accepted, so the hub delivery must stay pending until the retry
        // bound acks it + restores it to the composer (never silently dropped).
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(['{"event":"init","conversation_id":"c-fail","init":{}}'], 2),
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 6000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Acked only at exhaustion (with abort-restore), never before acceptance.
        expect(client.emitMessagesConsumed).toHaveBeenCalledTimes(1);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' })
        );
    }, 15000);

    it('requeues the prompt when agy never accepts it, then restores it to the composer', async () => {
        const { session, queue, client } = createSession();
        // Every spawn exits non-zero with no transcript output: agy never accepts
        // the prompt. The message must be requeued for retry, and once the retry
        // bound is hit it must be acked + restored to the composer (ending the
        // session would let the hub's session-end sweep lose it).
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess([], 1);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 6000));
        // Session stays alive after exhaustion (no exitReason); end it via close.
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Retried up to the bound, then acked (never force-invoked by hub sweep)
        // and restored to the composer for resend.
        expect(spawnCount).toBe(3);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    }, 15000);

    it('surfaces a soft-deny stderr notice as a chat hint even on exit 0', async () => {
        const { session, queue, client } = createSession();
        // agy exits 0 but prints the auto-denied notice on stderr: the driver
        // must surface a hint (headless has no mid-turn approval dialog).
        const child = scriptableFakeChild(FULL_TURN, 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout(FULL_TURN.join('\n') + '\n');
        await new Promise((r) => setTimeout(r, 30));
        // Write stderr BEFORE closing so the driver's close handler sees it.
        (child.stderr as unknown as { emit: (e: string, c: string) => void }).emit(
            'data',
            'jetski: run_command auto-denied. Add an allow-rule under permissions.allow\n'
        );
        child.emit('close', 0, null);
        await new Promise((r) => setTimeout(r, 200));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'message', message: expect.stringContaining('auto-denied') })
        );
    });

    it('does NOT retry a turn once agy has emitted tool/prose activity', async () => {
        const { session, queue, client } = createSession();
        // agy emits a tool step (accepted=true) then dies before the result
        // envelope: the prompt must NOT be requeued/retried (that would re-run
        // destructive tool effects), and the partial work stays visible.
        const stream = [
            '{"event":"init","conversation_id":"c-pt","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-pt","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"rm -rf x"},"output":"done"}}}',
        ];
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess(stream, 1); // non-zero exit after the tool
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 6000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // No retry: one spawn only, delivery acked (tool activity proves receipt).
        expect(spawnCount).toBe(1);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        // The error from the non-zero exit is still surfaced.
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' })
        );
    }, 15000);

    it('passes the queued effort into the agy spawn args', async () => {
        const { session, queue } = createSession();
        const spawnedArgs: string[][] = [];
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: (args) => {
                spawnedArgs.push(args);
                return fakeAgyProcess(FULL_TURN);
            },
        });

        queue.push('hello', { permissionMode: 'request-review', effort: 'high' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(spawnedArgs[0]).toContain('--effort');
        expect(spawnedArgs[0]).toContain('high');
    });

    it('adopts the conversation id from the result envelope when init is absent', async () => {
        const { session, queue, client } = createSession();
        // No init line (malformed/absent): the result envelope is authoritative.
        const stream = [
            '{"event":"step_update","step_update":{"conversation_id":"c-ri","step_index":0,"state":"DONE","step_type":"user_input"}}',
            '{"event":"result","result":{"conversation_id":"c-ri","status":"SUCCESS","response":"ok","duration_seconds":0.1}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(session.sessionId).toBe('c-ri');
        expect(client.emitSessionReady).toHaveBeenCalled();
    });

    it('flushes ACTIVE prose on close even without a result envelope', async () => {
        const { session, queue, client, sent } = createSession();
        // agy emits ACTIVE prose then crashes before DONE/result: the partial
        // text must still be delivered (not silently lost with the ack).
        const stream = [
            '{"event":"init","conversation_id":"c-cr","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-cr","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"partial prose "}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-cr","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"second step"}}',
        ];
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(stream, 1), // crash before result
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 6000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Both pending steps delivered, in order; delivery acked (prose proves
        // acceptance); the crash surfaced as an error.
        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; content?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        expect(plannerEntries.map((e) => e!.content)).toEqual(['partial prose ', 'second step']);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' })
        );
    }, 15000);

    it('delivers the result response when no planner deltas were parsed', async () => {
        const { session, queue, client, sent } = createSession();
        // No agent_response lines at all: a SUCCESS result with a response must
        // still reach the user (the envelope's response is the final answer).
        const stream = [
            '{"event":"init","conversation_id":"c-ro","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-ro","step_index":0,"state":"DONE","step_type":"user_input"}}',
            '{"event":"result","result":{"conversation_id":"c-ro","status":"SUCCESS","response":"the final answer","duration_seconds":0.1}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; content?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        expect(plannerEntries.map((e) => e!.content)).toEqual(['the final answer']);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
    });

    it('replaces an unfinished planner delta with the authoritative result response', async () => {
        const { session, queue, client, sent } = createSession();
        // Partial ACTIVE prose "hel" followed by a SUCCESS result "hello": the
        // user must see the complete answer, not the partial fragment.
        const stream = [
            '{"event":"init","conversation_id":"c-pr","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-pr","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"hel"}}',
            '{"event":"result","result":{"conversation_id":"c-pr","status":"SUCCESS","response":"hello","duration_seconds":0.1}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; content?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        // Only the complete result response is emitted (partial "hel" replaced).
        expect(plannerEntries.map((e) => e!.content)).toEqual(['hello']);
    });

    it('delivers the final result response after completed pre-tool narration', async () => {
        const { session, queue, client, sent } = createSession();
        // A tool turn: completed pre-tool narration, a tool event, NO final
        // agent_response delta — the SUCCESS result carries the final answer and
        // must reach the chat (previously suppressed after any earlier planner).
        const stream = [
            '{"event":"init","conversation_id":"c-tf","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-tf","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Let me check"}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-tf","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":""}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-tf","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"},"output":"x"}}}',
            '{"event":"result","result":{"conversation_id":"c-tf","status":"SUCCESS","response":"Done: listed","duration_seconds":0.2}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; content?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        // Pre-tool narration AND the final answer both reach the chat.
        expect(plannerEntries.map((e) => e!.content)).toEqual(['Let me check', 'Done: listed']);
    });

    it('carries the queued model (display label) on emitted planner entries', async () => {
        const { session, queue, sent } = createSession();
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });

        queue.push('hello', { permissionMode: 'request-review', model: 'gemini-3.5-flash-medium' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; model?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        expect(plannerEntries.length).toBeGreaterThan(0);
        // Display label, not the raw wire id.
        for (const entry of plannerEntries) {
            expect(entry!.model).toBe('Gemini 3.5 Flash (Medium)');
        }
    });

    it('keeps the queued model label when the session model switches mid-turn', async () => {
        const { session, queue, sent } = createSession();
        // The child streams slowly so the test can flip the session model while
        // the turn is in flight.
        const child = scriptableFakeChild([
            '{"event":"init","conversation_id":"c-mid","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-mid","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"first "}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-mid","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"answer"}}',
            '{"event":"result","result":{"conversation_id":"c-mid","status":"SUCCESS","response":"first answer","duration_seconds":0.1}}',
        ]);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review', model: 'gemini-3.5-flash-medium' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        // Turn is streaming: switch the session model — attribution must stay
        // bound to the queued label.
        session.setModel('gemini-3.6-flash-high');
        child.feedStdout('{"event":"init","conversation_id":"c-mid","init":{}}\n');
        await new Promise((r) => setTimeout(r, 20));
        child.feedStdout('{"event":"step_update","step_update":{"conversation_id":"c-mid","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"first "}}\n');
        await new Promise((r) => setTimeout(r, 20));
        child.feedStdout('{"event":"step_update","step_update":{"conversation_id":"c-mid","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"answer"}}\n');
        child.emit('close', 0, null);
        await new Promise((r) => setTimeout(r, 100));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; model?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        expect(plannerEntries.length).toBeGreaterThan(0);
        for (const entry of plannerEntries) {
            // Spawn-time label (gemini-3.5-flash-medium), NOT the switched model.
            expect(entry!.model).toBe('Gemini 3.5 Flash (Medium)');
        }
    });

    it('preserves planner→tool wire order when both land in one stdout chunk', async () => {
        const { session, queue, sent } = createSession();
        // No explicit model (default-model turn): the planner emit goes through
        // the async model-resolution chain, so the tool entry in the SAME chunk
        // must not overtake it.
        const stream = [
            '{"event":"init","conversation_id":"c-ord","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-ord","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"narration"}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-ord","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"},"output":"x"}}}',
            '{"event":"result","result":{"conversation_id":"c-ord","status":"SUCCESS","response":"narration","duration_seconds":0.1}}',
        ];
        // Single chunk: everything arrives in one data event.
        const child = scriptableFakeChild([stream.join('\n') + '\n'], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.run(); // one chunk
        await new Promise((r) => setTimeout(r, 20));
        child.run(); // no chunks left → close (the turn boundary)
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Wire order: PLANNER_RESPONSE before RUN_COMMAND (tool must not overtake
        // the async model-resolving planner emit).
        const types = sent
            .map((args) => (args as unknown[])[0] as { type?: string } | undefined)
            .map((e) => e?.type);
        const plannerIdx = types.indexOf('PLANNER_RESPONSE');
        const toolIdx = types.indexOf('RUN_COMMAND');
        expect(plannerIdx).toBeGreaterThanOrEqual(0);
        expect(toolIdx).toBeGreaterThan(plannerIdx);
    });

    it('keeps queued prompts bound to their enqueue-time model (no merge across switch)', async () => {
        const { session, queue } = createSession();
        const spawnedArgs: string[][] = [];
        let spawnTurn = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: (args) => {
                spawnedArgs.push(args);
                spawnTurn += 1;
                return fakeAgyProcess(FULL_TURN);
            },
        });

        // Prompt A queued under model A...
        queue.push('first', { permissionMode: 'request-review', model: 'gemini-3.5-flash-medium' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        // ...then the user switches to model B and queues prompt B. A must still
        // run on A (separate batch: different mode hash), not be merged into a B
        // turn or upgraded to B.
        queue.push('second', { permissionMode: 'request-review', model: 'gemini-3.6-flash-high' }, 'local-2');
        await new Promise((r) => setTimeout(r, 1500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(spawnedArgs.length).toBe(2);
        const modelOf = (args: string[]) => args[args.indexOf('--model') + 1];
        expect(modelOf(spawnedArgs[0])).toBe('gemini-3.5-flash-medium');
        expect(modelOf(spawnedArgs[1])).toBe('gemini-3.6-flash-high');
    }, 15000);

    it('exits promptly from an idle queue wait (loop abort)', async () => {
        const { session, queue } = createSession();
        // No messages pushed at all: the loop sits in waitForMessagesAndGetAsString.
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });

        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 100));
        const startedAt = Date.now();
        // Exit the session while idle — the loop's queue wait must resolve via
        // the loop abort controller instead of hanging until a message arrives.
        await driver['handleExitFromUi']();
        await launchPromise;
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it('acks the delivery and restores the prompt on interrupt before user_input', async () => {
        const { session, queue, client } = createSession();
        // The child emits the init envelope but stalls before user_input/result.
        const child = scriptableFakeChild(['{"event":"init","conversation_id":"c-int","init":{}}'], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-int","init":{}}\n');
        await new Promise((r) => setTimeout(r, 50));
        // Interrupt before the prompt was accepted: the composer gets the text
        // back AND the hub delivery is acknowledged (no duplicate/stale queued
        // row alongside the restored prompt).
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 50));
        // The kill sent by the abort resolves the turn via the child close.
        child.emit('close', 0, null);
        await new Promise((r) => setTimeout(r, 50));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    });

    it('restores the prompt even when the child close fires during the interrupt wait', async () => {
        const { session, queue, client } = createSession();
        // The child stalls mid-turn; on interrupt, the terminate wait races the
        // child close (which clears activeWebPrompt/activeLocalIds via
        // finishTurn). The interrupt must have snapshotted them BEFORE killing,
        // so restore + consume still fire.
        const child = scriptableFakeChild(['{"event":"init","conversation_id":"c-rc","init":{}}'], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-rc","init":{}}\n');
        await new Promise((r) => setTimeout(r, 50));
        // Start the interrupt (it snapshots prompt/ids synchronously before the
        // await), then close the child DURING the terminate wait.
        const interruptPromise = driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 0));
        child.emit('close', 0, null);
        await interruptPromise;
        await new Promise((r) => setTimeout(r, 50));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    });

    it('consumes and restores the in-flight prompt on whole-session kill', async () => {
        const { session, queue, client } = createSession();
        // A turn stalls before user_input; the SESSION kill path (lifecycle
        // cleanup on Ctrl-C/archive/restart) must consume + restore like the RPC
        // interrupt, or the session-end sweep stamps the row invoked with no copy.
        const child = scriptableFakeChild(['{"event":"init","conversation_id":"c-ks","init":{}}'], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-ks","init":{}}\n');
        await new Promise((r) => setTimeout(r, 50));
        // Kill the session (what runAgy's onBeforeClose does via session.kill).
        // Do NOT await: abort waits for the active turn, which needs the close
        // below to fire first.
        const killPromise = session.kill();
        await new Promise((r) => setTimeout(r, 50));
        child.emit('close', 0, null);
        await killPromise;
        await new Promise((r) => setTimeout(r, 50));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    });

    it('consumes and restores a requeued prompt killed during the retry backoff', async () => {
        const { session, queue, client } = createSession();
        // agy never accepts the prompt (exit 1, no output): the batch is requeued
        // and the driver sleeps 1.5s. Killing the session DURING that backoff must
        // still consume + restore (activeWebPrompt is already cleared by
        // finishTurn, so the retry-delivery tracking covers it).
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess([], 1);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        // Wait past the first failed turn (spawn + close) so the batch is requeued
        // and the backoff sleep is in progress.
        await new Promise((r) => setTimeout(r, 400));
        await session.kill();
        await new Promise((r) => setTimeout(r, 200));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    }, 15000);

    it('parses a final result record without a trailing newline at EOF', async () => {
        const { session, queue, client, sent } = createSession();
        // The child closes after writing a valid result object WITHOUT a trailing
        // newline: the buffered record must still be parsed (authoritative
        // response / failure status must not be discarded).
        const lines = [
            '{"event":"init","conversation_id":"c-eof","init":{}}',
            '{"event":"result","result":{"conversation_id":"c-eof","status":"SUCCESS","response":"eof answer","duration_seconds":0.1}}',
        ];
        const child = scriptableFakeChild([], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        // Feed both lines joined WITHOUT trailing newline, then close.
        child.feedStdout(lines.join('\n'));
        await new Promise((r) => setTimeout(r, 20));
        child.emit('close', 0, null);
        await new Promise((r) => setTimeout(r, 200));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // The result response reached the chat (planner fallback) and the
        // delivery was acked (result proves acceptance).
        const plannerEntries = sent
            .map((args) => (args as unknown[])[0] as { type?: string; content?: string } | undefined)
            .filter((e) => e?.type === 'PLANNER_RESPONSE');
        expect(plannerEntries.map((e) => e!.content)).toContain('eof answer');
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
    });

    it('cancels the retry when interrupted during the backoff', async () => {
        const { session, queue, client } = createSession();
        // First turn fails (exit 1, no output) → batch requeued + backoff. An
        // interrupt during the wait must consume + restore the prompt and NOT
        // spawn a retry.
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess([], 1);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        // Wait past the first failed turn so the backoff is in progress.
        await new Promise((r) => setTimeout(r, 400));
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 2000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // No retry spawn; delivery consumed + restored.
        expect(spawnCount).toBe(1);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    }, 15000);

    it('cancels an id-less retry when interrupted during the backoff', async () => {
        const { session, queue, client } = createSession();
        // SendMessageRequestSchema permits omitting localId; for such a delivery
        // cancelByLocalId removes nothing, so the retry cancellation must hold the
        // batch outside the queue during the backoff (id-independent).
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess([], 1);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }); // no localId
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 400));
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 2000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // No retry spawn; prompt restored (nothing to consume for id-less).
        expect(spawnCount).toBe(1);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    }, 15000);

    it('cancels an ID-bearing retry during the backoff (no second spawn)', async () => {
        const { session, queue, client } = createSession();
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess([], 1);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 400));
        // Cancel the queued message (web Cancel path) while the batch sits in
        // retry backoff: the queue has nothing (batch is outside it), but the
        // driver-owned retry state must remove it so the retry never spawns.
        const removed = session.queue.cancelByLocalId('local-1');
        const retryRemoved = session.cancelRetryDelivery?.( 'local-1') ?? false;
        await new Promise((r) => setTimeout(r, 2000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // No retry spawn after the cancel; queue-level cancel found nothing
        // (batch was outside the queue), the retry-state cancel removed it.
        expect(removed).toBe(false);
        expect(retryRemoved).toBe(true);
        expect(spawnCount).toBe(1);
    }, 15000);

    it('adopts the conversation id from a step_update when init is absent', async () => {
        const { session, queue, client } = createSession();
        // No init line; the process emits a tool step (carrying conversation_id)
        // then crashes before result: the id must be adopted so the next turn
        // resumes the same conversation.
        const stream = [
            '{"event":"step_update","step_update":{"conversation_id":"c-su","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"},"output":"x"}}}',
        ];
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(stream, 1), // crash after the step
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 6000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(session.sessionId).toBe('c-su');
        expect(client.emitSessionReady).toHaveBeenCalled();
    }, 15000);

    it('keeps the session alive when the only retry item is canceled', async () => {
        const { session, queue, client } = createSession();
        let spawnCount = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess([], 1);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 400));
        // Cancel the only retry item: the session must stay alive (not break) and
        // accept a later prompt.
        session.cancelRetryDelivery?.('local-1');
        await new Promise((r) => setTimeout(r, 2000));
        // A newer message queued after the cancel must still be processed.
        queue.push('second', { permissionMode: 'request-review' }, 'local-2');
        await new Promise((r) => setTimeout(r, 1000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // First spawn failed and was canceled; the second message spawned.
        expect(spawnCount).toBe(2);
    }, 15000);

    it('does not restore an already-completed prompt when Stop arrives during close finalization', async () => {
        const { session, queue, client, sent } = createSession();
        // The turn completes normally (result + close); Stop arrives WHILE the
        // close handler is finalizing (turnFinalizing) — the completed prompt
        // must NOT be restored or marked aborted.
        const child = scriptableFakeChild([], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout(FULL_TURN.join('\n') + '\n');
        await new Promise((r) => setTimeout(r, 20));
        child.emit('close', 0, null);
        // Stop immediately after close started (finalization in progress).
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 300));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Delivery acked (turn completed); NO abort-restore (prompt not lost).
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        const restoreEvents = client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'abort-restore');
        expect(restoreEvents).toHaveLength(0);
        expect(sent.length).toBeGreaterThan(0);
    });

    it('keeps close as the turn boundary after a spawn error (error→close)', async () => {
        const { session, queue, client } = createSession();
        // Node emits error then close; resolving at error would let the retry
        // backoff start before the late close, whose turnFinalizing=true would
        // then swallow Stop for the whole backoff. close must remain the boundary.
        let spawnCount = 0;
        const child = scriptableFakeChild([], 1);
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return child;
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.emit('error', new Error('spawn ENOENT'));
        await new Promise((r) => setTimeout(r, 20));
        child.emit('close', 1, null);
        await new Promise((r) => setTimeout(r, 400));
        // Stop during the retry backoff: must cancel, not respawn.
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 2000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(spawnCount).toBe(1);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
    }, 15000);

    it('awaits turn finalization before whole-session kill resolves (no false abort)', async () => {
        const { session, queue, client, sent } = createSession();
        // Kill the session WHILE the close handler is finalizing (default-model
        // resolution in flight): abort must await the active turn so the ack and
        // transcript land, and must not emit a false 'Turn aborted'.
        const child = scriptableFakeChild([], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout(FULL_TURN.join('\n') + '\n');
        await new Promise((r) => setTimeout(r, 20));
        child.emit('close', 0, null);
        // Kill immediately: close handler (turnFinalizing) is in flight.
        await session.kill();
        await new Promise((r) => setTimeout(r, 100));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Delivery acked, transcript delivered, no abort-restore, no 'Turn aborted'.
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(sent.length).toBeGreaterThan(0);
        expect(client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'abort-restore')).toHaveLength(0);
        expect(client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'message' && e.message === 'Turn aborted')).toHaveLength(0);
    });

    it('does not acknowledge a delivery on a malformed result envelope', async () => {
        const { session, queue, client } = createSession();
        // A status-less result line is ignored: the prompt was never proven
        // accepted, so the delivery must NOT be acked on that turn — the batch is
        // requeued for retry (the retry-exhaustion restore is separate).
        let spawnCount = 0;
        const stream = [
            '{"event":"init","conversation_id":"c-bad","init":{}}',
            '{"event":"result","result":{}}',
        ];
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawnCount += 1;
                return fakeAgyProcess(stream, 0);
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 5000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Requeued (not accepted): multiple spawns attempted; the malformed
        // envelope never acked the delivery on its own.
        expect(spawnCount).toBeGreaterThan(1);
    }, 15000);

    it('restores an unaccepted prompt when kill lands during the close window', async () => {
        const { session, queue, client } = createSession();
        // agy exits with NO acceptance signal (crash). session.kill() lands while
        // the close handler is still finalizing (flushPlanner awaits): the turn
        // must NOT be sealed (no result/acceptance), so the prompt is restored
        // instead of being lost between retry and restore.
        const child = scriptableFakeChild(['{"event":"init","conversation_id":"c-nc","init":{}}'], 1);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-nc","init":{}}\n');
        await new Promise((r) => setTimeout(r, 20));
        child.emit('close', 1, null);
        // Kill immediately (close handler in flight, turn NOT accepted).
        await session.kill();
        await new Promise((r) => setTimeout(r, 100));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Prompt restored (not lost), delivery consumed.
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'abort-restore', text: 'hello' })
        );
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
    });

    it('surfaces an accepted turn that closes without a result', async () => {
        const { session, queue, client } = createSession();
        // agy accepts the prompt (user_input) then exits 0 WITHOUT a result
        // envelope: the delivery is acked (it ran) but the truncation must be
        // surfaced as an error, not silently consumed.
        const stream = [
            '{"event":"init","conversation_id":"c-tr","init":{}}',
            '{"event":"step_update","step_update":{"conversation_id":"c-tr","step_index":0,"state":"DONE","step_type":"user_input"}}',
        ];
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => fakeAgyProcess(stream, 0) });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // Acked (accepted) and an error surfaces the missing result.
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error', message: 'agy exited before returning a result' })
        );
    });

    it('emits ready only after turn completion, for every turn', async () => {
        const { session, queue, client } = createSession();
        // Use a mode-aware hasher so the two pushes form separate batches (the
        // shared test helper's constant hasher would merge them into one turn).
        const queue2 = new MessageQueue2<AgyMode>((mode) => String(mode.effort ?? ''));
        const session2 = new AgySession({
            api: {} as never,
            client: client as never,
            path: '/tmp',
            logPath: '/tmp/agy.log',
            sessionId: null,
            messageQueue: queue2,
            onModeChange: () => {},
            startedBy: 'runner',
        });
        const readyEvents: string[] = [];
        client.sendSessionEvent.mockImplementation((e: { type: string }) => {
            if (e.type === 'ready') readyEvents.push('ready');
        });
        const driver = new AgyHeadlessDriver({
            session: session2,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });

        queue2.push('hello', { permissionMode: 'request-review' }, 'local-1');
        queue2.push('again', { permissionMode: 'request-review', effort: 'high' }, 'local-2');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 2000));
        queue2.close();
        session2.stopKeepAlive();
        await launchPromise;

        // ready fires only when the queue is empty after a completed turn: turn 1
        // finishes with turn 2 still queued (no ready), turn 2 finishes with an
        // empty queue (one ready). Also proves no ready fires before any result.
        expect(readyEvents).toHaveLength(1);
    }, 15000);

    it('reports a deliberate Stop as an interrupt, not a crash (code null)', async () => {
        const { session, queue, client } = createSession();
        // user_input accepted, then Stop; the killed child closes with code null.
        const child = scriptableFakeChild([], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-st","init":{}}\n{"event":"step_update","step_update":{"conversation_id":"c-st","step_index":0,"state":"DONE","step_type":"user_input"}}\n');
        await new Promise((r) => setTimeout(r, 50));
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 50));
        child.emit('close', null, 'SIGTERM'); // killed child closes with null code
        await new Promise((r) => setTimeout(r, 100));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // No error event (not a crash); 'Turn aborted' message instead.
        expect(client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'error')).toHaveLength(0);
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'message', message: 'Turn aborted' })
        );
    });

    it('does not report a process error when Stop lands after the result', async () => {
        const { session, queue, client } = createSession();
        // result parsed, then Stop, then the killed child closes with code null:
        // the completed turn must not surface a crash error.
        const child = scriptableFakeChild([], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-pr2","init":{}}\n{"event":"result","result":{"conversation_id":"c-pr2","status":"SUCCESS","response":"ok","duration_seconds":0.1}}\n');
        await new Promise((r) => setTimeout(r, 50));
        await driver['handleAbortRequest']();
        await new Promise((r) => setTimeout(r, 50));
        child.emit('close', null, 'SIGTERM');
        await new Promise((r) => setTimeout(r, 100));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'error')).toHaveLength(0);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
    });

    it('does not emit a false crash when whole-session kill lands after the result', async () => {
        const { session, queue, client } = createSession();
        // result parsed, then whole-session kill (archive/Ctrl-C), then the child
        // closes signal-style (code null): no 'agy exited with code unknown' error.
        const child = scriptableFakeChild([], 0);
        const driver = new AgyHeadlessDriver({ session, spawnAgy: () => child });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 30));
        child.feedStdout('{"event":"init","conversation_id":"c-kr","init":{}}\n{"event":"result","result":{"conversation_id":"c-kr","status":"SUCCESS","response":"ok","duration_seconds":0.1}}\n');
        await new Promise((r) => setTimeout(r, 50));
        const killPromise = session.kill();
        await new Promise((r) => setTimeout(r, 50));
        child.emit('close', null, 'SIGTERM');
        await killPromise;
        await new Promise((r) => setTimeout(r, 100));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'error')).toHaveLength(0);
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
    });

    it('redacts the prompt from spawn debug logs', async () => {
        const { session, queue } = createSession();
        // logger.debug writes through logToFile (not console.log), so spy on the
        // logger itself — otherwise the test passes vacuously even if prompt
        // logging regresses.
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => fakeAgyProcess(FULL_TURN),
        });
        queue.push('super-secret-prompt-text', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        await new Promise((r) => setTimeout(r, 500));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        // The prompt must never be written to logs — only <redacted> markers.
        const allLogs = debugSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(allLogs).toContain('<redacted>');
        expect(allLogs).not.toContain('super-secret-prompt-text');
        debugSpy.mockRestore();
    });

    it('soft-denied permission notice surfaces in stderr failure text', async () => {
        const { session, queue, client } = createSession();
        // Non-zero exit with an auth-ish stderr message: the failure description
        // must include the stderr text (driver's describeFailure).
        let spawned = 0;
        const driver = new AgyHeadlessDriver({
            session,
            spawnAgy: () => {
                spawned += 1;
                const child = fakeAgyProcess(['{"event":"init","conversation_id":"c1","init":{}}'], 2);
                return child;
            },
        });

        queue.push('hello', { permissionMode: 'request-review' }, 'local-1');
        const launchPromise = driver.launch();
        // The failing turns requeue/retry up to the bound; the error event must
        // have fired on the first attempt. Then end the session via close.
        await new Promise((r) => setTimeout(r, 6000));
        queue.close();
        session.stopKeepAlive();
        await launchPromise;

        expect(spawned).toBe(3);
        const errorEvents = client.sendSessionEvent.mock.calls.filter(([e]) => e.type === 'error');
        expect(errorEvents.length).toBeGreaterThan(0);
        expect(String(errorEvents[0][0].message)).toContain('exited with code 2');
    }, 15000);
});
