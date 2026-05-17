import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub out `@/configuration` so the helper considers our tmpdir HAPI-managed.
// Tests that exercise the non-managed branch override happyHomeDir explicitly.
vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir(): string {
            return (globalThis as { __hapiHomeStub?: string }).__hapiHomeStub ?? tmpdir();
        }
    }
}));

// `@/ui/logger` reads `configuration.logsDir` at module load. We only need the
// .debug / .warn surface here, so substitute spy shims — tests can assert
// against `loggerMock.warn` to lock in the warn-on-failure contract.
// `vi.hoisted` ensures the mocks exist when the hoisted `vi.mock` factory runs.
const loggerMock = vi.hoisted(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
}));
vi.mock('@/ui/logger', () => ({ logger: loggerMock }));

import { ensureOpencodeHookPlugin } from './hookPlugin';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function setHapiHome(value: string): void {
    (globalThis as { __hapiHomeStub?: string }).__hapiHomeStub = value;
}

function resetHapiHome(): void {
    delete (globalThis as { __hapiHomeStub?: string }).__hapiHomeStub;
}

describe('buildPluginSource (via ensureOpencodeHookPlugin)', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-src-');
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
        resetHapiHome();
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

describe('ensurePluginRuntime (via ensureOpencodeHookPlugin)', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-rt-');
        loggerMock.warn.mockClear();
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
        resetHapiHome();
    });

    it('writes a minimal package.json pinned to a tested @opencode-ai/plugin version', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        const pkg = JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf-8'));
        // Pinned (`^1.14.0`) rather than `*` — a wildcard would let a registry
        // change pull a moving target into a code-execution-adjacent path.
        const declared = pkg.dependencies['@opencode-ai/plugin'];
        expect(declared).toMatch(/^[\^~]?\d/);
        expect(declared).not.toBe('*');
    });

    it('preserves an existing package.json that already declares @opencode-ai/plugin', () => {
        const existing = JSON.stringify({
            dependencies: { '@opencode-ai/plugin': '1.14.30', somethingElse: '^2.0.0' }
        }, null, 2) + '\n';
        writeFileSync(join(tempRoot, 'package.json'), existing, 'utf-8');

        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        const actual = readFileSync(join(tempRoot, 'package.json'), 'utf-8');
        expect(actual).toBe(existing);
    });

    it('overwrites an existing package.json that does NOT declare @opencode-ai/plugin', () => {
        // Regression: short-circuiting on plain presence would silently re-create
        // the broken state — package.json sits there but plugin discovery fails.
        const unrelated = JSON.stringify({
            dependencies: { 'some-other-package': '^1.0.0' }
        }, null, 2) + '\n';
        writeFileSync(join(tempRoot, 'package.json'), unrelated, 'utf-8');

        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        const pkg = JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf-8'));
        expect(pkg.dependencies['@opencode-ai/plugin']).toBeDefined();
    });

    it('does NOT write to a non-HAPI-managed dir (user-supplied OPENCODE_CONFIG_DIR)', () => {
        // Simulate a user pointing OPENCODE_CONFIG_DIR at their own ~/.config/opencode.
        // Even though it's empty, HAPI must not pollute it with a placeholder.
        const userOwned = makeTempDir('hapi-not-managed-');
        try {
            setHapiHome(makeTempDir('hapi-home-elsewhere-'));

            ensureOpencodeHookPlugin(userOwned, 'http://h/hook', 't');

            expect(existsSync(join(userOwned, 'package.json'))).toBe(false);
            // Plugin file is still written — that's HAPI's contract — but the
            // package.json side effect is gated.
            expect(existsSync(join(userOwned, 'plugins', 'hapi-hook.ts'))).toBe(true);
        } finally {
            rmSync(userOwned, { recursive: true, force: true });
            resetHapiHome();
        }
    });

    it('does not touch node_modules or package-lock.json (opencode materializes them)', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        expect(existsSync(join(tempRoot, 'node_modules'))).toBe(false);
        expect(existsSync(join(tempRoot, 'package-lock.json'))).toBe(false);
    });

    it('preserves existing node_modules and package-lock.json across launches', () => {
        // Real-world: opencode has run once, installed deps, and we are launching
        // again. The previous install's artifacts must survive our write.
        const placeholderNm = join(tempRoot, 'node_modules');
        const placeholderLock = join(tempRoot, 'package-lock.json');
        // Use directories/files we can checksum after the call.
        writeFileSync(placeholderLock, '{"name":"sentinel"}', 'utf-8');
        const lockBefore = readFileSync(placeholderLock, 'utf-8');

        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        expect(readFileSync(placeholderLock, 'utf-8')).toBe(lockBefore);
        // node_modules wasn't pre-staged in this case, so it should still be absent.
        expect(existsSync(placeholderNm)).toBe(false);
    });

    it('emits a warn (not a throw) when package.json cannot be written', async () => {
        // Pre-create a directory named `package.json` inside rootPath. The
        // subsequent writeFileSync will throw EISDIR / EPERM on every
        // platform. The launcher must keep going (scanner channel #589 is
        // the documented fallback) and surface the failure via logger.warn.
        const fs = await import('node:fs');
        fs.mkdirSync(join(tempRoot, 'package.json'));

        // Must not throw.
        expect(() => ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't')).not.toThrow();

        // Plugin file should still be written (that path is independent).
        expect(existsSync(join(tempRoot, 'plugins', 'hapi-hook.ts'))).toBe(true);

        // The failure must be surfaced — silent failure was the pre-#589
        // bug shape we are explicitly *not* repeating.
        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        expect(loggerMock.warn.mock.calls[0][0]).toMatch(/Failed to materialize/);
    });

    it('does not warn on the happy path', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');
        expect(loggerMock.warn).not.toHaveBeenCalled();
    });
});
