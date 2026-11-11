import { win32 } from 'node:path';
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
        homedirMock.mockReturnValue(homeDir);
        execFileSyncMock.mockImplementation(() => {
            throw new Error('not found');
        });
        existsSyncMock.mockReturnValue(false);
    });

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('resolves an explicitly selected Windows npm shim without a shell', async () => {
        const shim = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd';
        const script = win32.join(win32.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === script);
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        expect(resolveSelectedCodexCommand(shim, 'win32')).toEqual({ command: 'node', args: [script] });
    });

    it('resolves an explicitly selected npm shim name through PATH', async () => {
        const shim = 'C:\\Elsewhere\\npm\\codex.cmd';
        const script = win32.join(win32.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'where.exe' && args[0] === 'codex.cmd') return `${shim}\r\n`;
            throw new Error('not found');
        });
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === script);
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        expect(resolveSelectedCodexCommand('codex.cmd', 'win32')).toEqual({ command: 'node', args: [script] });
        expect(execFileSyncMock).toHaveBeenCalledWith('where.exe', ['codex.cmd'], expect.anything());
    });

    it('rejects unsupported Windows batch launchers instead of shell-interpreting JSON', async () => {
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        expect(() => resolveSelectedCodexCommand('C:\\custom.cmd', 'win32')).toThrow('Use a Codex executable');
    });

    it('preserves explicitly selected macOS and Linux executables', async () => {
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        for (const platform of ['darwin', 'linux'] as const) {
            expect(resolveSelectedCodexCommand('/custom path/codex', platform)).toEqual({ command: '/custom path/codex', args: [] });
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

    it('uses the plain codex command outside Windows', async () => {
        setPlatform('linux');
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(resolveCodexCommand()).toEqual({
            command: 'codex',
            args: []
        });
    });

    it('uses the fixed macOS Codex app executable when PATH has no CLI', async () => {
        setPlatform('darwin');
        const { MACOS_CODEX_APP_COMMAND, resolveCodexCommand } = await import('./codexExecutable');
        existsSyncMock.mockImplementation((candidate: string) => candidate === MACOS_CODEX_APP_COMMAND);

        expect(resolveCodexCommand()).toEqual({
            command: MACOS_CODEX_APP_COMMAND,
            args: []
        });
    });
});
