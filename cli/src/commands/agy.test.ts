import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAgyMock = vi.hoisted(() => vi.fn());

vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: vi.fn(async () => {})
}));

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: vi.fn(async () => {})
}));

vi.mock('@/utils/autoStartServer', () => ({
    maybeAutoStartServer: vi.fn(async () => {})
}));

vi.mock('@/agy/runAgy', () => ({
    runAgy: runAgyMock
}));

import { agyCommand } from './agy';

describe('agyCommand', () => {
    beforeEach(() => {
        runAgyMock.mockReset();
    });

    it('maps native agy aliases to HAPI agy runtime options', async () => {
        await agyCommand.run({
            args: ['agy'],
            subcommand: 'agy',
            commandArgs: [
                '--conversation', 'de582684-d186-4170-81ba-982809b4e28a',
                '--sandbox',
                '--dangerously-skip-permissions',
                '--add-dir', 'extra',
                '--log-file', '/tmp/agy.log',
                '--print-timeout', '90s',
                '--model', 'Gemini 3.5 Flash (High)'
            ]
        });

        expect(runAgyMock).toHaveBeenCalledWith({
            additionalDirectories: ['extra'],
            permissionMode: 'safe-yolo',
            resumeSessionId: 'de582684-d186-4170-81ba-982809b4e28a',
            logFile: '/tmp/agy.log',
            printTimeout: '90s',
            model: 'Gemini 3.5 Flash (High)'
        });
    });

    it('keeps explicit HAPI permission mode authoritative over native aliases', async () => {
        await agyCommand.run({
            args: ['agy'],
            subcommand: 'agy',
            commandArgs: ['--permission-mode', 'read-only', '--dangerously-skip-permissions']
        });

        expect(runAgyMock).toHaveBeenCalledWith({
            permissionMode: 'read-only'
        });
    });
});
