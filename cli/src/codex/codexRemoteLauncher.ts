import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { join } from 'node:path';

import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { trimIdent } from '@/utils/trimIdent';
import type { CodexSessionConfig } from './types';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { restoreTerminalState } from '@/ui/terminalState';

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    // Warn if CLI args were passed that won't apply in remote mode
    if (session.codexArgs && session.codexArgs.length > 0) {
        logger.debug(`[codex-remote] Warning: CLI args [${session.codexArgs.join(', ')}] are ignored in remote mode. ` +
            `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
    }

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    const messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    let exitReason: 'switch' | 'exit' | null = null;
    let shouldExit = false;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
                exitReason = 'exit';
                shouldExit = true;
                await handleAbort();
            },
            onSwitchToLocal: async () => {
                logger.debug('[codex-remote]: Switching to local mode via double space');
                exitReason = 'switch';
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding('utf8');
    }

    const client = new CodexMcpClient();

    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter((full) => full.endsWith(`-${sessionId}.jsonl`))
                .filter((full) => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa;
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }

    const permissionHandler = new CodexPermissionHandler(session.client);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        session.sendCodexMessage(message);
    });

    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        }

        if (msg.type === 'task_started') {
            if (!session.thinking) {
                logger.debug('thinking started');
                session.onThinkingChange(true);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (session.thinking) {
                logger.debug('thinking completed');
                session.onThinkingChange(false);
            }
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            const { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            const { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            const { call_id, auto_approved, changes } = msg;

            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            const { call_id, stdout, stderr, success } = msg;

            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });

    const happyServer = await startHappyServer(session.client);
    const bridgeCommand = getHappyCliCommand(['mcp', '--url', happyServer.url]);
    const mcpServers = {
        hapi: {
            command: bridgeCommand.command,
            args: bridgeCommand.args
        }
    } as const;

    let abortController = new AbortController();
    let storedSessionIdForResume: string | null = null;

    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }

            abortController.abort();
            session.queue.reset();
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    session.client.rpcHandlerManager.registerHandler('abort', async () => {
        await handleAbort();
    });

    session.client.rpcHandlerManager.registerHandler('switch', async () => {
        exitReason = 'switch';
        shouldExit = true;
        await handleAbort();
    });

    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch {}
    }

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const syncSessionId = () => {
        const clientSessionId = client.getSessionId();
        if (clientSessionId && clientSessionId !== session.sessionId) {
            session.onSessionFound(clientSessionId);
        }
    };

    try {
        await client.connect();

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let nextExperimentalResume: string | null = null;
        let first = true;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (error) {
                    logger.debug('[Codex] Error while searching resume file', error);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                const approvalPolicy = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'untrusted' as const;
                        case 'read-only': return 'never' as const;
                        case 'safe-yolo': return 'on-failure' as const;
                        case 'yolo': return 'on-failure' as const;
                    }
                })();
                const sandbox = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'workspace-write' as const;
                        case 'read-only': return 'read-only' as const;
                        case 'safe-yolo': return 'workspace-write' as const;
                        case 'yolo': return 'danger-full-access' as const;
                    }
                })();

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: first ? message.message + '\n\n' + trimIdent(`Based on this message, call functions.hapi__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`) : message.message,
                        sandbox,
                        'approval-policy': approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };
                    if (message.mode.model) {
                        startConfig.model = message.mode.model;
                    }

                    let resumeFile: string | null = null;
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null;
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    } else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null;
                    }

                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }

                    await client.startSession(startConfig, { signal: abortController.signal });
                    wasCreated = true;
                    first = false;
                    syncSessionId();
                } else {
                    await client.continueSession(message.message, { signal: abortController.signal });
                    syncSessionId();
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    wasCreated = false;
                    currentModeHash = null;
                    logger.debug('[Codex] Marked session as not created after abort for proper resume');
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit,
                    sendReady
                });
                logActiveHandles('after-turn');
            }
        }
    } finally {
        logger.debug('[codex-remote]: cleanup start');
        try {
            await client.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        happyServer.stop();
        permissionHandler.reset();
        reasoningProcessor.abort();
        diffProcessor.reset();

        restoreTerminalState();
        if (hasTTY) {
            try { process.stdin.pause(); } catch {}
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();
        logger.debug('[codex-remote]: cleanup done');
    }

    return exitReason || 'exit';
}
