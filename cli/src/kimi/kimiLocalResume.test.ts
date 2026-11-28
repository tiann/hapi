import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metadata } from '@/api/types';

const harness = vi.hoisted(() => ({
    failLaunch: true,
    launchDelayMs: 100,
    useRealWireScanner: false,
    appendResumeTurn: null as null | (() => Promise<void>),
    waitForResumeConfirmation: null as null | (() => Promise<void>)
}));

vi.mock('./kimiLocal', () => ({
    kimiLocal: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, harness.launchDelayMs));
        if (harness.failLaunch) {
            throw new Error('kimi TUI failed to open the requested session');
        }
        await harness.appendResumeTurn?.();
        await harness.waitForResumeConfirmation?.();
    })
}));

vi.mock('./utils/kimiWireScanner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/kimiWireScanner')>();
    return {
        createKimiWireScanner: async (opts: Parameters<typeof actual.createKimiWireScanner>[0]) =>
            harness.useRealWireScanner
                ? actual.createKimiWireScanner(opts)
                : { cleanup: async () => {} },
        convertKimiWireEvent: (event: Parameters<typeof actual.convertKimiWireEvent>[0], model?: string | null) =>
            harness.useRealWireScanner ? actual.convertKimiWireEvent(event, model) : null
    };
});

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
        harness.failLaunch = true;
        harness.useRealWireScanner = false;
        harness.appendResumeTurn = null;
        harness.waitForResumeConfirmation = null;
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

    it('forwards the first turn that confirms a local resume exactly once', async () => {
        harness.failLaunch = false;
        harness.useRealWireScanner = true;
        const sessionDir = join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), 'session_requested');
        const wirePath = getKimiWirePath(sessionDir);
        await appendFile(wirePath, JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'old prompt from previous session' }],
            origin: { kind: 'user' }
        }) + '\n');
        await appendFile(wirePath, JSON.stringify({
            type: 'context.append_loop_event',
            event: { type: 'content.part', uuid: 'old', part: { type: 'text', text: 'old reply from previous session' } }
        }) + '\n');

        const publishedIds: string[] = [];
        const userMessages: string[] = [];
        const agentMessages: unknown[] = [];
        let metadata: Metadata = { path: workDir, host: 'localhost' };
        const updateMetadata = vi.fn((handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        let confirmResume!: () => void;
        const resumeConfirmed = new Promise<void>((resolve) => {
            confirmResume = resolve;
        });

        harness.appendResumeTurn = async () => {
            await appendFile(wirePath, JSON.stringify({
                type: 'turn.prompt',
                input: [{ type: 'text', text: 'first prompt after resume' }],
                origin: { kind: 'user' }
            }) + '\n');
            await appendFile(wirePath, JSON.stringify({
                type: 'context.append_loop_event',
                event: { type: 'content.part', uuid: 'new', part: { type: 'text', text: 'first reply after resume' } }
            }) + '\n');
        };
        harness.waitForResumeConfirmation = async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    resumeConfirmed,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error('resume was not confirmed')), 3000);
                    })
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };

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
            getModel: () => undefined,
            onSessionFound: (sessionId: string) => {
                publishedIds.push(sessionId);
                confirmResume();
                updateMetadata((current) => ({ ...current, kimiSessionId: sessionId }));
            },
            sendUserMessage: (message: string) => userMessages.push(message),
            sendAgentMessage: (message: unknown) => agentMessages.push(message),
            sendSessionEvent: vi.fn(),
            recordLocalLaunchFailure: vi.fn()
        };

        await kimiLocalLauncher(session as never, {});

        expect(publishedIds).toEqual(['session_requested']);
        expect(userMessages).toEqual(['first prompt after resume']);
        expect(agentMessages).toEqual([{ type: 'message', message: 'first reply after resume' }]);
        expect(metadata.kimiSessionId).toBe('session_requested');
        expect(updateMetadata).toHaveBeenCalledTimes(1);
    });

    it('forwards a first turn written just before the TUI exits', async () => {
        harness.failLaunch = false;
        harness.useRealWireScanner = true;
        const sessionDir = join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), 'session_requested');
        const wirePath = getKimiWirePath(sessionDir);
        await appendFile(wirePath, JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'old prompt from previous session' }],
            origin: { kind: 'user' }
        }) + '\n');

        const publishedIds: string[] = [];
        const userMessages: string[] = [];
        const agentMessages: unknown[] = [];
        let metadata: Metadata = { path: workDir, host: 'localhost' };
        const updateMetadata = vi.fn((handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        harness.appendResumeTurn = async () => {
            await appendFile(wirePath, JSON.stringify({
                type: 'turn.prompt',
                input: [{ type: 'text', text: 'late first prompt after resume' }],
                origin: { kind: 'user' }
            }) + '\n');
            await appendFile(wirePath, JSON.stringify({
                type: 'context.append_loop_event',
                event: { type: 'content.part', uuid: 'late', part: { type: 'text', text: 'late first reply after resume' } }
            }) + '\n');
        };

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
            getModel: () => undefined,
            onSessionFound: (sessionId: string) => {
                publishedIds.push(sessionId);
                updateMetadata((current) => ({ ...current, kimiSessionId: sessionId }));
            },
            sendUserMessage: (message: string) => userMessages.push(message),
            sendAgentMessage: (message: unknown) => agentMessages.push(message),
            sendSessionEvent: vi.fn(),
            recordLocalLaunchFailure: vi.fn()
        };

        await kimiLocalLauncher(session as never, {});

        expect(publishedIds).toEqual(['session_requested']);
        expect(userMessages).toEqual(['late first prompt after resume']);
        expect(agentMessages).toEqual([{ type: 'message', message: 'late first reply after resume' }]);
        expect(metadata.kimiSessionId).toBe('session_requested');
    });
});
