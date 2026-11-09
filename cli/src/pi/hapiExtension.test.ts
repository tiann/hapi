import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializePiExtension, PI_EXTENSION_SOURCE } from './hapiExtension';

describe('pi bundled extension source', () => {
    it('registers a namespaced hapi_change_title tool and applies it via setTitle', () => {
        expect(PI_EXTENSION_SOURCE).toContain("name: TITLE_TOOL_NAME");
        expect(PI_EXTENSION_SOURCE).toContain("'hapi_change_title'");
        expect(PI_EXTENSION_SOURCE).toContain('ctx.ui.setTitle');
    });

    it('uses the typebox specifier that old and new Pi loaders both resolve', () => {
        expect(PI_EXTENSION_SOURCE).toContain("import { Type } from '@sinclair/typebox';");
    });

    it('injects the instruction on every turn, matching the persistent Claude/Codex rule', () => {
        expect(PI_EXTENSION_SOURCE).toContain('## Session title');
        expect(PI_EXTENSION_SOURCE).toContain('tool once');
        expect(PI_EXTENSION_SOURCE).toContain('before_agent_start');
        expect(PI_EXTENSION_SOURCE).not.toContain('titled');
    });
});


type ExtensionHarness = {
    handlers: Map<string, Array<(event: any, ctx?: any) => any>>;
    registerTool: ReturnType<typeof vi.fn>;
    registerMcpServer: ReturnType<typeof vi.fn> | null;
    prompt: () => string;
};

function loadExtension(options: {
    registerMcpServer?: boolean | (() => void);
} = {}): ExtensionHarness {
    const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
    const registerTool = vi.fn();
    const registerMcpServer = options.registerMcpServer === false
        ? null
        : vi.fn(typeof options.registerMcpServer === 'function' ? options.registerMcpServer : undefined);
    const pi: Record<string, unknown> = {
        on: (event: string, handler: (event: any, ctx?: any) => any) => {
            const current = handlers.get(event) ?? [];
            current.push(handler);
            handlers.set(event, current);
        },
        registerTool,
    };
    if (registerMcpServer) pi.registerMcpServer = registerMcpServer;

    const load = new Function('Type', 'fs', PI_EXTENSION_SOURCE
        .replace("import { Type } from '@sinclair/typebox';", '')
        .replace('export default function', 'function')
        .replace("await import('node:fs/promises')", 'fs')
        + '\nreturn hapiPiExtension;');
    load({ Object: (properties: unknown) => properties, String: (options: unknown) => options }, fs)(pi);

    return {
        handlers,
        registerTool,
        registerMcpServer,
        prompt: () => {
            const handler = handlers.get('before_agent_start')?.[0];
            if (!handler) throw new Error('before_agent_start handler missing');
            return handler({ systemPrompt: 'base' }).systemPrompt as string;
        },
    };
}

