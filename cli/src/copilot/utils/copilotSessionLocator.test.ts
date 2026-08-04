import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapCopilotLocalApprovalMode } from '../copilotLocalLauncher';
import {
    createCopilotSessionLocator,
    parseCopilotWorkspaceYaml
} from './copilotSessionLocator';

describe('mapCopilotLocalApprovalMode', () => {
    it('only escalates full yolo to --allow-all', () => {
        expect(mapCopilotLocalApprovalMode('yolo')).toEqual({ yolo: true });
        expect(mapCopilotLocalApprovalMode('safe-yolo')).toEqual({ yolo: false });
        expect(mapCopilotLocalApprovalMode('default')).toEqual({ yolo: false });
        expect(mapCopilotLocalApprovalMode('read-only')).toEqual({ yolo: false });
        expect(mapCopilotLocalApprovalMode(undefined)).toEqual({ yolo: false });
    });
});

describe('parseCopilotWorkspaceYaml', () => {
    it('reads id and cwd fields', () => {
        expect(parseCopilotWorkspaceYaml([
            'id: abc-123',
            'cwd: /home/ubuntu/hapi',
            'branch: main'
        ].join('\n'))).toEqual({
            id: 'abc-123',
            cwd: '/home/ubuntu/hapi'
        });
    });

    it('unquotes special characters in cwd values', () => {
        expect(parseCopilotWorkspaceYaml([
            'id: abc-123',
            'cwd: "/home/ubuntu/project #1"'
        ].join('\n'))).toEqual({
            id: 'abc-123',
            cwd: '/home/ubuntu/project #1'
        });
    });
});

describe('createCopilotSessionLocator', () => {
    const locators: Array<{ cleanup: () => Promise<void> }> = [];

    afterEach(async () => {
        while (locators.length > 0) {
            await locators.pop()?.cleanup();
        }
    });

    it('locates a fresh session for the working directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'copilot-locator-'));
        const sessionId = 'fresh-session-1';
        const sessionDir = join(root, sessionId);

        const located = vi.fn();
        const locator = createCopilotSessionLocator({
            cwd: '/work/project',
            startupTimestampMs: Date.now() - 1000,
            sessionStateRoot: root,
            intervalMs: 50,
            onLocated: located
        });
        locators.push(locator);
        await locator.ready;

        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'workspace.yaml'), [
            `id: ${sessionId}`,
            'cwd: /work/project',
            'client_name: github/cli'
        ].join('\n'));

        await vi.waitFor(() => {
            expect(located).toHaveBeenCalledWith({
                sessionId,
                sessionDir
            });
        }, { timeout: 2000 });
    });

    it('locates a session with a quoted cwd containing special characters', async () => {
        const root = await mkdtemp(join(tmpdir(), 'copilot-locator-'));
        const sessionId = 'quoted-cwd';
        const sessionDir = join(root, sessionId);
        const cwd = '/work/project #1';
        const located = vi.fn();
        const locator = createCopilotSessionLocator({
            cwd,
            startupTimestampMs: Date.now() - 1000,
            sessionStateRoot: root,
            intervalMs: 50,
            onLocated: located
        });
        locators.push(locator);

        await locator.ready;
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'workspace.yaml'), [
            `id: ${sessionId}`,
            `cwd: "${cwd}"`
        ].join('\n'));
        await vi.waitFor(() => {
            expect(located).toHaveBeenCalledWith({
                sessionId,
                sessionDir
            });
        }, { timeout: 2000 });
    });

    it('ignores sessions for other working directories', async () => {
        const root = await mkdtemp(join(tmpdir(), 'copilot-locator-'));
        const sessionDir = join(root, 'other-cwd');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'workspace.yaml'), [
            'id: other-cwd',
            'cwd: /work/other',
            'client_name: github/cli'
        ].join('\n'));

        const located = vi.fn();
        const locator = createCopilotSessionLocator({
            cwd: '/work/project',
            startupTimestampMs: Date.now() - 1000,
            sessionStateRoot: root,
            intervalMs: 50,
            onLocated: located
        });
        locators.push(locator);

        await locator.ready;
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(located).not.toHaveBeenCalled();
    });
});
