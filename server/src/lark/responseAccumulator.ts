import { LarkClient } from './larkClient'
import { LarkCardBuilder, type InteractiveCard } from './cardBuilder'

type ToolStatus = 'running' | 'success' | 'error'

interface ToolState {
    name: string
    status: ToolStatus
    input?: unknown
    output?: string
    startTime: number
    endTime?: number
}

interface AccumulatorState {
    chatId: string
    messageId: string | null
    thinking: string | null
    textParts: string[]
    tools: Map<string, ToolState>
    toolOrder: string[]
    createdAt: number
    lastUpdatedAt: number
}

export class ResponseAccumulator {
    private state: AccumulatorState
    private larkClient: LarkClient
    private updateTimer: ReturnType<typeof setTimeout> | null = null
    private pendingUpdate = false
    private readonly debounceMs = 300

    constructor(chatId: string, larkClient: LarkClient) {
        this.larkClient = larkClient
        this.state = {
            chatId,
            messageId: null,
            thinking: null,
            textParts: [],
            tools: new Map(),
            toolOrder: [],
            createdAt: Date.now(),
            lastUpdatedAt: Date.now()
        }
    }

    get messageId(): string | null {
        return this.state.messageId
    }

    get isEmpty(): boolean {
        return !this.state.thinking && 
               this.state.textParts.length === 0 && 
               this.state.tools.size === 0
    }

    async initialize(): Promise<void> {
        if (this.state.messageId) return
        
        const card = this.buildCard()
        const messageId = await this.larkClient.sendInteractive({
            receiveIdType: 'chat_id',
            receiveId: this.state.chatId,
            card
        })
        if (messageId) {
            this.state.messageId = messageId
            console.log(`[ResponseAccumulator] Initialized card: ${messageId}`)
        }
    }

    addThinking(content: string): void {
        this.state.thinking = content
        this.scheduleUpdate()
    }

    addText(content: string): void {
        if (content.trim()) {
            this.state.textParts.push(content)
            this.scheduleUpdate()
        }
    }

    startTool(toolId: string, name: string, input?: unknown): void {
        this.state.tools.set(toolId, {
            name,
            status: 'running',
            input,
            startTime: Date.now()
        })
        if (!this.state.toolOrder.includes(toolId)) {
            this.state.toolOrder.push(toolId)
        }
        this.scheduleUpdate()
    }

    completeTool(toolId: string, output: string, isError = false): void {
        const tool = this.state.tools.get(toolId)
        if (tool) {
            tool.status = isError ? 'error' : 'success'
            tool.output = output
            tool.endTime = Date.now()
            this.scheduleUpdate()
        }
    }

