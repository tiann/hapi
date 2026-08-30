import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { materializePiTitleExtension, PI_TITLE_EXTENSION_SOURCE } from './titleExtension';

describe('pi title extension source', () => {
    it('registers a namespaced hapi_change_title tool and applies it via setTitle', () => {
        expect(PI_TITLE_EXTENSION_SOURCE).toContain("name: TOOL_NAME");
        expect(PI_TITLE_EXTENSION_SOURCE).toContain("'hapi_change_title'");
        expect(PI_TITLE_EXTENSION_SOURCE).toContain('ctx.ui.setTitle');
    });

    it('uses the typebox specifier that old and new Pi loaders both resolve', () => {
        expect(PI_TITLE_EXTENSION_SOURCE).toContain("import { Type } from '@sinclair/typebox';");
    });

    it('injects the instruction on every turn, matching the persistent Claude/Codex rule', () => {
        expect(PI_TITLE_EXTENSION_SOURCE).toContain('## Session title');
        expect(PI_TITLE_EXTENSION_SOURCE).toContain('tool once');
        expect(PI_TITLE_EXTENSION_SOURCE).toContain('before_agent_start');
        expect(PI_TITLE_EXTENSION_SOURCE).not.toContain('titled');
    });
});

describe('materializePiTitleExtension', () => {
    it('writes the extension into the target dir and returns its path', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-title-'));
        const file = await materializePiTitleExtension(dir);

        expect(file).toBe(join(dir, 'hapi-title-extension.ts'));
        const content = await readFile(file, 'utf8');
        expect(content).toContain('hapiTitleExtension');
        expect(content).toContain('hapi_change_title');
    });

    it('creates missing directories and is idempotent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-pi-title-'));
        const dir = join(root, 'runtime', '0.0.0-test', 'pi');

        const first = await materializePiTitleExtension(dir);
        const second = await materializePiTitleExtension(dir);

        expect(first).toBe(second);
    });

    it('publishes atomically under concurrent launches', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-title-'));

        const paths = await Promise.all(
            Array.from({ length: 8 }, () => materializePiTitleExtension(dir)),
        );

        expect(new Set(paths).size).toBe(1);
        const content = await readFile(join(dir, 'hapi-title-extension.ts'), 'utf8');
        expect(content).toBe(PI_TITLE_EXTENSION_SOURCE);
        const entries = await readdir(dir);
        expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('keeps injecting the instruction on later turns so renames stay possible', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-title-'));
        const file = await materializePiTitleExtension(dir);

        // The materialized source only imports typebox, which cannot be
        // resolved from an arbitrary temp dir; stub it so the module loads as ESM.
        const source = await readFile(file, 'utf8');
        const testable = source.replace(
            "import { Type } from '@sinclair/typebox';",
            'const Type = { Object: (properties) => ({ properties }), String: (options) => options };',
        );
        const moduleFile = join(dir, 'hapi-title-extension.mjs');
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
