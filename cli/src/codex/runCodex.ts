import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState, Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { runtimePath } from '@/projectPath';
import type { CodexSession } from './session';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

export async function runCodex(opts: {
    startedBy?: 'daemon' | 'terminal';
    codexArgs?: string[];
}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    const api = await ApiClient.create();

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let state: AgentState = {
        controlledByUser: false
    };

    const metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: runtimePath(),
        happyToolsDir: resolve(runtimePath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex'
    };

    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    const startingMode: 'local' | 'remote' = opts.startedBy === 'daemon' ? 'remote' : 'local';

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: startingMode === 'local'
    }));

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model
    }));

    let currentPermissionMode: PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel
        };
        messageQueue.push(message.content.text, enhancedMode);
    });

    let sessionWrapper: CodexSession | null = null;

    let cleanupStarted = false;
    let exitCode = 0;

    const cleanup = async (code: number = exitCode) => {
        if (cleanupStarted) {
            return;
        }
        cleanupStarted = true;
        logger.debug('[codex] Cleanup start');
        restoreTerminalState();
        try {
            if (sessionWrapper) {
                sessionWrapper.stopKeepAlive();
            }

            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            }));

            session.sendSessionDeath();
            await session.flush();
            await session.close();

            logger.debug('[codex] Cleanup complete, exiting');
            process.exit(code);
        } catch (error) {
            logger.debug('[codex] Error during cleanup:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => cleanup(0));
    process.on('SIGINT', () => cleanup(0));

    process.on('uncaughtException', (error) => {
        logger.debug('[codex] Uncaught exception:', error);
        exitCode = 1;
        cleanup(1);
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[codex] Unhandled rejection:', reason);
        exitCode = 1;
        cleanup(1);
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    let loopError: unknown = null;
    try {
        await loop({
            path: workingDirectory,
            startingMode,
            messageQueue,
            api,
            session,
            codexArgs: opts.codexArgs,
            onModeChange: (newMode) => {
                session.sendSessionEvent({ type: 'switch', mode: newMode });
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: newMode === 'local'
                }));
            },
            onSessionReady: (instance) => {
                sessionWrapper = instance;
            }
        });
    } catch (error) {
        loopError = error;
        exitCode = 1;
        logger.debug('[codex] Loop error:', error);
    } finally {
        await cleanup(loopError ? 1 : exitCode);
    }
}
