export { commandParser, type ParseResult } from './parser'
export { commandRegistry, CommandRegistry } from './registry'
export { commandRouter, CommandRouter } from './router'
export { hapiCommands } from './hapi'
export type {
    AgentType,
    CommandCategory,
    CommandArg,
    CommandArgType,
    ParsedArgs,
    CommandContext,
    CommandResult,
    CommandDefinition,
    RouteResult,
    SendMessagePayload,
    MessageMeta
} from './types'

import { commandRegistry } from './registry'
import { hapiCommands } from './hapi'

export function initializeCommands(): void {
    commandRegistry.registerAll(hapiCommands)
}
