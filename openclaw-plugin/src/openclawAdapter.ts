import { randomUUID } from 'node:crypto'
import type { PluginRuntime } from 'openclaw/plugin-sdk/runtime-store'
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry'
import { HapiCallbackClient } from './hapiClient'
import { adapterState } from './adapterState'
import { buildHapiSessionKey, deriveDeterministicSessionId, getDefaultAgentId, parseHapiSessionKey } from './sessionKeys'
import type {
    HapiCallbackEvent,
    OpenClawAdapterRuntime,
    PluginRuntimeApproveAction,
    PluginRuntimeDenyAction,
    PluginRuntimeSendMessageAction
} from './types'

const CONVERSATION_TITLE = 'OpenClaw'
const RUN_COMPLETION_SETTLE_MS = 50
const DEFAULT_PROVIDER = 'openai'
const DEFAULT_MODEL = 'gpt-5.4'
const STATE_CALLBACK_RETRY_ATTEMPTS = 3
const STATE_CALLBACK_RETRY_BASE_DELAY_MS = 1000

export class ConversationBusyError extends Error {
    constructor() {
        super('Conversation already has an active OpenClaw run')
    }
}

function createStateEvent(params: {
    namespace: string
    conversationId: string
    thinking: boolean
    lastError: string | null
}): Extract<HapiCallbackEvent, { type: 'state' }> {
    return {
        type: 'state',
        eventId: randomUUID(),
        occurredAt: Date.now(),
        namespace: params.namespace,
        conversationId: params.conversationId,
        connected: true,
        thinking: params.thinking,
        lastError: params.lastError
    }
}

function getStateNamespace(sessionKey: string, fallbackNamespace: string): string {
    return parseHapiSessionKey(sessionKey)?.namespace ?? fallbackNamespace
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function readPrimaryModelRef(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim()
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const primary = (value as Record<string, unknown>).primary
        return typeof primary === 'string' && primary.trim().length > 0 ? primary.trim() : null
    }

    return null
}

function resolvePreferredModelRef(config: Record<string, unknown>, agentId: string): { provider: string; model: string } {
    const agents = typeof config.agents === 'object' && config.agents !== null ? config.agents as Record<string, unknown> : null
    const list = Array.isArray(agents?.list) ? agents.list : []
    const matchedAgent = list.find((entry) => {
        return typeof entry === 'object'
            && entry !== null
            && (entry as Record<string, unknown>).id === agentId
    }) as Record<string, unknown> | undefined
    const defaults = typeof agents?.defaults === 'object' && agents.defaults !== null
        ? agents.defaults as Record<string, unknown>
        : null

    const rawRef = readPrimaryModelRef(matchedAgent?.model) ?? readPrimaryModelRef(defaults?.model)
    if (!rawRef) {
        return {
            provider: DEFAULT_PROVIDER,
            model: DEFAULT_MODEL
        }
    }

    const separatorIndex = rawRef.indexOf('/')
    if (separatorIndex <= 0 || separatorIndex === rawRef.length - 1) {
        return {
            provider: DEFAULT_PROVIDER,
            model: rawRef
        }
    }

    return {
        provider: rawRef.slice(0, separatorIndex).trim() || DEFAULT_PROVIDER,
        model: rawRef.slice(separatorIndex + 1).trim() || DEFAULT_MODEL
    }
}

async function ensureSessionBinding(runtime: PluginRuntime, sessionKey: string, agentId: string): Promise<{
    sessionId: string
    sessionFile: string
}> {
    const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId })
    const store = runtime.agent.session.loadSessionStore(storePath)
    const existing = store[sessionKey]
    const sessionId = existing?.sessionId?.trim() || deriveDeterministicSessionId(sessionKey)
    const sessionFile = runtime.agent.session.resolveSessionFilePath(sessionId, existing, { agentId })

    store[sessionKey] = {
        ...existing,
        sessionId,
        sessionFile,
        updatedAt: Date.now(),
        label: existing?.label ?? CONVERSATION_TITLE,
        displayName: existing?.displayName ?? CONVERSATION_TITLE
    }

    await runtime.agent.session.saveSessionStore(storePath, store, {
        activeSessionKey: sessionKey
    })

    return {
        sessionId,
        sessionFile
    }
}

export class RealOpenClawAdapter implements OpenClawAdapterRuntime {
    readonly supportsApprovals = false

    constructor(
        private readonly namespace: string,
        private readonly runtime: PluginRuntime,
        private readonly callbackClient: HapiCallbackClient,
        private readonly logger: PluginLogger,
        private readonly stateCallbackRetryBaseDelayMs: number = STATE_CALLBACK_RETRY_BASE_DELAY_MS
    ) {}

    async ensureDefaultConversation(externalUserKey: string): Promise<{ conversationId: string; title: string }> {
        return {
            conversationId: buildHapiSessionKey(this.namespace, externalUserKey, getDefaultAgentId()),
            title: CONVERSATION_TITLE
        }
    }

