import type { SyncEngine, Session } from '../sync/syncEngine'

export type AgentType = 'claude' | 'gemini' | 'codex'

export type CommandCategory = 'hapi' | 'agent' | 'native' | 'shortcut'

export type CommandArgType = 'string' | 'number' | 'boolean' | 'enum'

export interface CommandArg {
    name: string
    type: CommandArgType
    required: boolean
    default?: unknown
    choices?: string[]
    description: string
}

export interface ParsedArgs {
    positional: string[]
    flags: Record<string, string | boolean>
    raw: string
}

export interface CommandContext {
    chatId: string
    userId: string
    messageId: string
    sessionId?: string
    session?: Session
    agentType?: AgentType
    syncEngine: SyncEngine
    sendText: (text: string) => Promise<void>
    sendCard: (card: unknown) => Promise<void>
    getSessionForChat: (chatId: string) => string | undefined
    setSessionForChat: (chatId: string, sessionId: string) => void
    unbindChat: (chatId: string) => void
    getAllBindings: () => Map<string, string>
}

export interface CommandResult {
    success: boolean
    message?: string
    card?: unknown
    error?: string
}

export interface CommandDefinition {
    name: string
    aliases: string[]
    category: CommandCategory
    description: string
    usage: string
    examples?: string[]
    args: CommandArg[]
    agentTypes?: AgentType[]
    handler: (ctx: CommandContext, args: ParsedArgs) => Promise<CommandResult>
}

export interface RouteResult {
    type: 'hapi' | 'native' | 'passthrough' | 'unknown'
    command?: CommandDefinition
    args: ParsedArgs
    originalText: string
}

export interface SendMessagePayload {
    text: string
    localId?: string | null
    sentFrom?: 'telegram-bot' | 'webapp' | 'lark'
    messageType?: 'text' | 'command'
}

export interface MessageMeta {
    sentFrom?: 'telegram-bot' | 'webapp' | 'lark'
    messageType?: 'text' | 'command'
}
