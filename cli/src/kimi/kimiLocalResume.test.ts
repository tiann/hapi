import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metadata } from '@/api/types';

const harness = vi.hoisted(() => ({
    failLaunch: true,
    launchDelayMs: 100
}));

vi.mock('./kimiLocal', () => ({
    kimiLocal: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, harness.launchDelayMs));
        if (harness.failLaunch) {
            throw new Error('kimi TUI failed to open the requested session');
        }
    })
}));

vi.mock('./utils/kimiWireScanner', () => ({
    createKimiWireScanner: async () => ({ cleanup: async () => {} }),
    convertKimiWireEvent: () => null
}));

vi.mock('./utils/kimiSessionTitleWatcher', () => ({
    createKimiSessionTitleWatcher: async () => ({ cleanup: async () => {} })
}));

import { kimiLocalLauncher } from './kimiLocalLauncher';
import { encodeKimiWorkDirKey, getKimiStatePath, getKimiWirePath } from './utils/kimiWireLocator';

describe('kimiLocalLauncher failed resume', () => {
    let homeDir: string;
    let workDir: string;
    let previousHome: string | undefined;

    beforeEach(async () => {
        previousHome = process.env.KIMI_CODE_HOME;
        homeDir = join(tmpdir(), `kimi-resume-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        workDir = join(tmpdir(), `kimi-resume-wd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(workDir, { recursive: true });
        process.env.KIMI_CODE_HOME = homeDir;

        const sessionDir = join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), 'session_requested');
        await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
        await writeFile(getKimiStatePath(sessionDir), JSON.stringify({ workDir }));
        await writeFile(getKimiWirePath(sessionDir), JSON.stringify({ type: 'metadata', protocol_version: '1.4' }) + '\n');
    });

    afterEach(async () => {
        if (previousHome === undefined) {
            delete process.env.KIMI_CODE_HOME;
        } else {
            process.env.KIMI_CODE_HOME = previousHome;
        }
        for (const dir of [homeDir, workDir]) {
            if (existsSync(dir)) {
                await rm(dir, { recursive: true, force: true });
            }
        }
    });

    it('does not publish the requested id when the local TUI fails after a pre-existing wire file', async () => {
        const publishedIds: string[] = [];
        let metadata: Metadata = { path: workDir, host: 'localhost' };
        const updateMetadata = vi.fn((handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const recordLocalLaunchFailure = vi.fn();
        const session = {
            path: workDir,
            sessionId: 'session_requested',
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            queue: { size: () => 0, reset: () => {}, setOnMessage: () => {} },
            client: {
                rpcHandlerManager: { registerHandler: () => {} },
                getMetadata: () => metadata,
                updateMetadata,
                sendClaudeSessionMessage: vi.fn()
            },
            getPermissionMode: () => 'default',
            onSessionFound: (sessionId: string) => {
                publishedIds.push(sessionId);
                updateMetadata((current) => ({ ...current, kimiSessionId: sessionId }));
            },
            sendUserMessage: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            recordLocalLaunchFailure
        };

        await kimiLocalLauncher(session as never, {});

        expect(publishedIds).toEqual([]);
        expect(updateMetadata).not.toHaveBeenCalled();
        expect(metadata.kimiSessionId).toBeUndefined();
        expect(recordLocalLaunchFailure).toHaveBeenCalled();
    });
});