    isConversationBusy(conversationId: string): boolean {
        return adapterState.isRunActive(conversationId)
    }

    private async postStateWithRetry(input: {
        namespace: string
        conversationId: string
        thinking: boolean
        lastError: string | null
    }): Promise<void> {
        for (let attempt = 0; attempt < STATE_CALLBACK_RETRY_ATTEMPTS; attempt += 1) {
            try {
                await this.callbackClient.postEvent(createStateEvent(input))
                return
            } catch (error) {
                if (attempt === STATE_CALLBACK_RETRY_ATTEMPTS - 1) {
                    throw error
                }

                this.logger.warn(
                    `[${input.namespace}] hapi-openclaw state callback retry `
                    + `conversation=${input.conversationId} attempt=${attempt + 1}: `
                    + (error instanceof Error ? error.message : String(error))
                )
                await delay(this.stateCallbackRetryBaseDelayMs * (attempt + 1))
            }
        }
    }

    private async runReservedSendMessage(action: PluginRuntimeSendMessageAction): Promise<void> {
        const namespace = getStateNamespace(action.conversationId, this.namespace)
        let initialStatePosted = false
        this.logger.info(`[${namespace}] hapi-openclaw send-message start conversation=${action.conversationId}`)

        try {
            await this.postStateWithRetry({
                namespace,
                conversationId: action.conversationId,
                thinking: true,
                lastError: null
            })
            initialStatePosted = true

            const config = this.runtime.config.loadConfig() as Record<string, unknown>
            const agentId = parseHapiSessionKey(action.conversationId)?.agentId ?? getDefaultAgentId()
            const workspaceDir = (await this.runtime.agent.ensureAgentWorkspace({
                dir: this.runtime.agent.resolveAgentWorkspaceDir(config, agentId)
            })).dir
            const agentDir = this.runtime.agent.resolveAgentDir(config, agentId)
            const modelRef = resolvePreferredModelRef(config, agentId)

            const { sessionId, sessionFile } = await ensureSessionBinding(this.runtime, action.conversationId, agentId)
            this.logger.info(
                `[${namespace}] hapi-openclaw runEmbeddedPiAgent sessionId=${sessionId} agentId=${agentId} `
                + `provider=${modelRef.provider} model=${modelRef.model}`
            )

            const result = await this.runtime.agent.runEmbeddedPiAgent({
                sessionId,
                sessionKey: action.conversationId,
                sessionFile,
                workspaceDir,
                agentDir,
                config,
                agentId,
                prompt: action.text,
                provider: modelRef.provider,
                model: modelRef.model,
                timeoutMs: this.runtime.agent.resolveAgentTimeoutMs({ cfg: config }),
                runId: randomUUID(),
                trigger: 'user'
            })

            const runError = result.meta.error?.message?.trim() || null
            if (runError) {
                this.logger.warn(`[${namespace}] hapi-openclaw run failed conversation=${action.conversationId}: ${runError}`)
                await this.postStateWithRetry({
                    namespace,
                    conversationId: action.conversationId,
                    thinking: false,
                    lastError: runError
                })
                return
            }

            this.logger.info(
                `[${namespace}] hapi-openclaw run completed conversation=${action.conversationId}`
                + (result.meta.finalAssistantVisibleText ? ` finalText=${JSON.stringify(result.meta.finalAssistantVisibleText)}` : '')
            )

            if (result.meta.finalAssistantVisibleText) {
                await delay(RUN_COMPLETION_SETTLE_MS)
            }

            await this.postStateWithRetry({
                namespace,
                conversationId: action.conversationId,
                thinking: false,
                lastError: null
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'OpenClaw embedded run failed'
            this.logger.error(`[${namespace}] hapi-openclaw send-message error conversation=${action.conversationId}: ${message}`)

            if (initialStatePosted) {
                await this.postStateWithRetry({
                    namespace,
                    conversationId: action.conversationId,
                    thinking: false,
                    lastError: message
                })
            }

            throw error
        }
    }

    async sendMessage(action: PluginRuntimeSendMessageAction): Promise<void> {
        if (!adapterState.startRun(action.conversationId)) {
            throw new ConversationBusyError()
        }

        try {
            await this.runReservedSendMessage(action)
        } finally {
            adapterState.finishRun(action.conversationId)
        }
    }

    async sendMessageReserved(action: PluginRuntimeSendMessageAction): Promise<void> {
        await this.runReservedSendMessage(action)
    }

    async approve(_action: PluginRuntimeApproveAction): Promise<void> {
        throw new Error('Real OpenClaw approval bridge is not implemented yet')
    }

    async deny(_action: PluginRuntimeDenyAction): Promise<void> {
        throw new Error('Real OpenClaw approval bridge is not implemented yet')
    }
}
