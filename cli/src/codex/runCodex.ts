import { logger } from '@/ui/logger';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CodexSession } from './session';
import { parseCodexCliOverrides } from './utils/codexCliOverrides';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { CodexCollaborationModeSchema, CodexServiceTierSchema, PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { ReasoningEffort } from './appServerTypes';
import type { CodexServiceTier } from '@hapi/protocol/types';
import { applyHapiSessionEnvironment } from '@/agent/sessionEnvironment';
import { DeliveryOutcomeClient } from './deliveryOutcomeClient';
import { randomUUID } from 'node:crypto';
import { RecoveringSerialQueue } from '@/utils/recoveringSerialQueue';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export async function runCodex(opts: {
    startedBy?: 'runner' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    model?: string;
    modelReasoningEffort?: ReasoningEffort;
    serviceTier?: CodexServiceTier;
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

    let state: AgentState = {
        controlledByUser: false
    };
    const launchNonce = process.env.HAPI_LAUNCH_NONCE;
    const runnerInstanceId = process.env.HAPI_RUNNER_INSTANCE_ID;
    const { api, session, sessionInfo, machineId, reportStartedToRunner } = await bootstrapSession({
        flavor: 'codex',
        startedBy,
        workingDirectory,
        agentState: state,
        model: opts.model,
        modelReasoningEffort: opts.modelReasoningEffort,
        serviceTier: opts.serviceTier,
        metadataOverrides: launchNonce && runnerInstanceId ? { launchNonce, runnerInstanceId } : undefined
    });
    applyHapiSessionEnvironment(sessionInfo.id);

    const startingMode: 'local' | 'remote' = startedBy === 'runner' ? 'remote' : 'local';

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        modelReasoningEffort: mode.modelReasoningEffort,
        serviceTier: mode.serviceTier,
        collaborationMode: mode.collaborationMode
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };
    const deliveryOutcomes = launchNonce ? new DeliveryOutcomeClient({
        namespace: sessionInfo.namespace,
        machineId,
        sessionId: sessionInfo.id,
        launchNonce,
        prepare: async (attempts) => {
            const result = await session.prepareDeliveryBatch({ attempts });
            if (result.result === 'success') return 'success';
            return ['ack-timeout', 'internal-error', 'invalid-transition'].includes(result.reason)
                ? 'ambiguous'
                : 'definitive-no-write';
        },
        record: async (request) => (await session.recordDeliveryAttempt(request)).result === 'success'
    }) : undefined;

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel = opts.model;
    let currentModelReasoningEffort: ReasoningEffort | undefined = opts.modelReasoningEffort;
    let currentServiceTier: CodexServiceTier | undefined = opts.serviceTier;
    let currentCollaborationMode: EnhancedMode['collaborationMode'] = 'default';

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'codex',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    await reportStartedToRunner();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        const sessionModel = sessionInstance.getModel();
        if (sessionModel !== undefined) {
            currentModel = sessionModel ?? undefined;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(currentModel ?? null);
        sessionInstance.setModelReasoningEffort(currentModelReasoningEffort ?? null);
        sessionInstance.setServiceTier(currentServiceTier ?? null);
        sessionInstance.setCollaborationMode(currentCollaborationMode);
        logger.debug(
            `[Codex] Synced session config for keepalive: ` +
            `permissionMode=${currentPermissionMode}, model=${currentModel ?? 'auto'}, ` +
            `modelReasoningEffort=${currentModelReasoningEffort ?? 'default'}, serviceTier=${currentServiceTier ?? 'default'}, ` +
            `collaborationMode=${currentCollaborationMode}`
        );
    };

    const enqueueSerial = new RecoveringSerialQueue((error) => {
        lifecycle.markManagedUnhealthy?.('ambiguous-turn-delivery');
        logger.warn('[Codex] Failed to terminalize queued messages before mutation', error);
    });
    const invalidateManagedQueue = async (reason: string): Promise<void> => {
        const attemptId = randomUUID();
        await messageQueue.invalidateAll(reason, async (item) => {
            if (!deliveryOutcomes) return;
            const recorded = await deliveryOutcomes.recordTerminal(
                [{ messageId: item.messageId, sequence: item.seq }],
                attemptId,
                'superseded'
            );
            if (!recorded) throw new Error(`failed to durably supersede queued message ${item.messageId}`);
        });
    };
    session.onUserMessage((message) => {
        const sessionPermissionMode = sessionWrapperRef.current?.getPermissionMode();
        if (sessionPermissionMode && isPermissionModeAllowedForFlavor(sessionPermissionMode, 'codex')) {
            currentPermissionMode = sessionPermissionMode as PermissionMode;
        }
        const sessionModel = sessionWrapperRef.current?.getModel();
        if (sessionModel !== undefined) {
            currentModel = sessionModel ?? undefined;
        }
        const sessionModelReasoningEffort = sessionWrapperRef.current?.getModelReasoningEffort();
        if (sessionModelReasoningEffort !== undefined) {
            currentModelReasoningEffort = (sessionModelReasoningEffort ?? undefined) as ReasoningEffort | undefined;
        }
        const sessionServiceTier = sessionWrapperRef.current?.getServiceTier();
        if (sessionServiceTier !== undefined) {
            currentServiceTier = (sessionServiceTier ?? undefined) as CodexServiceTier | undefined;
        }
        const sessionCollaborationMode = sessionWrapperRef.current?.getCollaborationMode();
        if (sessionCollaborationMode) {
            currentCollaborationMode = sessionCollaborationMode;
        }

        const messagePermissionMode = currentPermissionMode;
        logger.debug(
            `[Codex] User message received with permission mode: ${currentPermissionMode}, ` +
            `model: ${currentModel ?? 'auto'}, modelReasoningEffort: ${currentModelReasoningEffort ?? 'default'}, ` +
            `serviceTier: ${currentServiceTier ?? 'default'}, collaborationMode: ${currentCollaborationMode}`
        );

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModel,
            modelReasoningEffort: currentModelReasoningEffort,
            serviceTier: currentServiceTier,
            collaborationMode: currentCollaborationMode
        };

        const specialCommand = parseSpecialCommand(message.content.text);
        if (!deliveryOutcomes) {
            if (specialCommand.type === 'compact' || specialCommand.type === 'goal') {
                const commandText = (specialCommand.originalMessage ?? message.content.text).trim();
                messageQueue.pushIsolateAndClear(commandText, enhancedMode, message.delivery);
            } else {
                messageQueue.push(formatMessageWithAttachments(message.content.text, message.content.attachments), enhancedMode, message.delivery);
            }
            return;
        }
        const enqueue = async () => {
            if (specialCommand.type === 'compact' || specialCommand.type === 'goal') {
                await invalidateManagedQueue('codex-isolate-command');
                const commandText = (specialCommand.originalMessage ?? message.content.text).trim();
                messageQueue.pushIsolateAndClear(commandText, enhancedMode, message.delivery);
                return;
            }

            const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
            messageQueue.push(formattedText, enhancedMode, message.delivery);
        };
        void enqueueSerial.enqueue(enqueue).catch(() => {
            // RecoveringSerialQueue already reports this failure and keeps the
            // tail usable for later messages.
        });
    });

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'codex')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveCollaborationMode = (value: unknown): EnhancedMode['collaborationMode'] => {
        if (value === null) {
            return 'default';
        }
        const parsed = CodexCollaborationModeSchema.safeParse(value);
        if (!parsed.success) {
            throw new Error('Invalid collaboration mode');
        }
        return parsed.data;
    };

    const resolveModelReasoningEffort = (value: unknown): ReasoningEffort | undefined => {
        if (value === null) {
            return undefined;
        }
        if (typeof value !== 'string' || !REASONING_EFFORTS.has(value as ReasoningEffort)) {
            throw new Error('Invalid model reasoning effort');
        }
        return value as ReasoningEffort;
    };

    const resolveModel = (value: unknown): string | undefined => {
        if (value === null) {
            return undefined;
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error('Invalid model');
        }
        return value.trim();
    };

    const resolveServiceTier = (value: unknown): CodexServiceTier | undefined => {
        if (value === null) {
            return undefined;
        }
        const parsed = CodexServiceTierSchema.safeParse(value);
        if (!parsed.success) {
            throw new Error('Invalid service tier');
        }
        return parsed.data;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown; modelReasoningEffort?: unknown; serviceTier?: unknown; collaborationMode?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.model !== undefined) {
            currentModel = resolveModel(config.model);
            sessionWrapperRef.current?.setModel(currentModel ?? null);
        }

        if (config.modelReasoningEffort !== undefined) {
            currentModelReasoningEffort = resolveModelReasoningEffort(config.modelReasoningEffort);
        }

        if (config.serviceTier !== undefined) {
            currentServiceTier = resolveServiceTier(config.serviceTier);
        }

        if (config.collaborationMode !== undefined) {
            currentCollaborationMode = resolveCollaborationMode(config.collaborationMode);
        }

        syncSessionMode();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                ...(config.model !== undefined ? { model: currentModel ?? null } : {}),
                modelReasoningEffort: currentModelReasoningEffort ?? null,
                serviceTier: currentServiceTier ?? null,
                collaborationMode: currentCollaborationMode
            }
        };
    });

    try {
        await loop({
            path: workingDirectory,
            startingMode,
            messageQueue,
            api,
            session,
            codexArgs: opts.codexArgs,
            codexCliOverrides,
            startedBy,
            permissionMode: currentPermissionMode,
            model: currentModel,
            modelReasoningEffort: currentModelReasoningEffort,
            serviceTier: currentServiceTier,
            collaborationMode: currentCollaborationMode,
            resumeSessionId: opts.resumeSessionId,
            deliveryOutcomes,
            onAmbiguousDelivery: () => lifecycle.markManagedUnhealthy('ambiguous-turn-delivery'),
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        lifecycle.markCrash(error);
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${formatFailureReason(localFailure.message)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
