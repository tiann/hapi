import type { ToolCallBlock } from '@/chat/types'

export type CodexCommandAction =
    | { type: 'read'; command: string; name: string; path: string }
    | { type: 'listFiles'; command: string; path: string | null }
    | { type: 'search'; command: string; query: string | null; path: string | null }
    | { type: 'unknown'; command: string }

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function parseAction(value: unknown): CodexCommandAction | null {
    if (!value || typeof value !== 'object') return null
    const action = value as Record<string, unknown>
    const type = asString(action.type)
    const command = asString(action.command)
    if (!type || !command) return null

    if (type === 'read') {
        const name = asString(action.name)
        const path = asString(action.path)
        return name && path ? { type, command, name, path } : null
    }
    if (type === 'listFiles') {
        return { type, command, path: asString(action.path) }
    }
    if (type === 'search') {
        return {
            type,
            command,
            query: asString(action.query),
            path: asString(action.path)
        }
    }
    if (type === 'unknown') {
        return { type, command }
    }
    return null
}

export function getCodexCommandActions(block: ToolCallBlock): CodexCommandAction[] {
    if (block.tool.name !== 'CodexBash' || !block.tool.input || typeof block.tool.input !== 'object') {
        return []
    }
    const input = block.tool.input as Record<string, unknown>
    const raw = input.command_actions ?? input.commandActions
    if (!Array.isArray(raw)) return []
    return raw.map(parseAction).filter((action): action is CodexCommandAction => action !== null)
}

export function isCodexExplorationTool(block: ToolCallBlock): boolean {
    const input = block.tool.input && typeof block.tool.input === 'object'
        ? block.tool.input as Record<string, unknown>
        : null
    const source = asString(input?.command_source ?? input?.commandSource)
    if (source?.toLowerCase() === 'usershell') return false

    const actions = getCodexCommandActions(block)
    return actions.length > 0 && actions.every((action) => (
        action.type === 'read' || action.type === 'listFiles' || action.type === 'search'
    ))
}
