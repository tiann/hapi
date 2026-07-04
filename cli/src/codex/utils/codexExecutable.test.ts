import { delimiter, win32 } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, existsSyncMock, homedirMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    homedirMock: vi.fn(() => 'home\junes')
}));

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        execFileSync: execFileSyncMock
    };
});

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: existsSyncMock
    };
});

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
        ...actual,
        homedir: homedirMock
    };
});

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalEnv = process.env;
const homeDir = win32.join('home', 'junes');
const nodeRoot = win32.join('toolchains', 'nodejs');

function codexShimPath(): string {
    return win32.join(nodeRoot, 'codex.cmd');
}

function nativeCodexPath(): string {
    return win32.join(
        nodeRoot,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'bin',
        'codex.exe'
    );
}

function codexScriptPath(): string {
    return win32.join(nodeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function userCodexExePath(): string {
    return win32.join(homeDir, '.local', 'bin', 'codex.exe');
}

function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    });
}

describe('resolveCodexCommand', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime');
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        process.env = { ...originalEnv };
        homedirMock.mockReturnValue(homeDir);
        execFileSyncMock.mockImplementation(() => {
            throw new Error('not found');
        });
        existsSyncMock.mockReturnValue(false);
    });

    afterAll(() => {
        process.env = originalEnv;
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('resolves a Windows npm codex.cmd shim through the Codex launcher', async () => {
        setPlatform('win32');
        const shim = codexShimPath();
        const laterExe = userCodexExePath();
        const executable = nativeCodexPath();
        const script = codexScriptPath();
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'where.exe' && args[0] === 'codex') {
                return `${shim}\r\n${laterExe}\r\n`;
            }
            throw new Error('not found');
        });
        existsSyncMock.mockImplementation((candidate: string) =>
            candidate === shim || candidate === laterExe || candidate === executable || candidate === script
        );
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: 'node',
            args: [script]
        });
    });

    it('continues to the next Windows PATH candidate when a shim has no launcher script', async () => {
        setPlatform('win32');
        const shim = codexShimPath();
        const executable = userCodexExePath();
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'where.exe' && args[0] === 'codex') {
                return `${shim}\r\n${executable}\r\n`;
            }
            throw new Error('not found');
        });
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === executable);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: executable,
            args: []
        });
    });

    it('keeps a Windows codex.exe found first on PATH', async () => {
        setPlatform('win32');
        const executable = userCodexExePath();
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'where.exe' && args[0] === 'codex') {
                return `${executable}\r\n`;
            }
            throw new Error('not found');
        });
        existsSyncMock.mockImplementation((candidate: string) => candidate === executable);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: executable,
            args: []
        });
    });

    it('falls back to node plus codex.js when a Windows shim has no native exe', async () => {
        setPlatform('win32');
        const shim = codexShimPath();
        const script = codexScriptPath();
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'where.exe' && args[0] === 'codex') {
                return `${shim}\r\n`;
            }
            throw new Error('not found');
        });
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === script);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: 'node',
            args: [script]
        });
    });


    it('appends common Codex install locations to PATH for service-launched processes', async () => {
        setPlatform('darwin');
        const { withCodexSpawnEnv } = await import('./codexExecutable');

        const env = withCodexSpawnEnv({ PATH: ['/usr/bin', '/bin'].join(delimiter) });

        expect(env.PATH?.split(delimiter)).toEqual([
            '/usr/bin',
            '/bin',
            `${homeDir}/.local/bin`,
            `${homeDir}/.npm-global/bin`,
            `${homeDir}/.bun/bin`,
            '/opt/homebrew/bin',
            '/usr/local/bin'
        ]);
    });

    it('does not duplicate PATH fallback dirs', async () => {
        setPlatform('darwin');
        const { withCodexSpawnEnv } = await import('./codexExecutable');

        const env = withCodexSpawnEnv({ PATH: ['/opt/homebrew/bin', '/usr/bin', `${homeDir}/.bun/bin`].join(delimiter) });

        expect(env.PATH?.split(delimiter)).toEqual([
            '/opt/homebrew/bin',
            '/usr/bin',
            `${homeDir}/.bun/bin`,
            `${homeDir}/.local/bin`,
            `${homeDir}/.npm-global/bin`,
            '/usr/local/bin'
        ]);
    });


    it('uses an absolute common install path when the current PATH is minimal', async () => {
        setPlatform('darwin');
        const codexPath = '/opt/homebrew/bin/codex';
        process.env.PATH = ['/usr/bin', '/bin'].join(delimiter);
        existsSyncMock.mockImplementation((candidate: string) => candidate === codexPath);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: codexPath,
            args: []
        });
    });

    it('uses the plain codex command outside Windows', async () => {
        setPlatform('linux');
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: 'codex',
            args: []
        });
    });
});