describe('pi peer MCP integration', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('registers the HAPI MCP URL as a direct Pi MCP server', () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        const harness = loadExtension();

        expect(harness.registerMcpServer).toHaveBeenCalledWith('hapi', {
            url: 'http://127.0.0.1:12345/',
            exposure: 'direct',
            description: 'HAPI peer-session tools for this HAPI session',
        });
        expect(harness.prompt()).toContain('mcp__hapi__inspect_peer');
        expect(harness.prompt()).toContain('mcp__hapi__ping_peer');
        expect(harness.prompt()).toContain('mcp__hapi__spawn_peer');
        expect(harness.prompt()).toContain('mcp__hapi__list_peers');
        expect(harness.prompt()).not.toContain('Peer session tools (inspect_peer / ping_peer / list_peers) are disabled');
    });

    it('honors HAPI_DISABLE_PEER_TOOLS and injects the disabled steer', () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', 'yes');
        const harness = loadExtension();

        expect(harness.registerMcpServer).not.toHaveBeenCalled();
        expect(harness.prompt()).toContain('Peer session tools (inspect_peer / ping_peer / list_peers) are disabled');
        expect(harness.prompt()).not.toContain('mcp__hapi__inspect_peer');
    });

    it('falls back cleanly on older Pi versions without registerMcpServer', () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        const harness = loadExtension({ registerMcpServer: false });

        expect(harness.registerMcpServer).toBeNull();
        expect(harness.prompt()).toContain('Peer session tools (inspect_peer / ping_peer / list_peers) are disabled');
    });

    it('fails closed when MCP server registration throws', () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const harness = loadExtension({
            registerMcpServer: () => {
                throw new Error('server name collision');
            },
        });

        expect(harness.prompt()).toContain('Peer session tools (inspect_peer / ping_peer / list_peers) are disabled');
    });

    it.each([
        'mcp__hapi__inspect_peer',
        'mcp__hapi__ping_peer',
        'mcp__hapi__spawn_peer',
    ])('requires confirmation for %s', async (toolName) => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        const harness = loadExtension();
        const toolCall = harness.handlers.get('tool_call')![0];
        const confirm = vi.fn(async () => false);

        const result = await toolCall({ toolName, input: {} }, { ui: { confirm } });

        expect(confirm).toHaveBeenCalledWith('Allow HAPI peer tool?', expect.stringContaining('HAPI session'));
        expect(result).toEqual({
            block: true,
            reason: 'The user did not approve this HAPI peer tool call.',
        });
    });

    it('allows a confirmed sensitive peer tool and does not gate list_peers', async () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        const harness = loadExtension();
        const toolCall = harness.handlers.get('tool_call')![0];
        const confirm = vi.fn(async () => true);

        expect(await toolCall({ toolName: 'mcp__hapi__ping_peer', input: {} }, { ui: { confirm } })).toBeUndefined();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(await toolCall({ toolName: 'mcp__hapi__list_peers', input: {} }, { ui: { confirm } })).toBeUndefined();
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('fails closed when confirmation is unavailable', async () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const harness = loadExtension();
        const toolCall = harness.handlers.get('tool_call')![0];

        expect(await toolCall({ toolName: 'mcp__hapi__inspect_peer', input: {} }, { ui: {} })).toMatchObject({
            block: true,
        });
    });

    it('does not gate peer tools when MCP registration did not succeed', async () => {
        vi.stubEnv('HAPI_PI_MCP_URL', 'http://127.0.0.1:12345/');
        const harness = loadExtension({ registerMcpServer: false });
        const toolCall = harness.handlers.get('tool_call')![0];
        const confirm = vi.fn(async () => true);

        expect(await toolCall({ toolName: 'mcp__hapi__ping_peer', input: {} }, { ui: { confirm } })).toBeUndefined();
        expect(confirm).not.toHaveBeenCalled();
    });
});
describe('materializePiExtension', () => {
    it('writes the extension into the target dir and returns its path', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-extension-'));
        const file = await materializePiExtension(dir);

        expect(file).toBe(join(dir, 'hapi-extension.ts'));
        const content = await readFile(file, 'utf8');
        expect(content).toContain('hapiPiExtension');
        expect(content).toContain('hapi_change_title');
    });

    it('creates missing directories and is idempotent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-pi-extension-'));
        const dir = join(root, 'runtime', '0.0.0-test', 'pi');

        const first = await materializePiExtension(dir);
        const second = await materializePiExtension(dir);

        expect(first).toBe(second);
    });

    it('publishes atomically under concurrent launches', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-extension-'));

        const paths = await Promise.all(
            Array.from({ length: 8 }, () => materializePiExtension(dir)),
        );

        expect(new Set(paths).size).toBe(1);
        const content = await readFile(join(dir, 'hapi-extension.ts'), 'utf8');
        expect(content).toBe(PI_EXTENSION_SOURCE);
        const entries = await readdir(dir);
        expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('keeps injecting the instruction on later turns so renames stay possible', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-extension-'));
        const file = await materializePiExtension(dir);

        // The materialized source only imports typebox, which cannot be
        // resolved from an arbitrary temp dir; stub it so the module loads as ESM.
        const source = await readFile(file, 'utf8');
        const testable = source.replace(
            "import { Type } from '@sinclair/typebox';",
            'const Type = { Object: (properties) => ({ properties }), String: (options) => options };',
        );
        const moduleFile = join(dir, 'hapi-extension.mjs');
        await writeFile(moduleFile, testable, 'utf8');
        const mod = await import(pathToFileURL(moduleFile).href);

        const handlers: Record<string, Array<(event: { systemPrompt: string }) => unknown>> = {};
        const registered: Array<{
            name: string;
            execute: (id: string, params: { title?: string }, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
        }> = [];
        mod.default({
            on: (event: string, handler: (event: { systemPrompt: string }) => unknown) => {
                (handlers[event] ??= []).push(handler);
            },
            registerTool: (definition: (typeof registered)[number]) => registered.push(definition),
        });

        const beforeAgentStart = handlers.before_agent_start[0] as (
            event: { systemPrompt: string },
        ) => { systemPrompt: string };
        expect(beforeAgentStart({ systemPrompt: 'base' }).systemPrompt).toContain('## Session title');

        const setTitle = vi.fn();
        const tool = registered.find((definition) => definition.name === 'hapi_change_title');
        expect(tool).toBeDefined();

        // Current Pi call order: (toolCallId, params, signal, onUpdate, ctx).
        const result = await tool!.execute('call-1', { title: 'Fix login bug' }, undefined, undefined, {
            hasUI: true,
            ui: { setTitle },
        });
        expect(setTitle).toHaveBeenCalledWith('Fix login bug');
        expect(result.content[0].text).toContain('Fix login bug');
        expect(result.content[0].text).toContain('Title update requested');
        expect(result.content[0].text).toContain('locked');
        expect(result.content[0].text).not.toContain('Session title set');

        // Legacy Pi call order (id, params, onUpdate, ctx, signal) with RPC
        // reporting hasUI: false — the context must still be normalized and
        // setTitle must still fire.
        const setTitleLegacy = vi.fn();
        const legacyCtx = { hasUI: false, ui: { setTitle: setTitleLegacy } };
        await tool!.execute(
            'call-2',
            { title: 'Legacy goal' },
            () => {},
            legacyCtx,
            new AbortController().signal,
        );
        expect(setTitleLegacy).toHaveBeenCalledWith('Legacy goal');

        // A later turn (after the title tool executed) still carries the
        // instruction, preserving the objective-change retitle rule.
        const later = beforeAgentStart({ systemPrompt: 'base' });
        expect(later.systemPrompt).toContain('## Session title');
        expect(later.systemPrompt).toContain('Rename only when');
    });
});


type ImageResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

function loadImageTool(fileSystem: unknown = fs) {
    // Execute the bundled source with only its external dependencies injected.
    const load = new Function('Type', 'fs', PI_EXTENSION_SOURCE
        .replace("import { Type } from '@sinclair/typebox';", '')
        .replace('export default function', 'function')
        .replace("await import('node:fs/promises')", 'fs')
        + '\nreturn hapiPiExtension;');
    const registerTool = vi.fn();
    load({ Object: (properties: unknown) => properties, String: (options: unknown) => options }, fileSystem)({
        on: vi.fn(), registerTool,
    });
    return registerTool.mock.calls.find(([tool]) => tool.name === 'hapi_display_image')![0] as {
        execute: (id: string, params: { path: string }) => Promise<ImageResult>;
    };
}

describe('hapi_display_image execution', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const limit = 25 * 1024 * 1024;

    async function withImage(run: (path: string) => Promise<void>) {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-image-'));
        try {
            const path = join(dir, 'image.png');
            await writeFile(path, png);
            await run(path);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }

    it.each([
        ['png', png, 'image/png'],
        ['jpeg', Buffer.from('ffd8ff', 'hex'), 'image/jpeg'],
        ['gif', Buffer.from('GIF89a'), 'image/gif'],
        ['webp', Buffer.from('RIFF0000WEBP'), 'image/webp'],
    ] as const)('returns a base64 image block for %s magic bytes', async (_name, bytes, mimeType) => {
        await withImage(async (path) => {
            await writeFile(path, bytes);
            expect(await loadImageTool().execute('image', { path })).toEqual({
                content: [{ type: 'image', data: bytes.toString('base64'), mimeType }], details: {},
            });
        });
    });

    it('rejects unsupported content and incomplete PNG signatures', async () => {
        await withImage(async (path) => {
            for (const bytes of [Buffer.from('not an image'), Buffer.from('89504e4700000000', 'hex')]) {
                await writeFile(path, bytes);
                const result = await loadImageTool().execute('image', { path });
                expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Unsupported') });
            }
        });
    });

    it('rejects missing, non-regular and oversized paths', async () => {
        await withImage(async (path) => {
            const tool = loadImageTool();
            expect((await tool.execute('image', { path: '' })).content[0].text).toContain('non-empty');
            expect((await tool.execute('image', { path: path + '.missing' })).content[0].text).toContain('Failed to read');
            expect((await tool.execute('image', { path: join(path, '..') })).content[0].type).toBe('text');
            await fs.truncate(path, limit + 1);
            expect((await tool.execute('image', { path })).content[0].text).toContain('25 MiB');
        });
    });

    it('marks display failures as errors for Pi tool execution', async () => {
        expect(await loadImageTool().execute('image', { path: '' })).toMatchObject({ isError: true });
    });

    it.each(['short reads', 'early EOF', 'shrinkage'])(
        'bounds descriptor reads and closes the descriptor after %s',
        async (scenario) => {
            const stat = vi.fn().mockResolvedValue({ size: png.length, isFile: () => true });
            if (scenario === 'shrinkage') {
                stat.mockResolvedValueOnce({ size: png.length, isFile: () => true })
                    .mockResolvedValue({ size: png.length - 1 });
            }
            const close = vi.fn().mockResolvedValue(undefined);
            const tool = loadImageTool({
                ...fs,
                open: async () => ({
                    stat, close,
                    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                        expect(buffer.length).toBe(png.length);
                        const bytesRead = scenario === 'early EOF' ? 0 : Math.min(2, length);
                        png.copy(buffer, offset, position, position + bytesRead);
                        return { bytesRead };
                    },
                }),
            });
            const result = await tool.execute('image', { path: '/image.png' });
            if (scenario === 'short reads') {
                expect(result.content[0]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
            } else {
                expect(result.content[0].text).toContain('File changed while reading');
            }
            expect(close).toHaveBeenCalledOnce();
        },
    );

    it.skipIf(process.platform === 'win32')('rejects a device without reading it', async () => {
        expect((await loadImageTool().execute('image', { path: '/dev/zero' })).content[0].text).toContain('not a regular file');
    });

    it('bounds reads and rejects a file that grows after its size is checked', async () => {
        await withImage(async (path) => {
            let grown = false;
            const grow = async () => {
                if (!grown) {
                    grown = true;
                    await fs.truncate(path, limit + 1);
                }
            };
            const read = vi.fn(async (handle: fs.FileHandle, buffer: Buffer, offset: number, length: number, position: number) => {
                expect(buffer.length).toBeLessThanOrEqual(limit);
                return handle.read(buffer, offset, length, position);
            });
            const tool = loadImageTool({
                ...fs,
                stat: async () => { const info = await fs.stat(path); await grow(); return info; },
                open: async () => {
                    const handle = await fs.open(path, 'r');
                    return {
                        stat: async () => { const info = await handle.stat(); await grow(); return info; },
                        read: (buffer: Buffer, offset: number, length: number, position: number) => read(handle, buffer, offset, length, position),
                        close: () => handle.close(),
                    };
                },
            });
            const result = await tool.execute('image', { path });
            expect(result.content[0].type).toBe('text');
            expect(result.content[0].text).toContain('File changed while reading');
            expect(read).toHaveBeenCalled();
        });
    });

    it('keeps reading the opened image if the pathname is replaced', async () => {
        await withImage(async (path) => {
            const replace = async () => {
                await fs.rename(path, path + '.original');
                await writeFile(path, 'not an image');
            };
            const tool = loadImageTool({
                ...fs,
                stat: async () => { const info = await fs.stat(path); await replace(); return info; },
                open: async () => {
                    const handle = await fs.open(path, 'r');
                    await replace();
                    return handle;
                },
            });
            expect((await tool.execute('image', { path })).content[0]).toEqual({
                type: 'image', data: png.toString('base64'), mimeType: 'image/png',
            });
        });
    });
});
