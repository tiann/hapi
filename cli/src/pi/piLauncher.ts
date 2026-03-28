import { randomUUID } from 'node:crypto'
import {
    createAgentSession,
    type AgentSession,
    type AgentSessionEvent
} from '@mariozechner/pi-coding-agent'
import { PiEventConverter } from './utils/piEventConverter'
import { logger } from '@/ui/logger'
import type { PiSession } from './session'
import type { PiEnhancedMode } from './piTypes'

type QueuedMessage = {
    message: string
    mode: PiEnhancedMode
    isolate: boolean
    hash: string
}

export class PiLauncher {
    private piSession: AgentSession | null = null
    private readonly eventConverter = new PiEventConverter()
    private shouldExit = false
    private abortController = new AbortController()
    private unsubscribe: (() => void) | null = null
    private currentModel: string | undefined
    private currentThinkingLevel: string | undefined

    constructor(private readonly session: PiSession) {}

    async run(): Promise<void> {
        const { session: piSession } = await createAgentSession({
            cwd: this.session.path
        })
        this.piSession = piSession

        this.unsubscribe = piSession.subscribe((event) => this.handlePiEvent(event))

        this.session.onSessionFound(piSession.sessionId)
        this.session.sendSessionEvent({ type: 'ready' })

        while (!this.shouldExit) {
            const batch = await this.session.queue.waitForMessagesAndGetAsString(
                this.abortController.signal
            )

            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    this.abortController = new AbortController()
                    continue
                }
                break
            }

            await this.processMessage(batch)
        }

        this.unsubscribe?.()
        this.piSession?.dispose()
    }

    private async processMessage(batch: QueuedMessage): Promise<void> {
        if (!this.piSession) return

        try {
            await this.applyModeChanges(batch.mode)

            this.session.onThinkingChange(true)
            await this.piSession.prompt(batch.message)

        } catch (error) {
            logger.debug('[Pi] Error processing message:', error)
            this.session.sendAgentMessage({
                type: 'message',
                message: error instanceof Error ? error.message : 'Unknown error',
                id: randomUUID()
            })
        } finally {
            this.session.onThinkingChange(false)
            this.eventConverter.reset()
            this.session.sendSessionEvent({ type: 'ready' })
        }
    }

    private async applyModeChanges(mode: PiEnhancedMode): Promise<void> {
        if (!this.piSession) return

        if (mode.thinkingLevel && mode.thinkingLevel !== this.currentThinkingLevel) {
            this.piSession.setThinkingLevel(mode.thinkingLevel)
            this.currentThinkingLevel = mode.thinkingLevel
        }

        if (mode.model && mode.model !== this.currentModel) {
            const model = this.findModel(mode.model)
            if (model) {
                await this.piSession.setModel(model)
                this.currentModel = mode.model
            }
        }
    }

    private findModel(modelString: string): ReturnType<AgentSession['modelRegistry']['getAll']>[number] | null {
        if (!this.piSession) return null

        const availableModels = this.piSession.modelRegistry.getAll()
        const [provider, modelId] = this.parseModelString(modelString)

        return availableModels.find(m =>
            m.provider === provider && m.id === modelId
        ) ?? null
    }

    private parseModelString(model: string): [string, string] {
        const slashIndex = model.indexOf('/')
        if (slashIndex > 0) {
            return [model.slice(0, slashIndex), model.slice(slashIndex + 1)]
        }
        return ['anthropic', model]
    }

    private handlePiEvent(event: AgentSessionEvent): void {
        const messages = this.eventConverter.convert(event)
        for (const msg of messages) {
            this.session.sendAgentMessage(msg)
        }
    }

    async abort(): Promise<void> {
        await this.piSession?.abort()
        this.abortController.abort()
        this.session.queue.reset()
        this.eventConverter.reset()
        this.abortController = new AbortController()
    }

    requestExit(): void {
        this.shouldExit = true
        this.abortController.abort()
    }
}
