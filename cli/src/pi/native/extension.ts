import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Plain JS bundled into HAPI. Pi loads it without a build-time Pi dependency. */
export const PI_NATIVE_EXTENSION_SOURCE = String.raw`import { connect } from 'node:net';

export default function hapiNativeBridge(pi) {
    const connectionKey = Symbol.for('hapi.pi.native.connection');
    const connection = process.env.HAPI_PI_NATIVE_TOKEN
        ? { port: Number(process.env.HAPI_PI_NATIVE_PORT), token: process.env.HAPI_PI_NATIVE_TOKEN }
        : globalThis[connectionKey] || {};
    const { port, token } = connection;
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return;
    globalThis[connectionKey] = connection;
    // Reloads reuse process-local credentials; agent shell tools need neither.
    delete process.env.HAPI_PI_NATIVE_PORT;
    delete process.env.HAPI_PI_NATIVE_TOKEN;
    let ctx;
    let socket;
    let authenticated = false;
    const generationKey = Symbol.for('hapi.pi.native.streamGeneration');
    let generation = Number(globalThis[generationKey] || 0);
    const sessionGenerationKey = Symbol.for('hapi.pi.native.sessionGeneration');
    let sessionGeneration = Number(globalThis[sessionGenerationKey] || 0);
    let reason = 'startup';
    let running = false;
    const supported = new Set(['get_state', 'get_entries', 'get_available_models', 'get_commands',
        'get_session_stats', 'set_model', 'set_thinking_level', 'prompt', 'steer', 'follow_up',
        'abort', 'bind_hapi_session']);
    const sessionId = () => ctx && ctx.sessionManager.getSessionId();
    const publicModel = (model) => model && Object.fromEntries(
        ['id', 'name', 'provider', 'api', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost']
            .filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
    const branch = () => ctx.sessionManager.getBranch().map((entry) => {
        if (entry.type !== 'message' || !Array.isArray(entry.message.content)) return entry;
        return { ...entry, message: { ...entry.message, content: entry.message.content.map((part) =>
            part.type === 'image' ? { type: 'text', text: '[Image in saved Pi history]' } : part) } };
    });
    const state = () => ({
        sessionId: sessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
        sessionName: pi.getSessionName(), model: publicModel(ctx.model),
        thinkingLevel: pi.getThinkingLevel(), isStreaming: !ctx.isIdle(),
        streamGeneration: generation, sessionGeneration, leafId: ctx.sessionManager.getLeafId(),
        branch: branch()
    });
    const write = (frame) => {
        if (!socket || socket.destroyed) return;
        try {
            const line = JSON.stringify(frame) + '\n';
            // A slow/disconnected HAPI must never block the native UI or grow an unlimited queue.
            if (socket.writableLength + Buffer.byteLength(line) > 96 * 1024 * 1024) socket.destroy();
            else socket.write(line);
        } catch { socket.destroy(); }
    };
    const emit = (event) => {
        if (authenticated && ctx) write({ kind: 'event', sessionId: sessionId(), event });
    };
    const announce = () => {
        emit({ type: 'session_start', reason, state: state() });
        write({ kind: 'ready', sessionId: sessionId() });
    };
    const nonempty = (value, label) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a non-empty string');
        return value;
    };
    const stats = () => {
        const result = { sessionId: sessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
            userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
            contextUsage: ctx.getContextUsage() };
        const add = (usage) => {
            if (!usage) return;
            for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
                const value = usage[key];
                if (typeof value === 'number' && Number.isFinite(value)) result.tokens[key] += value;
            }
            const cost = usage.cost && usage.cost.total;
            if (typeof cost === 'number' && Number.isFinite(cost)) result.cost += cost;
        };
        for (const entry of ctx.sessionManager.getEntries()) {
            if (['usage', 'branch_summary', 'compaction'].includes(entry.type)) add(entry.usage);
            if (entry.type !== 'message') continue;
            result.totalMessages++;
            const message = entry.message;
            if (message.role === 'user') result.userMessages++;
            if (message.role === 'toolResult') { result.toolResults++; add(message.usage); }
            if (message.role === 'assistant') {
                result.assistantMessages++;
                result.toolCalls += (message.content || []).filter((part) => part.type === 'toolCall').length;
                add(message.usage);
            }
        }
        result.tokens.total = result.tokens.input + result.tokens.output + result.tokens.cacheRead + result.tokens.cacheWrite;
        return result;
    };
    const execute = async (request) => {
        const command = request.command;
        if (!command || !supported.has(command.type)) throw new Error('Unsupported Pi native command: ' + (command && command.type));
        if (!ctx || request.sessionId !== sessionId()) throw new Error('Stale Pi native session');
        if (command.sessionGeneration !== sessionGeneration &&
            !(command.type === 'get_state' && command.sessionGeneration === undefined)) throw new Error('Stale Pi native session generation');
        const current = ctx;
        const currentGeneration = sessionGeneration;
        switch (command.type) {
            case 'get_state': return state();
            case 'get_entries': {
                const entries = branch();
                if (command.since === undefined) return { entries };
                const index = entries.findIndex((entry) => entry.id === command.since);
                if (index === -1) throw new Error('Unknown Pi entry cursor');
                return { entries: entries.slice(index + 1) };
            }
            case 'get_available_models': return { models: current.modelRegistry.getAvailable().map(publicModel) };
            case 'get_commands': return { commands: pi.getCommands() };
            case 'get_session_stats': return stats();
            case 'set_model': {
                const provider = nonempty(command.provider, 'provider');
                const modelId = nonempty(command.modelId, 'modelId');
                const model = current.modelRegistry.find(provider, modelId);
                if (!model) throw new Error('Unknown Pi model');
                if (!await pi.setModel(model)) throw new Error('Pi model authentication is unavailable');
                if (request.sessionId !== sessionId() || currentGeneration !== sessionGeneration) throw new Error('Pi session changed during set_model');
                return { model: publicModel(model) };
            }
            case 'set_thinking_level':
                if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(command.level)) throw new Error('Invalid thinking level');
                pi.setThinkingLevel(command.level);
                return { level: pi.getThinkingLevel() };
            case 'bind_hapi_session':
                process.env.HAPI_SESSION_ID = nonempty(command.hapiSessionId, 'hapiSessionId');
                return { bound: true };
            case 'abort': current.abort(); return { requested: true };
            case 'prompt':
            case 'steer':
            case 'follow_up': {
                const message = nonempty(command.message, 'message');
                if (message.trimStart().startsWith('/')) throw new Error('Native Pi slash commands must be run in the terminal');
                if (command.streamingBehavior !== undefined && !['steer', 'followUp'].includes(command.streamingBehavior)) throw new Error('Invalid streaming behavior');
                const steer = command.type === 'steer' || command.streamingBehavior === 'steer';
                if (command.expectedStreamGeneration !== undefined &&
                    (current.isIdle() || command.expectedStreamGeneration !== generation)) throw new Error('Stale Pi stream generation');
                if (steer && current.isIdle()) throw new Error('Pi has no live stream to steer');
                let content = message;
                if (command.images !== undefined) {
                    if (!Array.isArray(command.images) || command.images.some((image) => !image || image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string')) throw new Error('Invalid prompt images');
                    content = [{ type: 'text', text: message }, ...command.images];
                }
                const delivery = steer ? 'steer' : command.type === 'follow_up' || !current.isIdle() ? 'followUp' : 'prompt';
                if (current.isIdle()) {
                    if (!current.model) throw new Error('Pi has no selected model');
                    if (!current.modelRegistry.hasConfiguredAuth(current.model)) throw new Error('Pi model authentication is unavailable');
                }
                // Public extension API is intentionally fire-and-forget: acknowledgement means submitted,
                // while actual user/assistant messages are forwarded from the engine's real events.
                pi.sendUserMessage(content, { deliverAs: delivery === 'prompt' ? undefined : delivery, expandPromptTemplates: false });
                return { submitted: true, delivery };
            }
        }
    };
    const open = () => {
        if (socket && !socket.destroyed) return;
        authenticated = false;
        socket = connect({ host: '127.0.0.1', port });
        const peer = socket;
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => peer.destroy(), 5000);
        timer.unref();
        peer.on('connect', () => write({ kind: 'hello', version: 1, token }));
        peer.on('error', () => {}); // HAPI IPC failure must not fail Pi's TUI.
        peer.on('close', () => { clearTimeout(timer); if (socket === peer) authenticated = false; });
        peer.on('data', (chunk) => {
            if (socket !== peer) return;
            try {
                buffer = Buffer.concat([buffer, chunk]);
                let end;
                while ((end = buffer.indexOf(10)) !== -1) {
                    if (end > 96 * 1024 * 1024) throw new Error('Oversized IPC frame');
                    const frame = JSON.parse(buffer.subarray(0, end).toString('utf8'));
                    buffer = buffer.subarray(end + 1);
                    if (!authenticated) {
                        if (frame.kind !== 'welcome' || frame.version !== 1) throw new Error('Invalid handshake');
                        authenticated = true;
                        clearTimeout(timer);
                        announce();
                    } else {
                        if (frame.kind !== 'request' || typeof frame.id !== 'string' || typeof frame.sessionId !== 'string') throw new Error('Invalid request');
                        const reply = (success, data, error) => {
                            if (socket === peer && authenticated) write({ kind: 'response', id: frame.id, sessionId: frame.sessionId, success, data, error });
                        };
                        execute(frame).then((data) => reply(true, data), (error) => reply(false, undefined, error instanceof Error ? error.message : String(error)));
                    }
                }
                if (buffer.length > 96 * 1024 * 1024) throw new Error('Oversized IPC frame');
            } catch { peer.destroy(); }
        });
    };
    pi.on('session_start', (event, context) => {
        ctx = context;
        reason = event.reason;
        sessionGeneration++;
        globalThis[sessionGenerationKey] = sessionGeneration;
        running = true;
        delete process.env.HAPI_SESSION_ID;
        if (authenticated) announce();
        else open();
    });
    pi.on('session_shutdown', (event) => {
        emit(event);
        running = false;
        ctx = undefined;
        authenticated = false;
        delete process.env.HAPI_SESSION_ID;
        if (socket) socket.destroy();
    });
    for (const type of ['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end',
        'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update',
        'tool_execution_end', 'session_info_changed', 'session_compact', 'session_compact_failed',
        'session_tree', 'model_select', 'thinking_level_select', 'input']) {
        pi.on(type, (event, context) => {
            if (!running || !ctx || context.sessionManager.getSessionId() !== sessionId()) return;
            ctx = context;
            if (type === 'agent_start') { generation++; globalThis[generationKey] = generation; }
            if (type === 'session_tree') {
                sessionGeneration++;
                globalThis[sessionGenerationKey] = sessionGeneration;
                delete process.env.HAPI_SESSION_ID;
            }
            emit(type === 'agent_start' ? { ...event, streamGeneration: generation }
                : type === 'model_select' ? { ...event, model: publicModel(event.model), previousModel: publicModel(event.previousModel), state: state() }
                : ['session_tree', 'thinking_level_select'].includes(type) ? { ...event, state: state() } : event);
        });
    }
}
`;

/** Caller owns a private per-launch directory and its cleanup. */
export async function materializePiNativeExtension(targetDir: string): Promise<string> {
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const path = join(targetDir, 'hapi-native-bridge.mjs');
    await writeFile(path, PI_NATIVE_EXTENSION_SOURCE, { encoding: 'utf8', mode: 0o600 });
    return path;
}
