import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, execFileSyncMock, existsSyncMock, homedirMock, statMock } = vi.hoisted(() => ({
    statMock: vi.fn(),
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    homedirMock: vi.fn(() => 'home\junes')
}));

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        execFile: execFileMock,
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

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    statMock.mockImplementation(actual.stat);
    return { ...actual, stat: statMock };
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

describe('probeCodexCliVersion', () => {
    it('skips subprocesses for unchanged native binaries and observes a replacement', async () => {
        execFileMock.mockReset();
        execFileMock.mockImplementationOnce((_command, _args, _options, done) => done(null, 'codex-cli 0.169.0'));
        execFileMock.mockImplementationOnce((_command, _args, _options, done) => done(null, 'codex-cli 0.170.0'));
        const home = await mkdtemp(join(tmpdir(), 'hapi-codex-version-'));
        const command = { command: join(home, 'codex'), args: [] };
        const { probeCodexCliVersion } = await import('./codexExecutable');
        try {
            // Mach-O fixtures are only read for identity. execFile is mocked.
            await writeFile(command.command, Buffer.from('feedfacf', 'hex'));
            await expect(probeCodexCliVersion(command)).resolves.toEqual([0, 169, 0]);
            await expect(probeCodexCliVersion(command)).resolves.toEqual([0, 169, 0]);
            expect(execFileMock).toHaveBeenCalledTimes(1);

            await writeFile(command.command, Buffer.from('feedfacf00', 'hex'));
            await expect(probeCodexCliVersion(command)).resolves.toEqual([0, 170, 0]);
            expect(execFileMock).toHaveBeenCalledTimes(2);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('rechecks script launchers because their target can change independently', async () => {
        execFileMock.mockReset();
        execFileMock.mockImplementationOnce((_command, _args, _options, done) => done(null, 'codex-cli 0.169.0'));
        execFileMock.mockImplementationOnce((_command, _args, _options, done) => done(null, 'codex-cli 0.170.0'));
        const home = await mkdtemp(join(tmpdir(), 'hapi-codex-shim-version-'));
        const command = { command: join(home, 'codex'), args: [] };
        const { probeCodexCliVersion } = await import('./codexExecutable');
        try {
            await writeFile(command.command, '#!/bin/sh\nexec other-codex "$@"\n');
            await expect(probeCodexCliVersion(command)).resolves.toEqual([0, 169, 0]);
            await expect(probeCodexCliVersion(command)).resolves.toEqual([0, 170, 0]);
            expect(execFileMock).toHaveBeenCalledTimes(2);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});

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
        execFileMock.mockReset();
        statMock.mockReset().mockResolvedValue(null);
    });

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('resolves an explicitly selected Windows npm shim without a shell', async () => {
        const shim = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd';
        const script = win32.join(win32.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        statMock.mockImplementation(async file => ({ isFile: () => file === shim || file === script }));
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        await expect(resolveSelectedCodexCommand(shim, 'win32')).resolves.toEqual({ command: 'node', args: [script] });
    });

    it('resolves an explicitly selected npm shim name through PATH', async () => {
        const shim = 'C:\\Elsewhere\\npm\\codex.cmd';
        const script = win32.join(win32.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        execFileMock.mockImplementation((_command, _args, _options, done) => done(null, `${shim}\r\n`));
        statMock.mockImplementation(async file => ({ isFile: () => file === shim || file === script }));
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        await expect(resolveSelectedCodexCommand('codex.cmd', 'win32')).resolves.toEqual({ command: 'node', args: [script] });
        expect(execFileMock).toHaveBeenCalledWith('where.exe', ['codex.cmd'], expect.objectContaining({ timeout: 3_000 }), expect.any(Function));
        expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('rejects unsupported Windows batch launchers instead of shell-interpreting JSON', async () => {
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        await expect(resolveSelectedCodexCommand('C:\\custom.cmd', 'win32')).rejects.toThrow('Use a Codex executable');
    });

    it('preserves explicitly selected macOS and Linux executables', async () => {
        const { resolveSelectedCodexCommand } = await import('./codexExecutable');
        for (const platform of ['darwin', 'linux'] as const) {
            await expect(resolveSelectedCodexCommand('/custom path/codex', platform)).resolves.toEqual({ command: '/custom path/codex', args: [] });
        }
    });

    it('looks up the Windows catalog Runner asynchronously on each PATH lookup', async () => {
        setPlatform('win32');
        const shim = codexShimPath(), script = codexScriptPath(), executable = userCodexExePath();
        let found = shim;
        execFileMock.mockImplementation((_command, _args, _options, done) =>
            queueMicrotask(() => done(null, `${found}\r\n`)));
        statMock.mockImplementation(async file => ({ isFile: () => [shim, script, executable].includes(file) }));
        const { resolveCatalogRunnerCommand } = await import('./codexExecutable');
        await expect(resolveCatalogRunnerCommand()).resolves.toEqual({ command: 'node', args: [script] });
        found = executable;
        await expect(resolveCatalogRunnerCommand()).resolves.toEqual({ command: executable, args: [] });
        expect(execFileMock).toHaveBeenCalledTimes(2);
        expect(execFileSyncMock).not.toHaveBeenCalled();
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
