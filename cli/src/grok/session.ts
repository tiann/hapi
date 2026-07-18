import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { GrokMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import { getGrokSandboxProfile, hasSameGrokSandboxProfile } from './utils/grokSandbox';

export class GrokSession extends AgentSessionBase<GrokMode> {
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: { message: string; exitReason: LocalLaunchExitReason } | null = null;
    private runtimeConfigHandler: ((config: { model?: string | null; effort?: string | null }) => Promise<Record<string, unknown>>) | null = null;
    constructor(opts: {
        api: ApiClient; client: ApiSessionClient; path: string; logPath: string; sessionId: string | null;
        messageQueue: MessageQueue2<GrokMode>; onModeChange: (mode: 'local' | 'remote') => void;
        mode: 'local' | 'remote'; startedBy: 'runner' | 'terminal'; startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode; model?: string | null; effort?: string | null;
    }) {
        super({
            ...opts, sessionLabel: 'GrokSession', sessionIdLabel: 'Grok',
            applySessionIdToMetadata: (metadata, id) => ({ ...metadata, grokSessionId: id })
        });
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
    }
    setRuntime(config: { permissionMode?: PermissionMode; model?: string | null; effort?: string | null }): void {
        if (config.permissionMode !== undefined) this.permissionMode = config.permissionMode;
        if (config.model !== undefined) this.model = config.model;
        if (config.effort !== undefined) this.effort = config.effort;
    }
    setRuntimeConfigHandler(handler: ((config: { model?: string | null; effort?: string | null }) => Promise<Record<string, unknown>>) | null): void {
        this.runtimeConfigHandler = handler;
    }
    async applyRuntimeConfig(config: { permissionMode?: PermissionMode; model?: string | null; effort?: string | null }): Promise<Record<string, unknown>> {
        if (config.permissionMode !== undefined) {
            const currentMode = (this.getPermissionMode() as PermissionMode | undefined) ?? 'default';
            if (!hasSameGrokSandboxProfile(currentMode, config.permissionMode)) {
                throw new Error(
                    `Changing Grok permission mode from '${currentMode}' (${getGrokSandboxProfile(currentMode)}) `
                    + `to '${config.permissionMode}' (${getGrokSandboxProfile(config.permissionMode)}) changes the native sandbox. `
                    + 'Start a new Grok session to apply this permission mode.'
                );
            }
        }
        let backendApplied: Record<string, unknown> = {};
        if (this.runtimeConfigHandler) {
            backendApplied = await this.runtimeConfigHandler({ model: config.model, effort: config.effort });
        }
        const applied: { permissionMode?: PermissionMode; model?: string | null; effort?: string | null } = {
            ...config,
            ...backendApplied
        };
        // HAPI's null model is the user-facing Auto choice. Grok resolves it
        // to a concrete native model, but Hub requires the semantic null to
        // remain stable while effective effort may be reported concretely.
        if (config.model === null) applied.model = null;
        this.setRuntime(applied);
        return applied;
    }
    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => { this.localLaunchFailure = { message, exitReason }; };
    sendAgentMessage = (message: unknown): void => this.client.sendAgentMessage(message);
    sendUserMessage = (text: string): void => this.client.sendUserMessage(text);
    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => this.client.sendSessionEvent(event);
}
