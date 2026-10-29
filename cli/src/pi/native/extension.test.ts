import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { PI_NATIVE_EXTENSION_SOURCE } from './extension';
import { PiNativeFrameParser } from './protocol';

type Handler = (event: Record<string, unknown>, ctx: ReturnType<typeof context>) => unknown;

function context(sessionId = 'native-1') {
    const entries = [{ type: 'message', id: 'entry-1', message: { role: 'user', content: [{ type: 'text', text: 'old' }] } }];
    return {
        model: { id: 'deepseek-chat', provider: 'deepseek', name: 'DeepSeek', headers: { Authorization: 'secret' } },
        sessionManager: {
            getSessionId: () => sessionId, getSessionFile: () => '/tmp/session.jsonl', getLeafId: () => 'entry-1',
            getBranch: () => entries, getEntries: () => entries
        },
        modelRegistry: { getAvailable: vi.fn(), find: vi.fn(), hasConfiguredAuth: vi.fn().mockReturnValue(true) },
        isIdle: vi.fn().mockReturnValue(true), abort: vi.fn(), compact: vi.fn(),
        getContextUsage: () => ({ tokens: 10, contextWindow: 100 })
    };
}

describe('bundled Pi native extension', () => {
    const servers: Server[] = [];
    const peers: Socket[] = [];
    const oldEnv = { port: process.env.HAPI_PI_NATIVE_PORT, token: process.env.HAPI_PI_NATIVE_TOKEN, session: process.env.HAPI_SESSION_ID };

    afterEach(async () => {
        for (const peer of peers.splice(0)) peer.destroy();
        for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const [key, value] of Object.entries({ HAPI_PI_NATIVE_PORT: oldEnv.port, HAPI_PI_NATIVE_TOKEN: oldEnv.token, HAPI_SESSION_ID: oldEnv.session })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    async function bridge() {
        const server = createServer();
        servers.push(server);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        process.env.HAPI_PI_NATIVE_PORT = String((server.address() as { port: number }).port);
        process.env.HAPI_PI_NATIVE_TOKEN = 'test-token';
        const handlers = new Map<string, Handler>();
        const pi = {
            on: (type: string, handler: Handler) => handlers.set(type, handler),
            getSessionName: () => 'Native session', getThinkingLevel: () => 'high',
            sendUserMessage: vi.fn(), setThinkingLevel: vi.fn(), setModel: vi.fn().mockResolvedValue(true),
            getCommands: () => [{ name: 'native-test', description: 'Test command' }]
        };
        const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(PI_NATIVE_EXTENSION_SOURCE).toString('base64')}`);
        extension.default(pi);
        const ctx = context();
        const connection = once(server, 'connection');
        handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx);
        const [peer] = await connection as [Socket];
        peers.push(peer);
        const frames: Record<string, unknown>[] = [];
        const parser = new PiNativeFrameParser();
        peer.on('data', (data: Buffer) => parser.feed(data, (frame) => frames.push(frame)));
        await vi.waitFor(() => expect(frames[0]).toEqual({ kind: 'hello', version: 1, token: 'test-token' }));
        peer.write(JSON.stringify({ kind: 'welcome', version: 1 }) + '\n');
        await vi.waitFor(() => expect(frames.some((frame) => frame.kind === 'ready')).toBe(true));
        const initialGeneration = ((frames.find((frame) => frame.kind === 'event')!.event as Record<string, unknown>).state as Record<string, unknown>).sessionGeneration;
        let id = 0;
        const request = async (command: Record<string, unknown>, sessionId = 'native-1') => {
            const requestId = String(++id);
            peer.write(JSON.stringify({ kind: 'request', id: requestId, sessionId, command: { sessionGeneration: initialGeneration, ...command } }) + '\n');
            await vi.waitFor(() => expect(frames.some((frame) => frame.kind === 'response' && frame.id === requestId)).toBe(true));
            return frames.find((frame) => frame.kind === 'response' && frame.id === requestId)!;
        };
        return { handlers, pi, ctx, peer, frames, request, initialGeneration };
    }

    it('publishes branch/state before ready and exposes public model metadata only', async () => {
        const { frames, request, ctx } = await bridge();
        expect(frames[1]).toMatchObject({ kind: 'event', sessionId: 'native-1', event: {
            type: 'session_start', state: { sessionId: 'native-1', leafId: 'entry-1', branch: ctx.sessionManager.getBranch() }
        } });
        expect(frames[2]).toEqual({ kind: 'ready', sessionId: 'native-1' });
        expect(JSON.stringify(frames)).not.toContain('secret');
        expect(await request({ type: 'get_entries' })).toMatchObject({ success: true, data: { entries: ctx.sessionManager.getBranch() } });
        expect(await request({ type: 'get_entries', since: 'entry-1' })).toMatchObject({ data: { entries: [] } });
        expect(await request({ type: 'get_entries', since: 'missing' })).toMatchObject({ success: false, error: 'Unknown Pi entry cursor' });
    });

    it('rejects stale sessions and unsupported mutations, binds HAPI only to current native session', async () => {
        const { request, pi, ctx, handlers } = await bridge();
        expect(await request({ type: 'prompt', message: 'stale' }, 'stale')).toMatchObject({ success: false, error: 'Stale Pi native session' });
        expect(pi.sendUserMessage).not.toHaveBeenCalled();
        expect(await request({ type: 'new_session' })).toMatchObject({ success: false });
        expect(await request({ type: 'compact' })).toMatchObject({ success: false });
        expect(await request({ type: 'prompt', message: '/review' })).toMatchObject({ success: false, error: 'Native Pi slash commands must be run in the terminal' });
        expect(await request({ type: 'abort' })).toMatchObject({ success: true, data: { requested: true } });
        ctx.abort.mockClear();
        expect(await request({ type: 'bind_hapi_session', hapiSessionId: 'hapi-1' })).toMatchObject({ success: true });
        expect(process.env.HAPI_SESSION_ID).toBe('hapi-1');
        handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, context('native-2'));
        expect(process.env.HAPI_SESSION_ID).toBeUndefined();
        expect(await request({ type: 'abort' })).toMatchObject({ success: false });
        expect(ctx.abort).not.toHaveBeenCalled();
    });

    it('submits idle prompts immediately, queues busy prompts, checks steering generation', async () => {
        const { request, pi, ctx, handlers, frames } = await bridge();
        expect(await request({ type: 'prompt', message: 'idle' })).toMatchObject({ success: true, data: { submitted: true, delivery: 'prompt' } });
        expect(pi.sendUserMessage).toHaveBeenLastCalledWith('idle', { expandPromptTemplates: false, deliverAs: undefined });
        ctx.isIdle.mockReturnValue(false);
        handlers.get('agent_start')!({ type: 'agent_start' }, ctx);
        await vi.waitFor(() => expect(frames.some((frame) => (frame.event as Record<string, unknown>)?.type === 'agent_start')).toBe(true));
        const generation = (frames.find((frame) => (frame.event as Record<string, unknown>)?.type === 'agent_start')!.event as Record<string, unknown>).streamGeneration;
        expect(await request({ type: 'prompt', message: 'busy' })).toMatchObject({ data: { submitted: true, delivery: 'followUp' } });
        expect(pi.sendUserMessage).toHaveBeenLastCalledWith('busy', { expandPromptTemplates: false, deliverAs: 'followUp' });
        expect(await request({ type: 'steer', message: 'now', expectedStreamGeneration: generation })).toMatchObject({ success: true, data: { delivery: 'steer' } });
        const calls = pi.sendUserMessage.mock.calls.length;
        expect(await request({ type: 'steer', message: 'stale', expectedStreamGeneration: -1 })).toMatchObject({ success: false, error: 'Stale Pi stream generation' });
        ctx.isIdle.mockReturnValue(true);
        expect(await request({ type: 'steer', message: 'idle' })).toMatchObject({ success: false, error: 'Pi has no live stream to steer' });
        expect(pi.sendUserMessage).toHaveBeenCalledTimes(calls);
        ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
        expect(await request({ type: 'prompt', message: 'no auth' })).toMatchObject({ success: false, error: 'Pi model authentication is unavailable' });
        expect(pi.sendUserMessage).toHaveBeenCalledTimes(calls);
    });

    it('forwards real input, message and model events and leaves Pi usable after IPC disconnect', async () => {
        const { handlers, ctx, frames, peer, pi } = await bridge();
        handlers.get('input')!({ type: 'input', text: 'native typed', source: 'interactive' }, ctx);
        handlers.get('message_start')!({ type: 'message_start', message: { role: 'user', content: 'native typed' } }, ctx);
        handlers.get('model_select')!({ type: 'model_select', source: 'native', model: ctx.model, previousModel: ctx.model }, ctx);
        handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
        await vi.waitFor(() => expect(frames.some((frame) => (frame.event as Record<string, unknown>)?.type === 'session_tree')).toBe(true));
        expect(frames).toContainEqual(expect.objectContaining({ event: { type: 'input', text: 'native typed', source: 'interactive' } }));
        expect(frames).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'model_select', state: expect.objectContaining({ sessionId: 'native-1' }) }) }));
        expect(JSON.stringify(frames)).not.toContain('secret');
        peer.destroy();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(() => handlers.get('message_end')!({ type: 'message_end', message: {} }, ctx)).not.toThrow();
        expect(pi.sendUserMessage).not.toHaveBeenCalled();
        expect(ctx.abort).not.toHaveBeenCalled();
    });

    it('validates model/thinking changes and returns registry models without private headers', async () => {
        const { request, ctx, pi, handlers } = await bridge();
        ctx.modelRegistry.getAvailable.mockReturnValue([ctx.model]);
        expect(await request({ type: 'get_available_models' })).toMatchObject({ data: { models: [{ id: 'deepseek-chat', provider: 'deepseek' }] } });
        expect(JSON.stringify(await request({ type: 'get_available_models' }))).not.toContain('secret');
        expect(await request({ type: 'set_model', provider: 'deepseek', modelId: 'unknown' })).toMatchObject({ success: false, error: 'Unknown Pi model' });
        expect(pi.setModel).not.toHaveBeenCalled();
        ctx.modelRegistry.find.mockReturnValue(ctx.model);
        pi.setModel.mockImplementationOnce(async () => {
            handlers.get('model_select')!({ type: 'model_select', model: ctx.model }, { ...ctx });
            return true;
        });
        expect(await request({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-chat' })).toMatchObject({ success: true, data: { model: { id: 'deepseek-chat' } } });
        expect(await request({ type: 'set_thinking_level', level: 'high' })).toMatchObject({ success: true, data: { level: 'high' } });
        expect(pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith('high');
        expect(await request({ type: 'set_thinking_level', level: 'invalid' })).toMatchObject({ success: false });
        expect(pi.setThinkingLevel).toHaveBeenCalledTimes(1);
        expect(await request({ type: 'get_session_stats' })).toMatchObject({ success: true, data: { userMessages: 1, totalMessages: 1, tokens: { total: 0 }, contextUsage: { tokens: 10 } } });
    });

    it('fences same-session tree navigation and clears the old HAPI binding before forwarding', async () => {
        const { request, ctx, handlers, frames, initialGeneration } = await bridge();
        expect(await request({ type: 'bind_hapi_session', hapiSessionId: 'hapi-old' })).toMatchObject({ success: true });
        handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
        expect(process.env.HAPI_SESSION_ID).toBeUndefined();
        await vi.waitFor(() => expect(frames.some((frame) => (frame.event as Record<string, unknown>)?.type === 'session_tree')).toBe(true));
        const tree = frames.find((frame) => (frame.event as Record<string, unknown>)?.type === 'session_tree')!.event as Record<string, unknown>;
        const epoch = (tree.state as Record<string, unknown>).sessionGeneration;
        expect(Number(epoch)).toBeGreaterThan(Number(initialGeneration));
        expect(await request({ type: 'abort' })).toMatchObject({ success: false, error: 'Stale Pi native session generation' });
        expect(await request({ type: 'abort', sessionGeneration: undefined })).toMatchObject({ success: false, error: 'Stale Pi native session generation' });
        expect(await request({ type: 'bind_hapi_session', hapiSessionId: 'hapi-old' })).toMatchObject({ success: false, error: 'Stale Pi native session generation' });
        expect(ctx.abort).not.toHaveBeenCalled();
        expect(await request({ type: 'get_state', sessionGeneration: undefined })).toMatchObject({ success: true, data: { sessionGeneration: epoch } });
        expect(await request({ type: 'bind_hapi_session', hapiSessionId: 'hapi-new', sessionGeneration: epoch })).toMatchObject({ success: true });
        expect(process.env.HAPI_SESSION_ID).toBe('hapi-new');
    });
});
