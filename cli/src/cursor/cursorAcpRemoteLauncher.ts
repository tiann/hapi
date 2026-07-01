import React from 'react';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import type { CursorSession } from './session';
import type { PermissionMode } from './loop';
import { createCursorAcpBackend, CURSOR_ACP_REQUIRED_MESSAGE } from './utils/cursorAcpBackend';
import { setCursorAcpModelsSnapshot } from './utils/cursorAcpModelsBridge';
import { buildCursorModelsSnapshotFromAcp } from './utils/cursorAcpModelsSnapshot';
import { CursorExtensionAdapter } from './utils/cursorExtensionAdapter';
import { applyCursorAcpMode, applyCursorAcpModel, wireIdForCursorSessionState } from './utils/cursorModeConfig';
import { buildCursorModelsSeedPayload, seedCursorModelsCache } from '@/modules/common/cursorModels';
import { readSharedCursorModelsCache } from '@/modules/common/cursorModelsSharedCache';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { installCursorMcpOverlay, type CursorMcpOverlayHandle } from './utils/cursorMcpOverlay';

class CursorAcpRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CursorSession;
    private backend: ReturnType<typeof createCursorAcpBackend> | null = null;
    private permissionAdapter: PermissionAdapter | null = null;
    private extensionAdapter: CursorExtensionAdapter | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayPermissionMode: PermissionMode | null = null;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private unregisterModelApplyHandler: (() => void) | null = null;
    private modelApplySeq = 0;
    private cursorMcpOverlay: CursorMcpOverlayHandle | null = null;

    constructor(session: CursorSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(OpencodeDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        const hapiBridge = mcpServers.hapi;
        if (hapiBridge) {
            this.cursorMcpOverlay = installCursorMcpOverlay(session.path, {
                command: hapiBridge.command,
                args: hapiBridge.args,
            });
        }

        const backend = createCursorAcpBackend({ cwd: session.path, model: session.model });
        this.backend = backend;

        backend.setUsageUpdateListener((message) => this.handleAgentMessage(message));

        backend.onStderrError((error) => {
            logger.debug('[cursor-acp] stderr error', error);
            const converted = convertAgentMessage({ type: 'error', message: error.message });
            if (converted) {
                session.sendAgentMessage(converted);
            }
            messageBuffer.addMessage(error.message, 'status');
        });

        try {
            await backend.initialize();
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const fullMsg = `${CURSOR_ACP_REQUIRED_MESSAGE} (${errMsg})`;
            const converted = convertAgentMessage({ type: 'error', message: fullMsg });
            if (converted) {
                session.sendAgentMessage(converted);
            }
            messageBuffer.addMessage(fullMsg, 'status');
            throw new Error(fullMsg);
        }

        await backend.authenticateIfAvailable('cursor_login');

        const extensionAdapter = new CursorExtensionAdapter(
            session.client,
            backend,
            (message) => this.handleAgentMessage(message)
        );
        this.extensionAdapter = extensionAdapter;

        this.permissionAdapter = new PermissionAdapter(
            session.client,
            backend,
            () => session.getPermissionMode(),
            (response) => extensionAdapter.handlePermissionResponse(response)
        );

        const resumeSessionId = session.sessionId;
        // Cursor ACP ignores session/new|load mcpServers; native .cursor/mcp.json is wired above.
        const mcpServerList: McpServerStdio[] = [];
        let acpSessionId: string;

        if (resumeSessionId && backend.supportsLoadSession()) {
            // Register pending cursorSessionId before awaiting session/load (Zed PR #54431).
            session.onSessionFoundWithProtocol(resumeSessionId, 'acp');
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: resumeSessionId,
                    cwd: session.path,
                    mcpServers: mcpServerList,
                });
            } catch (error) {
                logger.warn('[cursor-acp] session/load failed', formatAcpLoadError(error));
                throw new Error(
                    'Failed to resume Cursor ACP session. Legacy stream-json sessions cannot be loaded via ACP.'
                );
            }
        } else if (resumeSessionId) {
            throw new Error(
                'Cursor ACP session/load is not supported by this agent build. Start a new Cursor session.'
            );
        } else {
            acpSessionId = await backend.newSession({
                cwd: session.path,
                mcpServers: mcpServerList
            });
        }

        if (acpSessionId !== resumeSessionId) {
            session.onSessionFoundWithProtocol(acpSessionId, 'acp');
            // tiann/hapi#913: block until the metadata write that pins
            // `cursorSessionId` reaches the hub DB before we drop into
            // `runMainLoop`. If SIGTERM (hub-restart cascade) lands during
            // the first turn without this gate, the only durable handle
            // linking the session to its on-disk ACP store is lost and the
            // session strands. The resume path at lines 98-100 already
            // relies on the latency of `backend.loadSession()` to flush the
            // same write; the fresh-session path has no such cover.
            const flushed = await session.client.flushMetadata();
            if (!flushed) {
                logger.warn(`[cursor-acp] cursorSessionId metadata write did not ACK within 5s; session may be unrecoverable if killed before the lock drains (acpSessionId=${acpSessionId})`);
            }
        }

        session.client.emitSessionReady();

        syncCursorModelsFromAcp(backend, acpSessionId);

        const initialMetadata = backend.getSessionModelsMetadata(acpSessionId);
        this.currentBackendModel = initialMetadata?.currentModelId ?? session.model ?? null;
        this.defaultBackendModel = this.currentBackendModel;

        const previousSetModel = session.setModel.bind(session);

        await applyCursorAcpMode(backend, acpSessionId, session.getPermissionMode() as PermissionMode);
        if (session.model) {
            await this.applyLiveModel(backend, acpSessionId, session.model, previousSetModel, {
                optimistic: false,
                throwOnFailure: false
            });
        } else if (this.currentBackendModel && !isSpawnDefaultModel(this.currentBackendModel)) {
            this.pushModelStatusLine(this.currentBackendModel);
        }

        this.installLiveSessionConfigSync(backend, acpSessionId, previousSetModel);

        this.applyDisplayMode(session.getPermissionMode() as PermissionMode);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;

            const modelChanged = Boolean(
                requestedModel && requestedModel !== this.currentBackendModel
            );
            if (modelChanged) {
                const appliedModel = await this.applyLiveModel(
                    backend,
                    acpSessionId,
                    requestedModel,
                    previousSetModel,
                    { optimistic: false, throwOnFailure: false }
                );
                batch.mode.model = appliedModel ?? this.currentBackendModel ?? undefined;
            }

            await applyCursorAcpMode(backend, acpSessionId, batch.mode.permissionMode as PermissionMode);
            this.applyDisplayMode(batch.mode.permissionMode as PermissionMode);
            messageBuffer.addMessage(batch.message, 'user');

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message,
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message) => {
                    this.handleAgentMessage(message);
                });
            } catch (error) {
                logger.warn('[cursor-acp] prompt failed', error);
                const errMsg = error instanceof Error ? error.message : String(error);
                const message = `Cursor Agent failed: ${errMsg}`;
                const converted = convertAgentMessage({ type: 'error', message });
                if (converted) {
                    session.sendAgentMessage(converted);
                }
                messageBuffer.addMessage(message, 'status');
            } finally {
                session.onThinkingChange(false);
                await this.permissionAdapter?.cancelAll('Prompt finished');
                await this.extensionAdapter?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.unregisterModelApplyHandler?.();
        this.unregisterModelApplyHandler = null;

        if (this.permissionAdapter) {
            await this.permissionAdapter.cancelAll('Session ended');
            this.permissionAdapter = null;
        }

        if (this.extensionAdapter) {
            await this.extensionAdapter.cancelAll('Session ended');
            this.extensionAdapter = null;
        }

        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        if (this.cursorMcpOverlay) {
            this.cursorMcpOverlay.cleanup();
            this.cursorMcpOverlay = null;
        }

        setCursorAcpModelsSnapshot(null);
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                break;
            case 'usage':
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant');
                break;
            case 'turn_complete':
                break;
            default:
                break;
        }
    }

    private installLiveSessionConfigSync(
        backend: AcpSdkBackend,
        acpSessionId: string,
        previousSetModel: CursorSession['setModel']
    ): void {
        const session = this.session;
        const previousSetPermissionMode = session.setPermissionMode.bind(session);
        session.setPermissionMode = (mode: PermissionMode) => {
            previousSetPermissionMode(mode);
            void applyCursorAcpMode(backend, acpSessionId, mode).then(() => {
                this.applyDisplayMode(mode);
            });
        };

        this.unregisterModelApplyHandler = session.registerModelApplyHandler(async (model) => (
            await this.applyLiveModel(backend, acpSessionId, model, previousSetModel, {
                optimistic: false,
                throwOnFailure: true
            })
        ));

        session.setModel = (model: string | null | undefined) => {
            void this.applyLiveModel(backend, acpSessionId, model, previousSetModel, {
                optimistic: true,
                throwOnFailure: false
            }).catch((error) => {
                logger.warn('[cursor-acp] Failed to apply model from session sync', error);
            });
        };
    }

    private async applyLiveModel(
        backend: AcpSdkBackend,
        acpSessionId: string,
        model: string | null | undefined,
        previousSetModel: CursorSession['setModel'],
        options: { optimistic: boolean; throwOnFailure: boolean }
    ): Promise<string | null> {
        const requested = model?.trim();
        const previousModel = this.currentBackendModel ?? this.session.model ?? null;
        const applySeq = ++this.modelApplySeq;

        if (!requested || isSpawnDefaultModel(requested)) {
            const modelOption = backend.getConfigOptionByCategory?.(acpSessionId, 'model');
            const defaultWire = modelOption?.options?.find(
                (option) => isSpawnDefaultModel(option.value)
            )?.value;
            if (modelOption && defaultWire && backend.setConfigOption) {
                try {
                    await backend.setConfigOption(acpSessionId, modelOption.id, defaultWire);
                    backend.pinSessionModelWireId(acpSessionId, defaultWire);
                } catch (error) {
                    logger.debug('[cursor-acp] Failed to set default model via ACP', error);
                    if (options.throwOnFailure) {
                        throw new Error('Cursor default model is not available via ACP');
                    }
                }
            } else if (options.throwOnFailure) {
                throw new Error('Cursor default model is not available via ACP');
            }
            this.currentBackendModel = null;
            previousSetModel(undefined);
            this.session.pushKeepAlive();
            syncCursorModelsFromAcp(backend, acpSessionId);
            return null;
        }

        if (options.optimistic) {
            const optimisticWire = wireIdForCursorSessionState(requested, requested);
            this.currentBackendModel = optimisticWire;
            previousSetModel(optimisticWire);
            this.session.pushKeepAlive();
        }

        const result = await applyCursorAcpModel(backend, acpSessionId, requested);
        if (!result.applied || !result.resolvedWireId) {
            const message = `Cursor model is not available via ACP: ${requested}`;
            logger.warn(`[cursor-acp] ${message}`);

            if (options.optimistic && applySeq === this.modelApplySeq) {
                this.currentBackendModel = previousModel;
                previousSetModel(previousModel ?? undefined);
                this.session.pushKeepAlive();
            } else if (!options.throwOnFailure && previousModel && !isSpawnDefaultModel(previousModel)) {
                this.currentBackendModel = previousModel;
                previousSetModel(previousModel);
                this.session.pushKeepAlive();
            }
            syncCursorModelsFromAcp(backend, acpSessionId);

            if (options.throwOnFailure) {
                throw new Error(message);
            }
            return previousModel;
        }

        const sessionWire = wireIdForCursorSessionState(
            result.requestedWireId ?? requested,
            result.resolvedWireId
        );

        if (applySeq !== this.modelApplySeq) {
            return this.currentBackendModel;
        }

        const changed = sessionWire !== this.currentBackendModel || this.session.model !== sessionWire;
        this.currentBackendModel = sessionWire;
        previousSetModel(sessionWire);
        if (changed) {
            this.pushModelStatusLine(sessionWire);
        }
        this.session.pushKeepAlive();
        syncCursorModelsFromAcp(backend, acpSessionId);
        return sessionWire;
    }

    private pushModelStatusLine(model: string | null | undefined): void {
        const trimmed = model?.trim();
        if (!trimmed || isSpawnDefaultModel(trimmed)) {
            this.messageBuffer.addMessage('[MODEL:auto]', 'system');
            return;
        }
        this.messageBuffer.addMessage(`[MODEL:${trimmed}]`, 'system');
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
    }

    private async handleAbort(): Promise<void> {
        const backend = this.backend;
        const sessionId = this.session.sessionId;
        if (backend && sessionId) {
            await backend.cancelPrompt(sessionId);
        }
        await this.permissionAdapter?.cancelAll('User aborted');
        await this.extensionAdapter?.cancelAll('User aborted');
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

function formatAcpLoadError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const record: Record<string, unknown> = {
            name: error.name,
            message: error.message
        };
        const code = (error as Error & { code?: unknown }).code;
        if (code !== undefined) {
            record.code = code;
        }
        const data = (error as Error & { data?: unknown }).data;
        if (data !== undefined) {
            record.data = data;
        }
        const cause = error.cause;
        if (cause !== undefined) {
            record.cause = cause instanceof Error
                ? { name: cause.name, message: cause.message }
                : cause;
        }
        return record;
    }
    if (typeof error === 'object' && error !== null) {
        return { ...(error as Record<string, unknown>) };
    }
    return { message: String(error) };
}

function isSpawnDefaultModel(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]';
}

function syncCursorModelsFromAcp(backend: AcpSdkBackend, acpSessionId: string): void {
    const snapshot = buildCursorModelsSnapshotFromAcp(backend, acpSessionId);
    if (!snapshot) {
        return;
    }

    const payload = buildCursorModelsSeedPayload(snapshot, readSharedCursorModelsCache());
    setCursorAcpModelsSnapshot(snapshot);
    seedCursorModelsCache(payload);
}

export async function cursorAcpRemoteLauncher(session: CursorSession): Promise<'switch' | 'exit'> {
    const launcher = new CursorAcpRemoteLauncher(session);
    return launcher.launch();
}