    private scheduleUpdate(): void {
        this.pendingUpdate = true
        if (this.updateTimer) {
            return
        }
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null
            if (this.pendingUpdate) {
                this.pendingUpdate = false
                this.flushUpdate().catch(err => {
                    console.error('[ResponseAccumulator] Failed to flush update:', err)
                })
            }
        }, this.debounceMs)
    }

    async flushUpdate(): Promise<void> {
        if (this.isEmpty) {
            return
        }

        const card = this.buildCard()

        if (!this.state.messageId) {
            const messageId = await this.larkClient.sendInteractive({
                receiveIdType: 'chat_id',
                receiveId: this.state.chatId,
                card
            })
            if (messageId) {
                this.state.messageId = messageId
                console.log(`[ResponseAccumulator] Created card message: ${messageId}`)
            }
        } else {
            await this.larkClient.patchMessage({
                openMessageId: this.state.messageId,
                card
            })
            console.log(`[ResponseAccumulator] Updated card message: ${this.state.messageId}`)
        }

        this.state.lastUpdatedAt = Date.now()
    }

    async finalize(): Promise<void> {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer)
            this.updateTimer = null
        }
        this.pendingUpdate = false
        await this.flushUpdate()
    }

    private buildCard(): InteractiveCard {
        const builder = new LarkCardBuilder()
        
        const hasRunningTools = Array.from(this.state.tools.values()).some(t => t.status === 'running')
        const hasErrors = Array.from(this.state.tools.values()).some(t => t.status === 'error')
        
        let headerTitle = '🤖 Response'
        let headerColor: 'blue' | 'green' | 'red' | 'wathet' = 'blue'
        
        if (hasRunningTools) {
            headerTitle = '🔄 Processing...'
            headerColor = 'wathet'
        } else if (hasErrors) {
            headerTitle = '⚠️ Completed with errors'
            headerColor = 'red'
        } else if (this.state.tools.size > 0) {
            headerTitle = '✅ Completed'
            headerColor = 'green'
        }

        const elapsed = Math.round((Date.now() - this.state.createdAt) / 1000)
        builder.setHeader(headerTitle, `${elapsed}s`, headerColor)

        if (this.state.thinking) {
            builder.addCollapsible('💭 Thinking', this.state.thinking)
        }

        if (this.state.textParts.length > 0) {
            const combinedText = this.state.textParts.join('\n\n')
            builder.addMarkdown(combinedText)
        }

        if (this.state.tools.size > 0) {
            builder.addDivider()
            
            for (const toolId of this.state.toolOrder) {
                const tool = this.state.tools.get(toolId)
                if (!tool) continue

                const statusEmoji = {
                    running: '🔄',
                    success: '✅',
                    error: '❌'
                }[tool.status]

                const duration = tool.endTime 
                    ? `${((tool.endTime - tool.startTime) / 1000).toFixed(1)}s`
                    : 'running...'

                builder.addMarkdown(`${statusEmoji} **${tool.name}** (${duration})`)

                if (tool.input) {
                    const inputStr = typeof tool.input === 'string'
                        ? tool.input
                        : this.formatToolInput(tool.name, tool.input)
                    if (inputStr) {
                        builder.addCollapsible('Input', inputStr)
                    }
                }

                if (tool.output) {
                    const truncated = tool.output.length > 2000
                        ? tool.output.slice(0, 2000) + '\n... (truncated)'
                        : tool.output
                    builder.addCollapsible(tool.status === 'error' ? 'Error' : 'Output', `\`\`\`\n${truncated}\n\`\`\``)
                }
            }
        }

        return builder.build()
    }

    private formatToolInput(toolName: string, input: unknown): string {
        const obj = input as Record<string, unknown>
        
        switch (toolName) {
            case 'Read':
            case 'Glob':
            case 'Grep':
            case 'LS':
                return `📄 \`${obj.file_path ?? obj.path ?? obj.pattern ?? ''}\``
            
            case 'Write':
                return `📝 \`${obj.file_path ?? ''}\``
            
            case 'Edit':
                return `✏️ \`${obj.file_path ?? ''}\``
            
            case 'Bash':
                return `\`\`\`bash\n${obj.command ?? ''}\n\`\`\``
            
            case 'Task':
                return `📋 ${obj.description ?? ''}`
            
            default:
                return `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
        }
    }
}

export class ResponseAccumulatorManager {
    private accumulators: Map<string, ResponseAccumulator> = new Map()
    private larkClient: LarkClient
    private readonly timeoutMs = 5 * 60 * 1000

    constructor(larkClient: LarkClient) {
        this.larkClient = larkClient
    }

    getOrCreate(chatId: string, sessionId: string): ResponseAccumulator {
        const key = `${chatId}:${sessionId}`
        let acc = this.accumulators.get(key)
        
        if (!acc) {
            acc = new ResponseAccumulator(chatId, this.larkClient)
            this.accumulators.set(key, acc)
            
            setTimeout(() => {
                this.finalize(chatId, sessionId)
            }, this.timeoutMs)
        }
        
        return acc
    }

    async createNew(chatId: string, sessionId: string): Promise<ResponseAccumulator> {
        const key = `${chatId}:${sessionId}`
        
        const existing = this.accumulators.get(key)
        if (existing) {
            await existing.finalize()
        }
        
        const acc = new ResponseAccumulator(chatId, this.larkClient)
        this.accumulators.set(key, acc)
        
        await acc.initialize()
        
        setTimeout(() => {
            this.finalize(chatId, sessionId)
        }, this.timeoutMs)
        
        return acc
    }

    async finalize(chatId: string, sessionId: string): Promise<void> {
        const key = `${chatId}:${sessionId}`
        const acc = this.accumulators.get(key)
        if (acc) {
            await acc.finalize()
            this.accumulators.delete(key)
            console.log(`[AccumulatorManager] Finalized accumulator for ${key}`)
        }
    }

    async finalizeAll(): Promise<void> {
        const promises = Array.from(this.accumulators.values()).map(acc => acc.finalize())
        await Promise.all(promises)
        this.accumulators.clear()
    }
}
