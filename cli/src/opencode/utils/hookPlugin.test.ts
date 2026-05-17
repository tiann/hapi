import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOpencodeHookPlugin } from './hookPlugin';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe('buildPluginSource (via ensureOpencodeHookPlugin)', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-src-');
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
    });

    it('emits real newlines, not the literal two-character escape', () => {
        const pluginPath = ensureOpencodeHookPlugin(tempRoot, 'http://127.0.0.1:1/hook', 'tok');
        const source = readFileSync(pluginPath, 'utf-8');
        // Regression for the bug where `.join('\\n')` produced a single-line
        // file riddled with literal `\n` sequences and was silently dropped by
        // opencode's plugin loader as a syntax error.
        expect(source).not.toMatch(/\\n/);
        expect(source.split('\n').length).toBeGreaterThan(50);
    });

    it('encodes hook url and token without injection-via-quote', () => {
        const evilToken = 'a"; process.exit(1); //';
        const pluginPath = ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', evilToken);
        const source = readFileSync(pluginPath, 'utf-8');
        // The token must be JSON-escaped — embedding the raw string would let
        // a malicious caller terminate the literal and inject JS into the
        // generated plugin.
        expect(source).toContain(JSON.stringify(evilToken));
        expect(source).not.toContain(`= "${evilToken}";`);
    });

    it('preserves the file unchanged when called with identical inputs', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');
        const first = readFileSync(join(tempRoot, 'plugins', 'hapi-hook.ts'));
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');
        const second = readFileSync(join(tempRoot, 'plugins', 'hapi-hook.ts'));
        expect(second.equals(first)).toBe(true);
    });
});
