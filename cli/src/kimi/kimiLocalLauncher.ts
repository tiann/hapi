import { logger } from '@/ui/logger';
import { kimiLocal } from './kimiLocal';
import { KimiSession } from './session';
import type { PermissionMode } from './types';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import { createKimiWireLocator, type KimiWireLocator } from './utils/kimiWireLocator';
import { convertKimiWireEvent, createKimiWireScanner, type KimiWireScanner } from './utils/kimiWireScanner';
import { createKimiSessionTitleWatcher, type KimiSessionTitleWatcher } from './utils/kimiSessionTitleWatcher';

function mapApprovalMode(mode: PermissionMode | undefined): { yolo: boolean; plan: boolean } {
    if (!mode || mode === 'default' || mode === 'read-only') {
        return { yolo: false, plan: false };
    }
    if (mode === 'yolo' || mode === 'safe-yolo') {
        return { yolo: true, plan: false };
    }
    return { yolo: false, plan: false };
}

export async function kimiLocalLauncher(
    session: KimiSession,
    opts: {
        model?: string;
    }
): Promise<'switch' | 'exit'> {
    // Local mode spawns the kimi TUI directly. Mirror conversation events from
    // wire.jsonl and Kimi's authoritative native title from state.json.
    const startupTimestampMs = Date.now();
    let shuttingDown = false;
    let scanner: KimiWireScanner | null = null;
    let titleWatcher: KimiSessionTitleWatcher | null = null;
    let pendingScannerSetup: Promise<void> | null = null;
    let pendingTitleWatcherSetup: Promise<void> | null = null;
    const syncTitle = createNativeSessionTitleMetadataSync(session.client);

    const attachWireScanner = (wirePath: string): Promise<void> => {
        const setup = (async () => {
            const created = await createKimiWireScanner({
                wirePath,
                onEvent: (event) => {
                    if (shuttingDown) {
                        return;
                    }
                    const converted = convertKimiWireEvent(event, session.getModel() ?? opts.model);
                    if (!converted) {
                        return;
                    }
                    if (converted.userMessage) {
                        session.sendUserMessage(converted.userMessage);
                    }
                    if (converted.message) {
                        session.sendAgentMessage(converted.message);
                    }
                }
            });
            if (shuttingDown) {
                await created.cleanup();
                return;
            }
            scanner = created;
            logger.debug(`[kimi-local]: Attached wire scanner to ${wirePath}`);
        })();
        pendingScannerSetup = setup.catch((error) => {
            logger.warn(`[kimi-local]: Wire scanner setup failed for ${wirePath}`, error);
        }).finally(() => {
            pendingScannerSetup = null;
        });
        return pendingScannerSetup;
    };

    const attachTitleWatcher = (statePath: string): Promise<void> => {
        const setup = (async () => {
            const created = await createKimiSessionTitleWatcher({
                statePath,
                onTitle: syncTitle
            });
            if (shuttingDown) {
                await created.cleanup();
                return;
            }
            titleWatcher = created;
            logger.debug(`[kimi-local]: Attached title watcher to ${statePath}`);
        })();
        pendingTitleWatcherSetup = setup.catch((error) => {
            logger.warn(`[kimi-local]: Title watcher setup failed for ${statePath}`, error);
        }).finally(() => {
            pendingTitleWatcherSetup = null;
        });
        return pendingTitleWatcherSetup;
    };

    const locator: KimiWireLocator = createKimiWireLocator({
        cwd: session.path,
        startupTimestampMs,
        resumeSessionId: session.sessionId,
        onLocated: ({ sessionId, wirePath, statePath }) => {
            if (shuttingDown) {
                return;
            }
            session.onSessionFound(sessionId);
            void attachWireScanner(wirePath);
            void attachTitleWatcher(statePath);
        },
        onAmbiguous: (sessionIds) => {
            logger.warn(`[kimi-local]: Multiple fresh kimi sessions found (${sessionIds.join(', ')}); session sync disabled for this launch`);
        }
    });

    const launcher = new BaseLocalLauncher({
        label: 'kimi-local',
        failureLabel: 'Local Kimi process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            const approval = mapApprovalMode(session.getPermissionMode() as PermissionMode | undefined);
            await kimiLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                model: opts.model,
                yolo: approval.yolo,
                plan: approval.plan
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    try {
        // Ensure the pre-existing-session snapshot completed before kimi
        // spawns; otherwise the session dir created by this launch could be
        // captured in the snapshot and permanently excluded from sync.
        await locator.ready;
        return await launcher.run();
    } finally {
        shuttingDown = true;
        await locator.cleanup();
        if (pendingScannerSetup) {
            await pendingScannerSetup;
        }
        if (pendingTitleWatcherSetup) {
            await pendingTitleWatcherSetup;
        }
        const activeScanner = scanner as KimiWireScanner | null;
        if (activeScanner) {
            await activeScanner.cleanup();
            scanner = null;
        }
        const activeTitleWatcher = titleWatcher as KimiSessionTitleWatcher | null;
        if (activeTitleWatcher) {
            await activeTitleWatcher.cleanup();
            titleWatcher = null;
        }
    }
}
