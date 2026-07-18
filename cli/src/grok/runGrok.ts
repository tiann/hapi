import { logger } from '@/ui/logger';
import { grokLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { GrokSession } from './session';
import type { GrokMode, PermissionMode } from './types';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { applyHapiSessionEnvironment } from '@/agent/sessionEnvironment';

export async function runGrok(opts: {
    startedBy?: 'runner' | 'terminal'; startingMode?: 'local' | 'remote'; permissionMode?: PermissionMode;
    resumeSessionId?: string; model?: string; effort?: string;
} = {}): Promise<void> {
    const path = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    let startingMode = opts.startingMode ?? (startedBy === 'runner' ? 'remote' : 'local');
    const permissionMode = opts.permissionMode ?? 'default';
    if (startedBy === 'runner' && startingMode === 'local') startingMode = 'remote';
    if (startingMode === 'local' && (permissionMode === 'read-only' || permissionMode === 'safe-yolo')) {
        logger.debug(`[grok] ${permissionMode} requires HAPI-mediated permissions; using remote ACP mode`);
        startingMode = 'remote';
    }
    const initialState: AgentState = { controlledByUser: false };
    const { api, session, sessionInfo, reportStartedToRunner } = await bootstrapSession({
        flavor: 'grok', startedBy, workingDirectory: path, agentState: initialState,
        model: opts.model, effort: opts.effort
    });
    applyHapiSessionEnvironment(sessionInfo.id);
    setControlledByUser(session, startingMode);
    let current: GrokMode = { permissionMode, model: opts.model, effort: opts.effort };
    const queue = new MessageQueue2<GrokMode>((mode) => hashObject(mode));
    const ref: { current: GrokSession | null } = { current: null };
    const lifecycle = createRunnerLifecycle({ session, logTag: 'grok', stopKeepAlive: () => ref.current?.stopKeepAlive() });
    lifecycle.registerProcessHandlers();
    await reportStartedToRunner();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);
    session.onUserMessage((message) => {
        const active = ref.current;
        queue.push(formatMessageWithAttachments(message.content.text, message.content.attachments), active ? {
            permissionMode: active.getPermissionMode() as PermissionMode,
            model: active.getModel(),
            effort: active.getEffort()
        } : { ...current });
    });
    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') throw new Error('Invalid session config payload');
        const config = payload as { permissionMode?: unknown; model?: unknown; effort?: unknown };
        const changed: { permissionMode?: PermissionMode; model?: string | null; effort?: string | null } = {};
        if (config.permissionMode !== undefined) {
            const parsed = PermissionModeSchema.safeParse(config.permissionMode);
            if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'grok')) throw new Error('Invalid permission mode');
            changed.permissionMode = parsed.data as PermissionMode;
        }
        if (config.model !== undefined && config.model !== null && typeof config.model !== 'string') throw new Error('Invalid model');
        if (config.effort !== undefined && config.effort !== null && typeof config.effort !== 'string') throw new Error('Invalid effort');
        if (config.model !== undefined) {
            changed.model = config.model as string | null;
        }
        if (config.effort !== undefined) {
            changed.effort = config.effort as string | null;
        }
        const applied = await ref.current?.applyRuntimeConfig(changed) ?? changed;
        current = { ...current, ...applied };
        return { applied };
    });
    try {
        await grokLoop({
            path, startingMode, startedBy, messageQueue: queue, session, api,
            permissionMode: current.permissionMode, model: current.model, effort: current.effort,
            resumeSessionId: opts.resumeSessionId, onModeChange: createModeChangeHandler(session),
            onSessionReady: (value) => { ref.current = value; value.setRuntime(current); }
        });
    } catch (error) {
        lifecycle.markCrash(error);
        logger.debug('[grok] Loop error', error);
    } finally {
        const failure = ref.current?.localLaunchFailure;
        if (failure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${failure.message.slice(0, 200)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
